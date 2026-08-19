# C3「更细粒度告警」设计文档

> 日期：2026-08-19
> 类型：功能设计（brainstorming → design）
> 状态：待用户审阅

## 1. 背景与目标

在现有告警系统（宿主级 CPU/内存/磁盘 + 容器级 exited/health/port）基础上，补齐更细粒度告警维度：**GPU 使用率**、**网络 RX/TX 带宽**、**逐容器 CPU/内存阈值**。

保持项目**零第三方 npm 依赖、Windows、Node>=22、SQLite** 约束。

### 已确认决策
- **覆盖范围**：4 个子维度（GPU/网络/容器 CPU 内存/分区空间）→ 经排查，**分区剩余空间已被现有 `disk` 告警覆盖**（基于 `monitor.disk.percent` 分区使用率判定），本次**不重复开发磁盘维度**
- **网络带宽度量**：Mbps 速率（`net.rx/tx` 累计字节差分求速率），非百分比
- **多 GPU 判定**：任一张 GPU 利用率超阈值即触发
- **GPU 判定值**：仅 GPU 利用率 %；显存占用仅作为消息上下文展示，不单独告警
- **容器资源阈值组织**：并入现有 `container_alert_rules` 表，`watch_type` 扩展 `cpu`/`mem`

## 2. 现状分析

- 告警系统为**周期性扫描检测**模型：`monitor.ts` 每 2s 采集实时数据入内存（`getCurrentMonitor()`），`alerting.ts` 每 10s 读规则 + 当前值做阈值判定，推送 4 种通知渠道（Webhook/邮件/钉钉/飞书）
- `MonitorPoint` 已含 `gpu: GpuInfo[]`（nvidia-smi 采集：index/name/utilization/memUsed/memTotal/temperature）、`net: { rx, tx }`（累计字节）
- `alert_rules` 表按 `type`（cpu/mem/disk）存 warn/danger 阈值 + 静默/工作时段，`loadRules()` 对缺省类型 INSERT OR IGNORE 补默认行
- `container_alert_rules` 表 `UNIQUE(container_id, watch_type)`，`watch_type ∈ {exited, health, port}`
- 关键复用件：`evaluateLevel`（阈值判定）、`maybeFire`（级别去重）、`activeAlerts` 状态机（恢复通知）、`isInSilentWindow`（静默/工作日/工作时段）
- 关键缺口：monitor 未逐容器暴露 CPU/内存统计（仅 `aggregateContainerStats` 聚合总数）

## 3. 架构

三个子功能共用现有 `check()` 周期检测框架，各自扩展判定维度：

```
monitor.ts（每2s采集）
  ├── gpu[]（已有，nvidia-smi）
  ├── net.rx/tx 累计字节（已有）→ 新增 netRate: {rxMbps, txMbps}（差分）
  └── 容器 stats（已有聚合）→ 新增 containerStats: Array<{id,name,cpuPercent,memPercent}>

alerting.ts check()（每10s）
  ├── 宿主级 samples：cpu/mem/disk + 新增 gpu（利用率%）、net（Mbps）
  └── 容器级：checkContainerRules() 内新增 cpu/mem 资源阈值判定
        │
        ▼ 命中 → maybeFire → 复用 activeAlerts/去重/静默
        ▼ 回落 → fireRecovery → 恢复通知
        ▼ 推送 → 4 种既有渠道
```

## 4. 后端设计

### 4.1 monitor.ts 扩展
- 新增 `MonitorNetRate { netRate: { rxMbps: number; txMbps: number } }`：在每次采集时用 `(当前累计 - 上次累计) / 间隔秒 * 8 / 1e6` 计算 Mbps（首轮无上次采样返回 0）
- 新增 `MonitorContainerStat { id: string; name: string; cpuPercent: number; memPercent: number }`
- 扩展 `MonitorPoint`：`gpu`、`net` 保留；新增 `netRate`、`containerStats: MonitorContainerStat[]`
  - CPU：per-container 差分（复用现有聚合的差分算法，按单容器计算）
  - 内存：`stats.memory_stats.usage / memory_stats.limit * 100`
- 注意：`getHistoryTrend`/趋势精简点（leanPoint）需同步剔除/保留新字段，避免向前端透传冗余

### 4.2 alerting.ts 扩展（宿主级）
- `DEFAULT_RULES` 增加两行：
  - `{ type: 'gpu', name: 'GPU', warn: 75, danger: 90 }`（阈值=利用率%）
  - `{ type: 'net', name: '网络带宽', warn: 100, danger: 200 }`（阈值=Mbps）
- `check()` 的 `samples` 增加两维：
  - `{ type: 'gpu', percent: 任意GPU的最大利用率 }`（无 GPU 时跳过该维度，不告警）
  - `{ type: 'net', percent: max(rxMbps, txMbps) }`（阈值语义为 Mbps，复用 evaluateLevel 的 `>=` 比较）
- `evaluateLevel` 保持不变（`percent >= danger/warn` 判定，单位语义由调用方决定）
- 消息文案：GPU 含 GPU 名称/索引；网络含上/下行速率与方向
- 恢复消息 `fireRecovery` 的 names 映射需扩展 gpu/net

