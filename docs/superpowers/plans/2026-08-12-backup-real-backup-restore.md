# 备份恢复中心增强：volume/compose/site 真实备份与恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将备份恢复中心中 volume／compose／site 三种类型从占位负载升级为真实备份与恢复，采用临时容器+tar（volume）、目录打包（compose）、nginx 配置+证书打包（site）方案，恢复均不自动触发布破坏性的容器启停。

**Architecture:** 在 `server/src/backup/manager.ts` 内扩展 createBackup／restoreBackup 的 kind 分发与内部工具。volume 通过 dockerode 创建一次性 `alpine` 容器挂载目标卷执行 tar 打包/解包；compose 通过打包/解包 `COMPOSE_ROOT` 下的项目目录；site 通过打包/解包 `data/nginx` 下的站点 conf 与证书文件。路径统一从 `DATA_DIR` 派生避免跨文件循环依赖。前端恢复确认文案按 kind 区分。

**Tech Stack:** Node.js, Express, TypeScript, SQLite (`node:sqlite`), Dockerode, React.

## Global Constraints

- Operating system: Windows（Docker Desktop + WSL2 后端）。
- 零第三方运行时依赖；dockerode 已有。
- 后端源码在 `server/src`，前端在 `web/src`。
- 恢复一律不自动执行 `docker compose up/down`、不自动停止/启动业务容器（由用户在界面前自行管理）。
- 路径防护沿用 `resolveSafePath` / `isSafeId` / `isSafeKind`，杜绝 path traversal。
- volume 备份/恢复依赖 Docker 与 `alpine` 镜像；镜像缺失时尝试 pull，失败则报错标记 `failed`，不静默。
- 恢复失败不触碰用户数据（保持原样），返回结构化 `RestoreResult { ok, supported, kind, id, message }`。
- 后端 `cd server && npx tsc --noEmit` 与前端 `cd web && npx tsc -b` 必须通过。
- 生成代码需带函数级注释。
- 不提交 `data/`、`.superpowers/`；不写无关 .md。
- volume 恢复端到端验证只对临时测试卷执行，不对用户真实卷操作。

---

### Task 1: manager 路径基础设施与内部 tar 工具

**Files:**
- Modify: `server/src/backup/manager.ts`（新增内部工具，不导出）

**Interfaces:**
- Consumes: `DATA_DIR` from `../storage`（已导出）、`getDockerClient` from `../docker/client`（已导出，返回 Dockerode）。
- Produces: 模块级常量 `COMPOSE_ROOT`、`NGINX_DIR`（均从 `DATA_DIR`/`os.tmpdir` 派生），以及内部函数 `packDirToTar(srcDir, tarPath)`、`unpackTarToDir(tarPath, destDir)`、`ensureAlpineImage(docker)`、`runVolumeTar(opts)`。后续 Task 2/3/4 复用。

- [ ] **Step 1: 新增 imports 与路径常量**

在 `server/src/backup/manager.ts` 顶部，现有 import 之后新增：

```ts
import os from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { getDockerClient } from '../docker/client';

const execAsync = promisify(execCb);

// Compose 项目根目录（与 server/src/routes/compose.ts 保持一致，避免循环依赖）
const COMPOSE_ROOT = process.env.COMPOSE_ROOT
  ? process.env.COMPOSE_ROOT
  : path.join(os.tmpdir(), 'docker-compose-projects');

// nginx 配置根目录（等同 server/src/routes/sites.ts 中 data/nginx）
const NGINX_DIR = path.join(DATA_DIR, 'nginx');
```

- [ ] **Step 2: 新增内部 tar 工具函数**

在 `payloadName` 之后新增（模块级、不导出）：

