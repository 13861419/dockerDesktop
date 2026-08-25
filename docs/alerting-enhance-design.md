# 告警增强 · 实施设计（PRD + 技术方案）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档：`docs/competitor-analysis-brainstorm.md` 第二梯队 #6（镜像 GC 已单独成篇）、第三梯队 #10 等。
> 说明：现有告警已覆盖 cpu/mem/disk/gpu/net（宿主）与 exited/health/port/cpu/mem（容器），**本设计聚焦尚未覆盖的增量维度与治理能力**，不重复已落地项。

---

## 一、背景与目标

在已有告警链路（`alerting.ts` 宿主级 + `container_alert_rules` 容器级 + `notify.ts` 多通道）基础上，补齐**尚未覆盖的告警维度**与**告警治理/静默策略**：

1. **新增宿主维度**：GPU 温度、磁盘 Inode 使用率、进程数/负载、网络连接数、日志速率异常。
2. **新增容器维度**：容器**重启次数**阈值、容器**运行时长**告警（异常短命）、镜像拉取/磁盘增长。
3. **告警抑制（dedupe + 冷却）**：同一规则在 `cooldownSec` 内只发一次（避免风暴）；`silence` 静默窗口扩展支持"按规则/标签"。
4. **告警升级 / 路由**：按级别路由到不同通知渠道。
5. **AI 联动（预留）**：触发时可选附带 AI 根因建议（对接 `ai-assistant-design.md`，本期仅接口预留）。

---

## 二、总体架构（复用现有链路，增量扩展）

```
monitor.ts / containerMetrics   ──►  alerting.ts (宿主+容器规则检测)
                                          │  新增维度检测函数
                                          ▼
                                 emitAlert → dedupe/cooldown 判定 → 按级别路由 channel
                                          ▼
                              notify.ts dispatch → webhook/email/钉钉/飞书
```

- **复用**：`alerting.ts` 的 `fireAlert`/`maybeFire`/`emitAlert`/规则 CRUD + `notify.ts` 通道 + `setting` 表（存 cooldown/冷却）。
- **零依赖**：新增维度全部基于已有 `MonitorPoint` / `containerMetrics` / 平台探测数据，不引入新采集器。

---

## 三、新增维度设计

### 3.1 宿主级（`alerting.ts` 扩展 AlertType 枚举）

| 新类型 | 数据源 | 说明 |
|--------|--------|------|
| `gpuTemp` | `monitor.gpu[].temperature`（nvidia-smi 已有） | GPU 温度超过阈值（如 80℃） |
| `diskInode` | 平台磁盘探测（如 `df -i`，若平台支持） | Inode 使用率告警（磁盘满但空间看似充足时关键） |
| `load` | `os.loadavg` | 系统负载/a进程告警 |
| `conn` | `netstat` / 监控派生 | TCP 连接数告警 |
| `logRate` | 事件/日志增量 | 单容器日志速率异常（风暴） |

> 每项在 `DEFAULT_RULES` 追加默认阈值；`buildMessage`/`unit` 补充对应文案与单位。

### 3.2 容器级（`container_alert_rules` 扩展 `watch_type`）

| 新 watch_type | 说明 |
|---------------|------|
| `restart` | 容器重启次数超过阈值（对比 `RestartCount` 或事件流中的 restart 计数） |
| `uptime` | 容器运行时长低于阈值（异常短命/反复 CrashLoopBackOff） |
| `size` | 容器可写层/磁盘增长超过阈值（需 stats 支持，可先做 `volume` 增长） |

> 复用现有 `ContainerWatchType` 枚举桥接 + `loadContainerRules`/`createContainerRule` CRUD，`watch_type` 白名单扩展。

### 3.3 告警治理（`alerting.ts` + `notify.ts`）

| 能力 | 机制 |
|------|------|
| **冷却（cooldown）** | `emitAlert` 前查"同规则最近触发时间"，间隔 `< cooldownSec` 则去重。`cooldownSec` 可全局（setting 表 `alert.cooldown`）/按规则覆盖。 |
| **静默窗口扩展** | 现有静默时段（非工作时间/仅工作日）保留；新增"按规则/按标签静默"（规则级 `silenceUntil`）。 |
| **级别路由** | 规则配置可选 `routeLevel` → 分发到指定 channel（复用 `notify.ts` 通道列表 + 按级别过滤）。 |
| **AI 联动（预留）** | `emitAlert` 写入时若 AI 已配置，则在 `alert_records` 附 `aiHint` 字段（异步/可选）；本期后端只预留字段与空态，不阻塞。 |

---

## 四、数据/接口变更

- `setting` 表新增 KV：`alert.cooldown`、`alert.silenceByRule` 等（复用 `hubConfig.ts`/`system.ts` 的 KV 读写模式）。
- `alert_rules` / `container_alert_rules` 表新增列（`cooldownSec`、`routeLevel`、`silenceUntil`），用 `ALTER TABLE ... ADD COLUMN` 包裹 try/catch 迁移（与既有 `must_change_password` 迁移一致）。
- 前端 `web/src/pages/notifications.tsx`：编辑规则弹窗加冷却/静默/路由字段；新维度对应动态表单。

---

## 五、安全与合规

1. **只读采集**：新增维度仅读监控数据，无写操作。
2. **风暴防护**：cooldown 是核心防线；默认 `cooldownSec=300`，可全局/按规则调。
3. **路由安全**：channel 凭据仍走 `notify.ts` 加密存储。
4. **AI 联动**：仅追加 `aiHint` 只读字段，AI 不触发任何告警写操作。

---

## 六、任务拆分

| # | 任务 | 涉及文件 | 验收 |
|---|------|----------|------|
| T1 | 宿主新维度（gpuTemp/diskInode/load/conn）接入检测 | `server/src/alerting.ts`、`server/src/platform/*` | 各新 type 能触发/恢复；默认规则可编辑 |
| T2 | 容器新维度（restart/uptime/size） | `server/src/alerting.ts`、`server/src/routes/notifications.ts` | watch_type 白名单扩展、能创建规则并检测 |
| T3 | 冷却 + 静默按规则 + 级别路由 | `server/src/alerting.ts`、`server/src/notify.ts`、`server/src/storage.ts`（迁移） | 同规则 cooldown 内只发一次；按规则静默生效 |
| T4 | AI 联动预留（aiHint 字段 + 空态） | `server/src/alerting.ts`、`server/src/routes/notifications.ts` | 预留字段落库不回显异常；无 AI 时不阻塞 |
| T5 | 前端规则编辑扩展 | `web/src/pages/notifications.tsx`、`web/src/types/index.ts` | 新维度/冷却/静默/路由表单可用；编译通过 + 回归 |

**顺序**：T1→T3（防风暴优先）→T2→T4 ∥ 前端 T5；收尾。

---

## 七、验证清单

1. 某容器反复重启 → `restart` 告警触发，cooldown 内不重复；解除后不再告警。
2. `gpuTemp` 超阈值 → 告警并走路由到指定 channel。
3. 按规则静默窗口内不告警；窗口外恢复。
4. `aiHint` 字段落库可选，无 AI 配置时零影响。
5. `npm run build` 通过；通知/告警既有页面零回归。