### 4.3 容器资源阈值（并入 container_alert_rules）
- `watch_type` 枚举扩展：`exited / health / port / cpu / mem`
- `cpu`/`mem` 类型使用既有 `warn_threshold`/`danger_threshold` 列（当前容器表无此列，需**宽松 ALTER 加列** `warn_threshold REAL DEFAULT 75`、`danger_threshold REAL DEFAULT 90`）
- 仅对**运行中**容器检测（沿用 port 探测的运行态前提）；CPU 用 `containerStats[].cpuPercent`，内存用 `containerStats[].memPercent`
- 状态机/去重/静默全部复用现有容器告警机制（`containerActive`、`containerLastAlert`、`isInSilentWindow`）
- 消息：`Docker 面板【容器】「<name>」CPU 使用率 92.3% 超过危险阈值 90%`

## 5. 数据模型

### 5.1 alert_rules（宿主级）
- **无需 ALTER 加列**：新增 `gpu`/`net` 两行类型由 `loadRules()` 的 INSERT OR IGNORE 自动补齐，复用现有 `warn_threshold`/`danger_threshold`/静默列
- 语义差异：`gpu` 阈值为利用率 %，`net` 阈值为 Mbps —— 仅解释层面不同，列结构不变

### 5.2 container_alert_rules（容器级）
- 宽松迁移新增列（try/catch 包裹，参照现有迁移模式）：
  - `warn_threshold REAL DEFAULT 75`
  - `danger_threshold REAL DEFAULT 90`
- `UNIQUE(container_id, watch_type)` 保持不变，cpu/mem 各自成行

### 5.3 alert_records
- `type` 新增值：`gpu`、`net`（宿主），`cpu`、`mem`（容器级，与现有容器事件区分靠 message 前缀 + 容器名）
- 已是 TEXT 列，无需迁移

## 6. 后端 API

| 方法 | 路径 | 权限 | 变更 |
|---|---|---|---|
| `GET` | `/api/notifications/rules` | 登录 | `type` 覆盖 gpu/net；`currentPercent` 兼容；页面按 type 展示单位（% / Mbps） |
| `PUT` | `/api/notifications/rules/:type` | 管理员 | `:type` 支持 `gpu`/`net` |
| `GET` | `/api/notifications/container-rules` | 登录 | 返回含 watch_type=cpu/mem 的行，附带当前值 |
| `POST` | `/api/notifications/container-rules` | 管理员 | watch_type 接受 cpu/mem + warn_threshold/danger_threshold |
| `PUT` | `/api/notifications/container-rules/:id` | 管理员 | 同上更新 |
| `DELETE` | `/api/notifications/container-rules/:id` | 管理员 | 不变 |

- `GET /rules` 的 `currentPercent` 保持字段名（前端已用），GPU 回传当前利用率，net 回传当前速率；前端根据 `type` 决定展示单位
- `GET /container-rules` 为 cpu/mem 行附 `currentValue`，供前端展示当前使用率

## 7. 前端设计（notifications.tsx）

### 7.1 宿主级规则表格
- 规则列表新增「GPU」「网络带宽」两行
- 阈值输入：GPU 后加 "%" 后缀；网络后加 "Mbps" 后缀
- 下一列「当前值」：GPU 显示当前利用率%，网络显示当前速率（如 `12.4 Mbps ↓ / 3.1 Mbps ↑`）
- 无 NVIDIA GPU 时，GPU 行 `currentValue` 显示「未检测到 GPU」，规则仍可配置（机器接 GPU 后自动生效）

### 7.2 容器告警规则表格
- 新增「监听类型」选项：exited/health/port/**cpu**/**mem**
- 选择 cpu/mem 时展开显示 warn/danger 阈值输入（默认 75/90）
- 列表显示当前使用率（cpu/mem 行）

### 7.3 类型扩展
- 本地 `AlertRule`、`ContainerRule` 类型补 `gpu`/`net`/`cpu`/`mem` 与 `warnThreshold`/`dangerThreshold` 字段

## 8. 安全与边界
- **nvidia-smi 子进程**：复用 monitor 现有 `collectGpu()` 的固定查询字符串 `nvidia-smi --query-gpu=...`，无拼接、无注入面
- **容器目标匹配**：容器资源规则用 docker 容器 id（`container_id`）主键匹配，不拼接 shell
- **无 GPU 降级**：`gpu[]` 为空 → 宿主 GPU 维度跳过不告警，页面提示「未检测到 GPU」
- **容器资源规则**：目标容器不存在或非运行中 → 跳过该规则（不误报）
- **带宽差分边界**：首轮无上一采样点 → 速率为 0（不误报）；采集中断恢复后差分跨度过大时，限制单次差分最大值防突刺

## 9. 测试

### 单元测试（server/test 新增）
- 差分算 Mbps 纯函数：已知累计差 + 间隔 → 期望 Mbps；首轮为 0
- `evaluateLevel` 对 net 的 Mbps 阈值语义（>= 判定）
- 容器资源规则 CRUD：watch_type=cpu/mem 建改删、阈值持久化
- 宿主规则 loadRules：gpu/net 缺省行自动补齐

### 端到端
- 无 NVIDIA 机器：`GET /rules` 正常返回 gpu/net 行、检测不报错（GPU 维度跳过）
- `/container-rules` cpu/mem 规则创建 + 检测触发/恢复
- 前端规则表格渲染新维度与单位

## 10. 范围外（YAGNI）
- GPU 显存占用率阈值告警（仅上下文展示，不单独告警）
- 磁盘剩余空间绝对值阈值（现有 disk 使用率告警已覆盖）
- 容器级网络带宽告警（容器 stats 已有 net 字节，暂不纳入，预留数据）
- 新通知渠道（已有 4 种足够）