```ts
/**
 * 将目录打包为 tar.gz
 * @param srcDir 源目录（必须存在）
 * @param tarPath 目标 tar.gz 路径
 */
async function packDirToTar(srcDir: string, tarPath: string): Promise<void> {
  if (!fs.existsSync(srcDir)) throw new Error(`源目录不存在: ${srcDir}`);
  fs.mkdirSync(path.dirname(tarPath), { recursive: true });
  const escapedSrc = srcDir.replace(/"/g, '\\"');
  const escapedTar = tarPath.replace(/"/g, '\\"');
  // Windows 下使用系统 tar（Win10+ 自带 bsdtar）；cmd 内参数用引号包裹
  const cmd = `tar -czf "${escapedTar}" -C "${escapedSrc}" .`;
  try {
    await execAsync(cmd, { shell: 'cmd.exe', maxBuffer: 1024 * 1024 * 50 });
  } catch (err: any) {
    throw new Error(`目录打包失败: ${err?.stderr || err?.message || 'tar 执行错误'}`);
  }
}

/**
 * 将 tar.gz 解包到目标目录（不存在则创建）
 * @param tarPath 源 tar.gz 路径
 * @param destDir 目标目录
 */
async function unpackTarToDir(tarPath: string, destDir: string): Promise<void> {
  if (!fs.existsSync(tarPath)) throw new Error(`备份文件不存在: ${tarPath}`);
  fs.mkdirSync(destDir, { recursive: true });
  const escapedTar = tarPath.replace(/"/g, '\\"');
  const escapedDest = destDir.replace(/"/g, '\\"');
  const cmd = `tar -xzf "${escapedTar}" -C "${escapedDest}"`;
  try {
    await execAsync(cmd, { shell: 'cmd.exe', maxBuffer: 1024 * 1024 * 50 });
  } catch (err: any) {
    throw new Error(`解包失败: ${err?.stderr || err?.message || 'tar 执行错误'}`);
  }
}
```

注意：`packDirToTar` / `unpackTarToDir` 均为 `async`，调用处（Task 3/4 的 createBackup 与 restoreBackup）需 `await`；`createBackup`/`restoreBackup` 本身已是 async 满足要求。

- [ ] **Step 3: 运行后端类型检查**

Run: `cd server && npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add server/src/backup/manager.ts
git commit -m "feat(backup): add path constants and tar helpers for compose/site/volume backup"
```

---

### Task 2: volume 真实备份与恢复

**Files:**
- Modify: `server/src/backup/manager.ts`

**Interfaces:**
- Consumes: `ensureAlpineImage`、`getDockerClient`、`DATA_DIR`（Task 1 产物与既有导出）、`backupDir`、`payloadName`、`writeBackup`、`getBackup`、`updateBackupStatus`（既有）。
- Produces: `createBackup` 中 `kind === 'volume'` 走真实打包；`restoreBackup` 中 `kind === 'volume'` 走真实解包回卷。

- [ ] **Step 1: 新增 volume 临时容器 tar helper**

在 Task 1 工具之后新增（不导出）：

```ts
/** 用于临时命名的容器名前缀，避免与业务容器冲突 */
const TMP_CONTAINER_PREFIX = 'dm-backup-tmp-';

/**
 * 同步保证 alpine 镜像存在（不存在则 pull）
 * @param docker Dockerode 实例
 */
export async function ensureAlpineImage(docker: Dockerode): Promise<void> {
  const images = await docker.listImages();
  const hasAlpine = images.some((i) =>
    (i.RepoTags || []).some((t) => t.split(':')[0].toLowerCase() === 'alpine'),
  );
  if (!hasAlpine) {
    await pullImage(docker, 'alpine:latest');
  }
}

/**
 * 拉取指定镜像
 * @param docker Dockerode 实例
 * @param ref 镜像引用，如 alpine:latest
 */
async function pullImage(docker: Dockerode, ref: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(ref, (err: any, stream: any) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (perr: any) => (perr ? reject(perr) : resolve()), () => {});
    });
  });
}

/**
 * 通过一次性 alpine 容器对卷执行 tar 命令（打包或解包）
 * @param docker Dockerode 实例
 * @param volume 卷名
 * @param backupDirAbs 挂载进容器 /backup 的宿主机目录
 * @param direction 'pack' 打包 | 'unpack' 解包
 */
async function runVolumeTar(docker: Dockerode, volume: string, backupDirAbs: string, direction: 'pack' | 'unpack'): Promise<void> {
  await ensureAlpineImage(docker);
  const tarName = 'backup.tar.gz';
  const cmd =
    direction === 'pack'
      ? `sh -c "tar -czf /backup/${tarName} -C /data ."`
      : `sh -c "tar -xzf /backup/${tarName} -C /data"`;
  const container = await docker.createContainer({
    Image: 'alpine:latest',
    Cmd: ['/bin/sh', '-c', cmd],
    HostConfig: {
      Binds: [`${volume}:/data`, `${backupDirAbs}:/backup`],
      AutoRemove: true,
    },
  });
  await container.start();
  // 等待容器退出，获取退出码
  await container.wait();
}
```

