# 备份恢复中心增强：volume/compose/site 真实备份与恢复

**日期**：2026-08-12

## 背景与目标

备份恢复中心第一阶段（已提交 `299d752`）已实现 database 类型的真实快照备份/恢复，而 volume／compose／site 三种类型目前仅为占位负载（skeleton），恢复返回"暂不支持"。

本设计将三种类型提升为真实备份与恢复，采用业界（1Panel、Docker 官方）一致的做法：
- **volume**：临时容器 + tar 打包/解包挂载的卷
- **compose**：备份项目目录，恢复重建目录解包（不自动启停容器）
- **site**：备份 nginx conf + 证书文件，恢复放回对应位置（不自动重启反代容器）

遵循项目约束：零第三方运行时依赖、不自动触发破坏性容器操作、路径穿越防护、函数级注释。

## 架构

在 `server/src/backup/manager.ts` 内扩展（不新增服务层文件，保持备份管理集中在 manager）：

- 新增内部工具（模块级，不导出）：
  - `packDirToTar(sourceDir, targetTar)`：目录 → tar.gz
  - `unpackTarToDir(tarPath, targetDir)`：tar.gz → 目录
  - `ensureAlpineImage()` + `runVolumeTar(kind, volume, ...)`：临时容器执行 tar（用于 volume）
- 在 `createBackup` 中按 kind 分发：
  - `database` → `snapshotDatabase`（现状）
  - `volume` → 临时容器打包卷内数据到 `backup.tar.gz`
  - `compose` → 打包 COMPOSE_ROOT 下 source 对应项目目录
  - `site` → 打包 nginx conf + 证书文件
- 在 `restoreBackup` 中按 kind 分发真实恢复：
  - `database` → `importDatabaseBuffer`（现状）
  - `volume` → 临时容器解包回卷（还原前提示会覆盖）
  - `compose` → 重建项目目录并解包（不启停）
  - `site` → 放回 conf + 证书（不重启反代）

## 组件与文件改动

| 文件 | 改动 |
|------|------|
| `server/src/backup/manager.ts` | 扩展 createBackup／restoreBackup 分发与内部工具 |
| `server/src/backup/manager.ts` | 依赖 `server/src/routes/compose.ts` 的 `COMPOSE_ROOT`、`server/src/routes/sites.ts` 的 nginx 目录/证书约定 |
| `web/src/pages/backups.tsx` | 恢复确认文案按 kind 区分；恢复按钮禁用条件改为"filePath 缺失"而非"exists=false" |
| `web/src/pages/backups.less` | 如需要补充状态样式 |

**关键依赖约定（需与既有代码对齐）**：
- Compose 根目录：`server/src/routes/compose.ts` 中 `COMPOSE_ROOT = env.COMPOSE_ROOT || path.join(os.tmpdir(), 'docker-compose-projects')`，项目的 `source` 字段存项目目录名。
- nginx 配置目录：`server/src/routes/sites.ts` 中 `nginxDir() = path.join(__dirname,'..','..','..','data','nginx')`；`cert_path` 存证书文件绝对路径，私钥由 `cert_path` 去掉 `.crt/.pem` 后缀推导。
- 由于 `manager.ts` 需读取 Compose 根目录与 nginx 目录，统一从 `storage.ts` 的 `DATA_DIR` 派生，避免跨路由文件的循环依赖：将 nginx/backup 等数据子目录定义为 `DATA_DIR` 下的固定子目录，供 manager 与 routes 共用。

## 数据流

### volume 备份
```
createBackup({kind:'volume', source: volumeName})
  → backupDir/backup.tar.gz 生成
  → 创建临时容器: -v {volume}:/data -v {dir}:/backup alpine tar czf /backup/backup.tar.gz -C /data .
  → --rm 自清理
  → writeBackup 记录
```

### volume 恢复
```
restoreBackup(id) kind=volume
  → 目标卷不存在则创建
  → 创建临时容器挂载卷: tar xzf /backup/backup.tar.gz -C /data
  → --rm 自清理
  → 更新状态 ready/failed
```

### compose 备份 / 恢复
```
createBackup  → tar czf src 项目目录 → record
restoreBackup → mkdir -p 项目目录 + 解包 → record（不调 compose up/down）
```

### site 备份 / 恢复
```
createBackup  → 打包 nginx conf.d/{domain}.conf + 证书文件 → record
restoreBackup → 放回 conf/证书 → record（不重启反代容器）
```

## 错误处理

- 所有路径拼接沿用 `resolveSafePath` / `isSafeId` / `isSafeKind` 防护，杜绝穿越。
- volume 依赖 Docker；`alpine` 镜像缺失时尝试 `pull`，失败则报错并标记 `failed`（不静默）。
- 临时容器执行失败（创建/start/exec 退出码非零）→ 标记 `failed` 并返回结构化错误。
- 恢复对不存在目标（卷/项目目录/站点）按类型给出明确 message，绝不静默改数据。
- 备份/恢复均为同步实现但保留 `async` 签名，与第一阶段一致的 `RestoreResult { ok, supported, kind, id, message }` 结构沿用。

## 测试

- 后端 `cd server && npx tsc --noEmit` 通过。
- 前端 `cd web && npx tsc -b` 通过（改到 backups.tsx 后）。
- 端到端（真实 API，admin/admin888）：
  1. 创建 volume 备份 → 列表 exists 为 true → 下载文件头为 gzip（`1f 8b`）→ 恢复 → ok:true
  2. 创建 compose 备份（指向真实项目目录）→ 恢复 → 目录存在且配置还原
  3. 创建 site 备份（指向真实站点）→ 恢复 → conf 放回
- volume 恢复为破坏性操作，端到端验证时对**临时测试卷**执行，不对用户真实卷操作。

## 范围外（明确不做）

- 不自动执行 `docker compose up/down`（compose/site 恢复仅还原文件，由用户决定启停）。
- volume 恢复不自动停止业务容器（仅提示会覆盖；由用户在界面前先自行管理容器）。
- 不做加密备份、不做增量备份、不做保留策略（留给后续阶段）。