注：`container.wait()` 返回 Promise<{StatusCode:number}>，若 StatusCode !== 0 需抛错：

```ts
const res = await container.wait();
if (res.StatusCode !== 0) {
  throw new Error(`卷备份容器退出码非 0: ${res.StatusCode}`);
}
```

- [ ] **Step 2: 在 createBackup 中接入 volume 真实备份**

将 `createBackup` 中现有分支：

```ts
  const filePath = path.join(dir, payloadName(kind));
  if (kind === 'database') {
    snapshotDatabase(filePath);
  } else {
    writePlaceholderPayload(filePath, kind, input.source);
  }
```

改为：

```ts
  const filePath = path.join(dir, payloadName(kind));
  if (kind === 'database') {
    snapshotDatabase(filePath);
  } else if (kind === 'volume') {
    const docker = await getDockerClient();
    await runVolumeTar(docker, input.source, dir, 'pack');
  } else {
    writePlaceholderPayload(filePath, kind, input.source);
  }
```

`createBackup` 已是 `async`，可直接 `await`。

- [ ] **Step 3: 在 restoreBackup 中接入 volume 真实恢复**

将 `restoreBackup` 中 `if (kind === 'database') {...}` 之后、`// volume / compose / site` 占位注释之前，新增：

```ts
    if (kind === 'volume') {
      if (!fs.existsSync(filePath)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '备份负载文件缺失，无法恢复' };
      }
      const docker = await getDockerClient();
      // 卷不存在则先创建
      const vols = await docker.listVolumes();
      const exists = (vols.Volumes || []).some((v) => v && v.Name === manifest.source);
      if (!exists) {
        await docker.createVolume({ Name: manifest.source });
      }
      // 挂载宿主机备份目录镜像 tmpdir 的父级给容器 /backup 使用
      const hostBackupParent = path.dirname(dir);
      await runVolumeTar(docker, manifest.source, hostBackupParent, 'unpack');
      updateBackupStatus(id, 'ready');
      return { ok: true, supported: true, kind, id, message: '数据卷已恢复' };
    }
```

**注意**：`runVolumeTar` 解包时把整个 `backupDirAbs` 挂载为 `/backup`，容器内应指向 `dir` 下的 `backup.tar.gz`。为保持一致，恢复时调用方传 `path.join(dir,'..')` 存在语义偏差。**统一规则**：`runVolumeTar` 的第三个参数始终是 `path.dirname(dir)`（即 `<backups>/<kind>` 目录），容器内 `/backup/backup.tar.gz` 实际对应 `<dir>/backup.tar.gz`，因为 `dir` 是 `<backups>/<kind>/<id>`，其父级挂载后子路径 `<id>/backup.tar.gz` 与容器内 `/backup` 不匹配。

**修正方案（必须采用）**：改为把 `dir` 本身挂载为 `/backup`，容器内 tar 目标改为 `/backup/backup.tar.gz`（即 `dir` 下）。因此 `runVolumeTar` 的第三参直接传 `dir`，且 pack/unpack 的 tar 名固定为 `payloadName('volume')`（即 `backup.tar.gz`）。调用处：

- 备份：`await runVolumeTar(docker, input.source, dir, 'pack');`
- 恢复：`await runVolumeTar(docker, manifest.source, dir, 'unpack');`

容器内命令保持 `/backup/backup.tar.gz` 不变（`dir` 挂载为 `/backup`，则 `dir/backup.tar.gz` 即 `/backup/backup.tar.gz`）。

- [ ] **Step 4: 运行后端类型检查并提交**

Run: `cd server && npx tsc --noEmit`
Expected: 通过。

```bash
git add server/src/backup/manager.ts
git commit -m "feat(backup): real docker volume backup and restore via temp alpine container"
```

---

### Task 3: compose 真实备份与恢复

**Files:**
- Modify: `server/src/backup/manager.ts`

**Interfaces:**
- Consumes: `COMPOSE_ROOT`（Task 1）、`packDirToTar`/`unpackTarToDir`（Task 1）、`backupDir`、`payloadName`、`writeBackup`、`getBackup`、`updateBackupStatus`。
- Produces: `createBackup` 的 `kind==='compose'` 真实打包项目目录；`restoreBackup` 的 `kind==='compose'` 重建目录并解包（不启停）。

- [ ] **Step 1: createBackup 接入 compose**

将 `createBackup` 分支改为：

```ts
  const filePath = path.join(dir, payloadName(kind));
  if (kind === 'database') {
    snapshotDatabase(filePath);
  } else if (kind === 'volume') {
    const docker = await getDockerClient();
    await runVolumeTar(docker, input.source, dir, 'pack');
  } else if (kind === 'compose') {
    const src = path.join(COMPOSE_ROOT, input.source);
    await packDirToTar(src, filePath);
  } else {
    writePlaceholderPayload(filePath, kind, input.source);
  }
```

- [ ] **Step 2: restoreBackup 接入 compose**

在 `if (kind === 'volume') {...}` 块之后新增：

```ts
    if (kind === 'compose') {
      if (!fs.existsSync(filePath)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '备份负载文件缺失，无法恢复' };
      }
      const dest = path.join(COMPOSE_ROOT, manifest.source);
      await unpackTarToDir(filePath, dest);
      updateBackupStatus(id, 'ready');
      return { ok: true, supported: true, kind, id, message: 'Compose 配置已恢复（未自动启停容器）' };
    }
```

**安全**：`manifest.source` 为 compose 项目目录名，需先经 `isSafeId` 校验（恢复入口已有 `isSafeId(id)`，但 `manifest.source` 是用户名生成，需额外防护）。在解包前追加：

```ts
      if (!/^[a-zA-Z0-9._-]+$/.test(manifest.source)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '非法的 Compose 项目名' };
      }
```

- [ ] **Step 3: 运行后端类型检查并提交**

Run: `cd server && npx tsc --noEmit`
Expected: 通过。

```bash
git add server/src/backup/manager.ts
git commit -m "feat(backup): real compose project backup and restore"
```

---

### Task 4: site 真实备份与恢复 + 前端文案

**Files:**
- Modify: `server/src/backup/manager.ts`
- Modify: `web/src/pages/backups.tsx`

**Interfaces:**
- Consumes: `NGINX_DIR`（Task 1）、`packDirToTar`/`unpackTarToDir`（Task 1）、manifest 各 helper。
- Produces: `createBackup` 的 `kind==='site'` 打包 `data/nginx/conf.d/<domain>.conf` 及证书；`restoreBackup` 的 `kind==='site'` 放回。

- [ ] **Step 1: 后端 createBackup 接入 site**

将 `createBackup` 分支补充 `site` 处理：

```ts
  const filePath = path.join(dir, payloadName(kind));
  if (kind === 'database') {
    snapshotDatabase(filePath);
  } else if (kind === 'volume') {
    const docker = await getDockerClient();
    await runVolumeTar(docker, input.source, dir, 'pack');
  } else if (kind === 'compose') {
    const src = path.join(COMPOSE_ROOT, input.source);
    await packDirToTar(src, filePath);
  } else if (kind === 'site') {
    // 站点数据分布在 nginx conf 目录与证书路径，先收集到临时 stage 目录再打包
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(path.join(stage, 'conf.d'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'certs'), { recursive: true });
    const domain = input.source.replace(/\./g, '_'); // 安全化目录名
    const confSrc = path.join(NGINX_DIR, 'conf.d', `${domain}.conf`);
    if (fs.existsSync(confSrc)) fs.copyFileSync(confSrc, path.join(stage, 'conf.d', `${domain}.conf`));
    // 从 sites 表读取 cert_path 并复制（本步在 manager 内读取 domains 文件，见 Step 2）
    await packDirToTar(stage, filePath);
  } else {
    writePlaceholderPayload(filePath, kind, input.source);
  }
```

**注意**：site 的证书路径来自 `sites` 表，`manager.ts` 不应依赖 `sites.ts` 路由。改用 SQL 直查 `sites` 表（manager 已用 `getDb()`）：

```ts
function listSiteRows() {
  return getDb().prepare('SELECT domain, cert_path FROM sites').all() as { domain: string; cert_path: string | null }[];
}
```

在 site 分支内通过 `listSiteRows()` 找到 `domain === input.source` 的行，读取其 `cert_path` 与推导的私钥路径，复制进 `stage/certs`：

```ts
      const rows = listSiteRows();
      const site = rows.find((r) => r.domain === input.source);
      if (site && site.cert_path) {
        const keyPath = site.cert_path.replace(/\.(crt|pem)$/i, '.key');
        if (fs.existsSync(site.cert_path)) fs.copyFileSync(site.cert_path, path.join(stage, 'certs', path.basename(site.cert_path)));
        if (fs.existsSync(keyPath)) fs.copyFileSync(keyPath, path.join(stage, 'certs', path.basename(keyPath)));
      }
```

- [ ] **Step 2: 后端 restoreBackup 接入 site**

在 `if (kind === 'compose') {...}` 之后新增：

```ts
    if (kind === 'site') {
      if (!fs.existsSync(filePath)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '备份负载文件缺失，无法恢复' };
      }
      const stage = path.join(dir, 'stage');
      await unpackTarToDir(filePath, stage);
      const domainSafe = manifest.source.replace(/\./g, '_');
      // 还原 conf
      const confStage = path.join(stage, 'conf.d', `${domainSafe}.conf`);
      const confDest = path.join(NGINX_DIR, 'conf.d', `${domainSafe}.conf`);
      fs.mkdirSync(path.dirname(confDest), { recursive: true });
      if (fs.existsSync(confStage)) fs.copyFileSync(confStage, confDest);
      // 还原证书目录
      const certsStage = path.join(stage, 'certs');
      if (fs.existsSync(certsStage)) {
        const certsDest = path.join(NGINX_DIR, 'certs');
        fs.mkdirSync(certsDest, { recursive: true });
        for (const f of fs.readdirSync(certsStage)) {
          fs.copyFileSync(path.join(certsStage, f), path.join(certsDest, f));
        }
      }
      updateBackupStatus(id, 'ready');
      return { ok: true, supported: true, kind, id, message: '站点配置已恢复（未自动重启反代容器）' };
    }
```

**安全**：`manifest.source` 为站点域名，恢复入口经 `isSafeId(id)`，但 source 需校验：

```ts
      if (!/^[a-zA-Z0-9.-]+$/.test(manifest.source)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '非法的站点域名' };
      }
```

- [ ] **Step 3: 前端恢复确认文案按 kind 区分**

在 `web/src/pages/backups.tsx` 中 `handleRestore` 的 ConfirmDialog message（现有代码）改为按类型拼接：

```tsx
const restoreMessage = (item: BackupListItem) => {
  const base = '恢复将覆盖现有数据，确认继续？';
  if (item.kind === 'volume') return `${base}（数据卷「${item.source}」的内容将被备份内容覆盖）`;
  if (item.kind === 'compose') return `将还原 Compose 项目「${item.source}」的配置文件（不会自动启停容器）。确认？`;
  if (item.kind === 'site') return `将还原站点「${item.source}」的 nginx 配置与证书（不会自动重启反代容器）。确认？`;
  return base;
};
```

并将 ConfirmDialog 的 `message` 改用 `restoreMessage(restoreTarget)`（在 `restoreTarget` 非空时）。

另外，下载/恢复按钮的 `disabled={!b.exists}` 保留（filePath 缺失才禁用），符合现状。

- [ ] **Step 4: 前后端类型检查并提交**

Run: `cd server && npx tsc --noEmit` 且 `cd web && npx tsc -b`
Expected: 均通过。

```bash
git add server/src/backup/manager.ts web/src/pages/backups.tsx
git commit -m "feat(backup): real site nginx+cert backup/restore and kind-specific restore messages"
```

---

### Task 5: 端到端验证与汇总提交

**Files:**
- Modify: 按需修复 Task 2/3/4 发现的问题。

**Interfaces:**
- Consumes: 全部实现（Task 1-4）。

- [ ] **Step 1: 起服务**

确保后端 `npm run dev:server`（9528）、前端 `npm run dev:web`（9526）运行中；若未运行则启动。

- [ ] **Step 2: 冒烟——compose 备份/恢复**

- 若 `COMPOSE_ROOT` 下已有项目目录，则取其名作为 `source` 创建 compose 备份；若无，创建 `data` 下临时目录模拟（见注意事项）。
- `POST /api/backups {kind:'compose', name:'c1', source:'<项目名>'}` → 记录 `fileSize>0`。
- `GET /api/backups` → `exists:true`。
- `POST /api/backups/:id/restore` → `result.supported===true && result.ok===true`。

- [ ] **Step 3: 冒烟——volume 备份/恢复（临时卷）**

- `docker volume create dm-test-vol`（PowerShell：`& docker volume create dm-test-vol`）。
- 向卷写入一个测试文件：`& docker run --rm -v dm-test-vol:/data alpine sh -c "echo hello > /data/x.txt"`。
- `POST /api/backups {kind:'volume', name:'v1', source:'dm-test-vol'}` → 成功。
- `GET /api/backups/:id/download` → 响应体前两字节为 gzip 魔数 `1f 8b`。
- `POST /api/backups/:id/restore` → `result.ok===true`。
- 校验：`& docker run --rm -v dm-test-vol:/data alpine cat /data/x.txt` 输出 `hello`。
- **清理**：`& docker volume rm dm-test-vol`。

- [ ] **Step 4: site 备份/恢复（如有站点则验证，否则跳过并说明）**

- 若 `sites` 表有记录且有对应 nginx conf，创建 site 备份并恢复；否则记录"无可验证站点点，跳过"（不伪造数据）。

- [ ] **Step 5: 前后端类型检查 + 汇总提交**

Run: `cd server && npx tsc --noEmit`、`cd web && npx tsc -b`
Expected: 均通过。

```bash
git add -A
git commit -m "feat(backup): real volume/compose/site backup and restore (verified)"
git push origin main
```

---

## Self-Review

- **Spec coverage**：设计文档四类（volume/compose/site 真实备份恢复 + 前端文案）均有对应 Task（2/3/4），端到端验证在 Task 5。
- **Placeholder scan**：无 TODO/TBD；关键实现（tar 工具、dockerode 临时容器、目录派生、安全校验）均给出代码。
- **Type consistency**：`RestoreResult`、`BackupKind`、`BackupManifest`、`writeBackup/getBackup/updateBackupStatus` 沿用第一阶段既有签名；`runVolumeTar` 第三参统一为 `dir`（挂载为容器 `/backup`），前后一致。
- **范围**：聚焦单文件 `manager.ts` 增压 + 前端小改，作为单一实施计划合理。
