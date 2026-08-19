# C3 更细粒度告警 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有告警系统上新增 GPU 使用率、网络 RX/TX 带宽、逐容器 CPU/内存阈值三类更细粒度告警。

**Architecture:** 沿用"监控采集器每 2s 采数据入内存 + 告警服务每 10s 读规则做阈值判定"的周期检测模型。monitor.ts 扩展采集维度（逐容器 CPU/内存 + 网络速率 Mbps 差分），alerting.ts 宿主级新增 gpu/net 判定、容器级 watch_type 扩展 cpu/mem，全部复用现有 activeAlerts/maybeFire/静默/4 渠道推送链路。磁盘维度已被现有 disk 告警覆盖，不新增。

**Tech Stack:** Node.js（node:sqlite、child_process、net、crypto）、dockerode、React + TypeScript + Vite。

## Global Constraints

- 零第三方 npm 运行时依赖；Windows 平台；Node>=22；SQLite（node:sqlite）。
- 新增模块须同时挂载：后端路由（server/src/app.ts）、前端页面路由（web/src/App.tsx）、侧边栏（web/src/components/Layout.tsx）——本功能均复用既有 `/notifications` 路由，无需新增挂载。
- 前端组件为单文件默认导出导入；`Select/Input/Field` 来自 `../components/Form`。
- SQLite 宽松迁移用 `ALTER TABLE ... ADD COLUMN` 包 try/catch，列已存在则忽略。
- 命令/子进程无注入面：nvidia-smi/docker 固定命令字符串，不拼接用户输入。
- 函数级注释（中文），遵循项目既有注释风格。

---

### Task 1: monitor.ts 扩展采集维度

**Files:**
- Modify: `server/src/docker/monitor.ts`（顶部接口、`aggregateContainerStats`、`collect()`、`MonitorPoint`、`MetricPoint`/`leanPoint` 精简）

**Interfaces:**
- Consumes: 无（本项目首个数据源改动）。
- Produces:
  - `interface MonitorContainerStat { id: string; name: string; cpuPercent: number; memPercent: number }`
  - `MonitorPoint.netRate: { rxMbps: number; txMbps: number }`
  - `MonitorPoint.containerStats: MonitorContainerStat[]`
  - `export function computeNetRate(curRx: number, curTx: number, prevRx: number, prevTx: number, elapsedSec: number): { rxMbps: number; txMbps: number }`（纯函数，可测）

- [ ] **Step 1: 写失败测试**（新建 `server/test/c3.test.ts`，TDD 先测纯函数）

```ts
import { computeNetRate } from '../src/docker/monitor';

test('computeNetRate 正确计算 Mbps 速率', () => {
  // 100MB 累计差，2 秒间隔 → 每秒 50MB = 400Mbps
  const r = computeNetRate(100 * 1024 * 1024, 50 * 1024 * 1024, 0, 0, 2);
  expect(r.rxMbps).toBeCloseTo(400, 5);
  expect(r.txMbps).toBeCloseTo(200, 5);
});

test('computeNetRate 倒置差分回落为 0（防突刺）', () => {
  const r = computeNetRate(0, 0, 100, 100, 2);
  expect(r.rxMbps).toBe(0);
  expect(r.txMbps).toBe(0);
});

test('computeNetRate 零间隔返回 0（避免除零）', () => {
  const r = computeNetRate(100, 100, 0, 0, 0);
  expect(r.rxMbps).toBe(0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server; npx ts-node --project tsconfig.test.json --eval "import('ts-node')"` 不可用，用项目现有测试框架。

Run: `cd server; node --test --require ts-node/register test/c3.test.ts`
Expected: FAIL with `computeNetRate is not exported` / module 解析失败。

- [ ] **Step 3: 实现 computeNetRate 与接口**（monitor.ts 顶部新增导出纯函数）

在 `import`/常量区附近（`MonitorPoint` 接口前）新增：

```ts
/**
 * 计算网络带宽速率（Mbps）。
 * 基于相邻两次采样累计字节差分：速率 = (增量字节 * 8) / 时间秒 / 1e6。
 * 倒置差分（计数器重置）或零间隔时返回 0，避免误报与除零。
 * @param curRx 本次接收累计字节
 * @param curTx 本次发送累计字节
 * @param prevRx 上次接收累计字节
 * @param prevTx 上次发送累计字节
 * @param elapsedSec 两次采样间隔秒数
 * @returns { rxMbps, txMbps } 上行/下行速率
 */
export function computeNetRate(
  curRx: number, curTx: number, prevRx: number, prevTx: number, elapsedSec: number,
): { rxMbps: number; txMbps: number } {
  if (!elapsedSec || elapsedSec <= 0) return { rxMbps: 0, txMbps: 0 };
  const toRate = (cur: number, prev: number) => {
    const delta = cur - prev;
    if (delta < 0) return 0; // 计数器重置，本采样点无法计算，视为 0
    return Number(((delta * 8) / elapsedSec / 1e6).toFixed(3));
  };
  return { rxMbps: toRate(curRx, prevRx), txMbps: toRate(curTx, prevTx) };
}
```

在 `MonitorPoint` 接口（L68-79）下层新增容器统计接口：

```ts
/** 单个容器的资源使用统计（供容器级 CPU/内存阈值告警） */
export interface MonitorContainerStat {
  /** 容器 id */
  id: string;
  /** 容器显示名 */
  name: string;
  /** CPU 使用率（0-100） */
  cpuPercent: number;
  /** 内存使用率（0-100） */
  memPercent: number;
}
```

- [ ] **Step 4: 实现扩展字段**（monitor.ts 顶层新增网络状态变量）

在 `lastCpu` 声明（L94）附近新增：

```ts
/** 网络累计字节采样状态（用于差分求速率） */
let lastNet: { rx: number; tx: number; at: number } | null = null;
```

- [ ] **Step 5: 重构 aggregateContainerStats 支持逐容器统计**（替换 L142-185）

将原聚合函数改为同时返回逐容器 CPU/内存统计（用同一批 stats 一次计算，避免重复抓取）：

```ts
/**
 * 聚合所有运行中容器的 CPU / 网络使用情况，并产出逐容器资源统计
 * @param docker dockerode 客户端
 */
async function aggregateContainerStats(docker: Dockerode): Promise<{
  cpuPercent: number;
  netRx: number;
  netTx: number;
  containerStats: MonitorContainerStat[];
}> {
  const containers = await docker.listContainers({ all: false });
  let cpuTotal = 0;
  let cpuCoresAcc = 0;
  let netRx = 0;
  let netTx = 0;
  const containerStats: MonitorContainerStat[] = [];

  const statsArr = await Promise.all(
    containers.map(async (c) => {
      try {
        const nm = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '') || c.Id.slice(0, 12);
        const stats = await docker.getContainer(c.Id).stats({ stream: false });
        return { id: c.Id, name: nm, stats: stats as any };
      } catch {
        return null;
      }
    }),
  );

  for (const item of statsArr) {
    if (!item) continue;
    const s = item.stats;
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
    const onlineCpus = s.cpu_stats?.online_cpus || 1;
    cpuCoresAcc += onlineCpus;
    if (sysDelta > 0) {
      cpuTotal += (cpuDelta / sysDelta) * onlineCpus * 100;
    }
    for (const key of Object.keys(s.networks || {})) {
      netRx += s.networks[key].rx_bytes || 0;
      netTx += s.networks[key].tx_bytes || 0;
    }
    // 逐容器 CPU / 内存使用率
    let cCpu = 0;
    if (sysDelta > 0) cCpu = Math.min(100, Math.max(0, (cpuDelta / sysDelta) * onlineCpus * 100));
    const mLimit = s.memory_stats?.limit || 0;
    const mUsage = s.memory_stats?.usage || 0;
    const cMem = mLimit > 0 ? Math.min(100, ((mUsage / mLimit) * 100)) : 0;
    containerStats.push({
      id: item.id,
      name: item.name,
      cpuPercent: Number(cCpu.toFixed(2)),
      memPercent: Number(cMem.toFixed(2)),
    });
  }

  return {
    cpuPercent: cpuCoresAcc > 0 ? cpuTotal / containers.length || 0 : 0,
    netRx,
    netTx,
    containerStats,
  };
}
```

- [ ] **Step 6: 扩展 MonitorPoint 结构并在 collect() 填充 netRate 与 containerStats**

修改 `MonitorPoint` 接口（L76 处）新增两个字段：

```ts
  net: { rx: number; tx: number }; // 累计字节
  /** 网络 RX/TX 速率（Mbps，由累计字节差分得到，首轮为 0） */
  netRate: { rxMbps: number; txMbps: number };
  /** 逐容器资源统计（供容器级阈值告警） */
  containerStats: MonitorContainerStat[];
```

修改 `collect()` 中调用 `aggregateContainerStats` 处（L357 附近）以接收逐容器并计算速率。

找到 L353-360 结构，改为：

```ts
    let netRx = 0;
    let netTx = 0;
    let containerStats: MonitorContainerStat[] = [];
    try {
      const agg = await aggregateContainerStats(docker);
      netRx = agg.netRx;
      netTx = agg.netTx;
      containerStats = agg.containerStats;
    } catch {
      // 容器 stats 失败则保持 0，不影响宿主级采集
    }
    // 网络速率差分：基于相邻两次采样的累计字节
    const nowMs = Date.now();
    let netRate = { rxMbps: 0, txMbps: 0 };
    if (lastNet) {
      netRate = computeNetRate(netRx, netTx, lastNet.rx, lastNet.tx, (nowMs - lastNet.at) / 1000);
    }
    lastNet = { rx: netRx, tx: netTx, at: nowMs };
```

`MonitorPoint` 字面量（L397-416）中 `net` 后补充：

```ts
      net: { rx: netRx, tx: netTx },
      netRate,
      containerStats,
```

- [ ] **Step 7: 精简历史点剔除嵌套结构**（避免把 containerStats 透传到历史趋势接口）

`MetricPoint` 接口（L490-505）与 `leanPoint` 精简映射函数无需新增 containerStats/netRate——保持现状即可（当前 leanPoint 只挑指定字段，天然剔除）。**无需改动**。若存在显式展开全部字段的映射，需确认不含 containerStats/netRate；若无则本步骤为核查项。

- [ ] **Step 8: 跑测试**

Run: `cd server; node --test --require ts-node/register test/c3.test.ts`
Expected: PASS（computeNetRate 三用例通过）。

再用 ts 编译核查 monitor.ts 无类型错误：

Run: `cd server; npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/docker/monitor.ts server/test/c3.test.ts
git commit -m "feat(monitor): 新增逐容器 CPU/内存统计与网络速率 Mbps 差分"
```

---

### Task 2: storage.ts 迁移容器阈值列

**Files:**
- Modify: `server/src/storage.ts`（migrate 函数内，alerts 迁移区）

**Interfaces:**
- Consumes: 无。
- Produces: `container_alert_rules` 新增两列 `warn_threshold REAL DEFAULT 75`、`danger_threshold REAL DEFAULT 90`。

- [ ] **Step 1: 在迁移函数中添加列**

在 storage.ts migrate 中 `alert_rules` 静默字段迁移块（L534 之后、cron_tasks 迁移之前）插入两段 try/catch ALTER：

```ts
  // 迁移：为 container_alert_rules 补充 CPU/内存阈值列（watch_type=cpu/mem 时使用，其余类型为 NULL/默认）
  try {
    d.exec('ALTER TABLE container_alert_rules ADD COLUMN warn_threshold REAL DEFAULT 75');
  } catch {
    // 列已存在则忽略
  }
  try {
    d.exec('ALTER TABLE container_alert_rules ADD COLUMN danger_threshold REAL DEFAULT 90');
  } catch {
    // 列已存在则忽略
  }
```

- [ ] **Step 2: 验证迁移幂等**

Run: `cd server; node -e "const s=require('ts-node/register');const st=require('./src/storage');st.openDb&&st.openDb({});console.log('db initialized')"`

Expected: 无异常；重复执行不报"duplicate column"。用 `npx tsc --noEmit -p tsconfig.json` 确认无类型错误。

（若 openDb 签名需参数，参照现有 storage 用法；此处仅验证迁移逻辑被加载即算通过。）

- [ ] **Step 3: Commit**

```bash
git add server/src/storage.ts
git commit -m "feat(storage): container_alert_rules 新增 CPU/内存阈值列"
```

---

### Task 3: alerting.ts 宿主级 GPU/网络告警

**Files:**
- Modify: `server/src/alerting.ts`（AlertType、DEFAULT_RULES、check()、fireRecovery、updateAlertRule 白名单）

**Interfaces:**
- Consumes: Task 1 的 `MonitorPoint.netRate`、`MonitorPoint.gpu`。
- Produces:
  - `DEFAULT_RULES` 含 `gpu`/`net` 两行。
  - `AlertType` 增加 `'gpu' | 'net'`。
  - `check()` 宿主 samples 含 gpu（最大利用率）与 net（max(rxMbps,txMbps)）。

- [ ] **Step 1: 扩展 AlertType 与 DEFAULT_RULES**

L21 AlertType 改为：

```ts
/** 资源类型（含容器级告警的监控类型，用于告警记录 type 字段） */
export type AlertType = 'cpu' | 'mem' | 'disk' | 'task' | 'exited' | 'health' | 'port' | 'gpu' | 'net';
```

L65-69 DEFAULT_RULES 增加两行：

```ts
  { type: 'gpu', name: 'GPU', warn: 75, danger: 90 },
  { type: 'net', name: '网络带宽', warn: 100, danger: 200 },
```

- [ ] **Step 2: 扩展 check() 宿主 samples**

L326-330 samples 数组增加 gpu/net 两维（在 `getCurrentMonitor()` 可用数据中取）：

```ts
  const point = getCurrentMonitor();
  if (!point) return; // 监控尚未就绪
  const rules = loadRules();
  // GPU：取所有 GPU 的最大利用率作为判定值（任一张超阈值即触发）；无 GPU 则跳过该维度
  const gpuUtil = point.gpu && point.gpu.length > 0 ? Math.max(...point.gpu.map((g) => g.utilization || 0)) : -1;
  // 网络：取上下行较大者作为判定值（阈值语义为 Mbps）
  const netMax = point.netRate ? Math.max(point.netRate.rxMbps, point.netRate.txMbps) : -1;
  const samples: Array<{ type: AlertType; percent: number }> = [
    { type: 'cpu', percent: point.cpu.percent },
    { type: 'mem', percent: point.mem.percent },
    { type: 'disk', percent: point.disk.percent },
    { type: 'gpu', percent: gpuUtil },
    { type: 'net', percent: netMax },
  ];
```

注意：gpu/net 维度 percent 为 -1 时代表"无数据"，需在采样循环里跳过，避免误触发。在 for 循环开头增加：

```ts
  for (const s of samples) {
    if (s.percent < 0) continue; // 该维度当前无数据（无 GPU / 首轮无网络速率），跳过
    const rule = rules[s.type];
    ...
  }
```

- [ ] **Step 3: 定制 gpu/net 告警文案**（丰富消息内容）

`check()` 循环中触发时，对 gpu/net 需要附加信息（GPU 名称/方向）。在 `maybeFire` 调用前为这两类定制 message。将触发分支改为按类型组装 message：

在 L346 的 `await maybeFire(...)` 之前，对 gpu/net 构造带上下文的文案。将触发逻辑改为：

```ts
    const level = evaluateLevel(s.percent, rule);
    if (level) {
      const escalated = prev === null || (level === 'danger' && prev !== 'danger');
      activeAlerts.set(s.type, level);
      let message: string | null = null;
      if (s.type === 'gpu') {
        const top = point.gpu!.reduce((a, b) => (b.utilization > a.utilization ? b : a));
        message = `Docker 面板【GPU】${top.name}（index ${top.index}）利用率 ${top.utilization}% ${level === 'danger' ? '超过危险' : '超过警告'}阈值 ${rule[s.type].danger}%`;
      } else if (s.type === 'net') {
        const dir = point.netRate!.rxMbps >= point.netRate!.txMbps ? '下行' : '上行';
        const val = dir === '下行' ? point.netRate!.rxMbps : point.netRate!.txMbps;
        message = `Docker 面板【网络】${dir}带宽 ${val.toFixed(1)} Mbps ${level === 'danger' ? '超过危险' : '超过警告'}阈值 ${rule[s.type].danger} Mbps`;
      }
      if (s.type === 'gpu' || s.type === 'net') {
        await maybeFire(s.type, level, s.percent, escalated);
        // 记录已由 maybeFire 内部写，此处 message 定制仅用于推送到渠道
      } else {
        await maybeFire(s.type, level, s.percent, escalated);
      }
    } else if (prev) {
      activeAlerts.delete(s.type);
      await fireRecovery(s.type, s.percent);
    }
```

> 说明：为最小改动，gpu/net 的告警**记录落库**仍沿用 maybeFire → fireAlert 现有文案路径（含 `%` 后缀）。文案定制可放在 `emitAlert`/`fireAlert` 的消息参数处，若实现复杂，可接受 gpu/net 记录复用统一文案（`Docker 面板【GPU】使用率 xx%`），因 value 字段已记录数值、前端按 type 显示单位。**实现时分两步**：先保证触发/记录/推送与阈值判定正确（本步），文案精细化视复杂度决定，非阻塞。

- [ ] **Step 4: 扩展 fireRecovery names 与 updateAlertRule 白名单**

L288 names 映射补：

```ts
  const names: Record<string, string> = { cpu: 'CPU', mem: '内存', disk: '磁盘', gpu: 'GPU', net: '网络带宽' };
```

L483 updateAlertRule 类型白名单补 gpu/net：

```ts
  if (!['cpu', 'mem', 'disk', 'gpu', 'net'].includes(type)) {
    throw Object.assign(new Error('不支持的告警类型'), { statusCode: 400 });
  }
```

- [ ] **Step 5: 跑测试**

Run: `cd server; npx tsc --noEmit -p tsconfig.json`
Expected: no errors。

Run 端到端（无 NVIDIA 机器也应通过）：

```bash
cd server; node --test --require ts-node/register test/auth-security.test.ts test/webhook-git.test.ts test/trivy.test.ts test/c3.test.ts
```

Expected: 全部通过（c3 3 项 + 既有 16 项 = 19 项）。

- [ ] **Step 6: Commit**

```bash
git add server/src/alerting.ts
git commit -m "feat(alerting): 宿主级新增 GPU 使用率与网络带宽 Mbps 告警"
```

---

### Task 4: alerting.ts 容器级 CPU/内存阈值

**Files:**
- Modify: `server/src/alerting.ts`（ContainerWatchType、ContainerAlertRuleRow、normalizeContainerRule、ContainerAlertRule、validateContainerRuleInput、create/updateContainerAlertRule、checkContainerRules、checkOneContainerRule）

**Interfaces:**
- Consumes: Task 1 的 `MonitorPoint.containerStats`（经 `getCurrentMonitor()`）；Task 2 的阈值列。
- Produces:
  - `ContainerWatchType = 'exited' | 'health' | 'port' | 'cpu' | 'mem'`
  - `ContainerAlertRule` 增 `warnThreshold: number; dangerThreshold: number`
  - `checkContainerRules()` 读取 `getCurrentMonitor().containerStats` 构建 `Map<containerId, stats>`，传给 `checkOneContainerRule`
  - `checkOneContainerRule` 对 watch_type cpu/mem 用容器统计判定

- [ ] **Step 1: 扩展容器类型与结构**

找到 `ContainerWatchType` 定义（grep 定位，应在文件顶部类型区），改为：

```ts
/** 容器级监控类型 */
export type ContainerWatchType = 'exited' | 'health' | 'port' | 'cpu' | 'mem';
```

`ContainerAlertRuleRow`（L719-732）补两列：

```ts
  warn_threshold: number;
  danger_threshold: number;
```

`ContainerAlertRule`（L735-747）补两字段：

```ts
  warnThreshold: number;
  dangerThreshold: number;
```

`normalizeContainerRule`（L750-763）补映射：

```ts
    warnThreshold: r.warn_threshold,
    dangerThreshold: r.danger_threshold,
```

`containerRuleToQuiet`（L773-784）中的 warn/danger 用实际阈值（供 evaluateLevel 使用当前值或供统一静默结构——实际 cpu/mem 判定用阈值）：

```ts
function containerRuleToQuiet(r: ContainerAlertRule): AlertRule {
  return {
    enabled: r.enabled,
    warn: r.warnThreshold,
    danger: r.dangerThreshold,
    ...
  };
}
```

- [ ] **Step 2: 更新 SELECT/INSERT/UPDATE 语句纳入阈值列**

`loadContainerRules`（L987）SELECT 补列：

```ts
      'SELECT id, container_id, watch_type, enabled, port, warn_threshold, danger_threshold, silent_start, silent_end, workdays_only, work_start, work_end, created_at, updated_at FROM container_alert_rules',
```

`validateContainerRuleInput`（L1020-1052）返回类型与逻辑：扩展返回对象含阈值为 0 的兜底；watch_type 白名单加 cpu/mem：

```ts
function validateContainerRuleInput(body: any): { containerId: string; watchType: string; port: number | null; warnThreshold: number; dangerThreshold: number; enabled: number; ... } {
  ...
  const watchType = String(body?.watchType || '').trim() as ContainerWatchType;
  if (!['exited', 'health', 'port', 'cpu', 'mem'].includes(watchType)) {
    throw Object.assign(new Error('不支持的容器监控类型'), { statusCode: 400 });
  }
  let port: number | null = null;
  if (watchType === 'port') {
    const raw = Number(body?.port);
    if (!raw || raw < 1 || raw > 65535) {
      throw Object.assign(new Error('端口需为 1-65535 的整数（或留空自动探测映射主端口）'), { statusCode: 400 });
    }
    port = raw;
  }
  let warnThreshold = 75;
  let dangerThreshold = 90;
  if (watchType === 'cpu' || watchType === 'mem') {
    const w = Number(body?.warnThreshold);
    const dd = Number(body?.dangerThreshold);
    if (!Number.isFinite(w) || w < 0 || w > 100) throw Object.assign(new Error('警告阈值需为 0-100'), { statusCode: 400 });
    if (!Number.isFinite(dd) || dd < 0 || dd > 100) throw Object.assign(new Error('危险阈值需为 0-100'), { statusCode: 400 });
    warnThreshold = w;
    dangerThreshold = dd;
  }
  ...
  return { containerId, watchType, port, warnThreshold, dangerThreshold, enabled: ..., silentStart, silentEnd, workdaysOnly, workStart, workEnd };
}
```

`createContainerAlertRule`（L1068 INSERT）补列：

```ts
      'INSERT INTO container_alert_rules (container_id, watch_type, enabled, port, warn_threshold, danger_threshold, silent_start, silent_end, workdays_only, work_start, work_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    .run(
      v.containerId, v.watchType, v.enabled, v.port, v.warnThreshold, v.dangerThreshold, v.silentStart, v.silentEnd, v.workdaysOnly, v.workStart, v.workEnd, now, now,
    );
```

`updateContainerAlertRule`（L1086-1116）：watch_type 白名单加 cpu/mem；对 cpu/mem 更新阈值；UPDATE 语句补列：

```ts
  if (body?.watchType !== undefined) {
    const wt = String(body.watchType) as ContainerWatchType;
    if (!['exited', 'health', 'port', 'cpu', 'mem'].includes(wt)) {
      throw Object.assign(new Error('不支持的容器监控类型'), { statusCode: 400 });
    }
    next.watch_type = wt;
  }
  // cpu/mem 阈值
  if (next.watch_type === 'cpu' || next.watch_type === 'mem') {
    const w = body?.warnThreshold !== undefined ? Number(body.warnThreshold) : row.warn_threshold;
    const dd = body?.dangerThreshold !== undefined ? Number(body.dangerThreshold) : row.danger_threshold;
    if (!Number.isFinite(w) || w < 0 || w > 100) throw Object.assign(new Error('警告阈值需为 0-100'), { statusCode: 400 });
    if (!Number.isFinite(dd) || dd < 0 || dd > 100) throw Object.assign(new Error('危险阈值需为 0-100'), { statusCode: 400 });
    next.warn_threshold = w;
    next.danger_threshold = dd;
  }
  // UPDATE 语句
  d.prepare(
    'UPDATE container_alert_rules SET container_id = ?, watch_type = ?, enabled = ?, port = ?, warn_threshold = ?, danger_threshold = ?, silent_start = ?, silent_end = ?, workdays_only = ?, work_start = ?, work_end = ?, updated_at = ? WHERE id = ?',
  ).run(
    next.container_id, next.watch_type, next.enabled, next.port, next.warn_threshold, next.danger_threshold, next.silent_start, next.silent_end, next.workdays_only, next.work_start, next.work_end, Date.now(), id,
  );
```

- [ ] **Step 3: checkContainerRules 接入容器统计**

在 `checkContainerRules`（L934-978）中读取容器统计并传给逐条判定。改为：

```ts
async function checkContainerRules(): Promise<void> {
  const rules = loadContainerRules();
  if (rules.length === 0) return;
  const docker = await getDockerClient();
  let list: any[] = [];
  try {
    list = (await docker.listContainers({ all: true })) as any[];
  } catch {
    return; // 引擎不可用则跳过本轮
  }
  // 容器 id → 显示名 映射；名称优先，回退 id 短
  const names = new Map<string, string>();
  for (const c of list) {
    const nm = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '') || c.Id.slice(0, 12);
    names.set(c.Id, nm);
  }
  // 从实时监控点读取逐容器 CPU/内存统计（容器级阈值告警数据源）
  const point = getCurrentMonitor();
  const statMap = new Map<string, { cpuPercent: number; memPercent: number }>();
  if (point && point.containerStats) {
    for (const cs of point.containerStats) statMap.set(cs.id, { cpuPercent: cs.cpuPercent, memPercent: cs.memPercent });
  }

  for (const rule of rules) {
    if (!rule.enabled) {
      if (containerActive.has(rule.id)) containerActive.delete(rule.id);
      continue;
    }
    if (isInSilentWindow(containerRuleToQuiet(rule), new Date())) continue;

    const targetId = names.has(rule.containerId)
      ? rule.containerId
      : (() => {
          for (const [id, nm] of names) {
            if (nm === rule.containerId || nm.replace(/^\/+/, '') === rule.containerId) return id;
          }
          return '';
        })();
    const displayName = (targetId && names.get(targetId)) || rule.containerId;
    // cpu/mem 规则用监控统计判定（无需 inspect），其余事件类规则仍走 inspect
    if (rule.watchType === 'cpu' || rule.watchType === 'mem') {
      const stat = targetId ? statMap.get(targetId) : undefined;
      await checkContainerResourceRule(rule, displayName, stat);
      continue;
    }
    let info: any = undefined;
    if (targetId) {
      try {
        info = await docker.getContainer(targetId).inspect();
      } catch {
        info = undefined;
      }
    }
    await checkOneContainerRule(rule, displayName, info);
  }
}
```

- [ ] **Step 4: 新增 checkContainerResourceRule 判定函数**

在 `checkOneContainerRule` 之后新增（复用 emitContainerAlert 写记录 + 去重状态机）：

```ts
/**
 * 容器 CPU / 内存阈值判定（复用 emitContainerAlert 的去重、状态机与通知）
 * @param rule 容器规则（watchType 为 cpu/mem）
 * @param name 容器显示名
 * @param stat 该容器实时统计；容器不存在或非运行中时为 undefined
 */
async function checkContainerResourceRule(
  rule: ContainerAlertRule,
  name: string,
  stat: { cpuPercent: number; memPercent: number } | undefined,
): Promise<void> {
  const n = Date.now();
  const recent = containerLastAlert.get(rule.id) || 0;
  const canFire = (escalated: boolean) => (!escalated && n - recent < REPEAT_INTERVAL ? false : true);
  const markFired = () => containerLastAlert.set(rule.id, n);
  const prev = containerActive.get(rule.id) ?? null;
  const setActive = (lvl: 'warn' | 'danger' | null) => {
    if (lvl === null) containerActive.delete(rule.id);
    else containerActive.set(rule.id, lvl);
  };

  let hit: { level: 'warn' | 'danger'; message: string; value: number | null } | null = null;
  if (!stat) {
    // 容器不存在或未运行：cpu/mem 无从统计，不告警也不发恢复（保持活跃态清理）
    if (prev) setActive(null);
    return;
  }
  const value = rule.watchType === 'cpu' ? stat.cpuPercent : stat.memPercent;
  const label = rule.watchType === 'cpu' ? 'CPU' : '内存';
  const level = value >= rule.dangerThreshold ? 'danger' : value >= rule.warnThreshold ? 'warn' : null;
  if (level) {
    hit = {
      level,
      message: `Docker 面板【容器】${name} ${label}使用率 ${value.toFixed(1)}% 超过${level === 'danger' ? '危险' : '警告'}阈值 ${level === 'danger' ? rule.dangerThreshold : rule.warnThreshold}%`,
      value: Number(value.toFixed(1)),
    };
  }

  if (hit) {
    const escalated = prev === null || (hit.level === 'danger' && prev !== 'danger');
    setActive(hit.level);
    if (canFire(escalated)) {
      markFired();
      await emitContainerAlert(rule, name, hit.level, hit.message, hit.value);
    }
  } else if (prev) {
    setActive(null);
    await emitContainerAlert(rule, name, 'recovery', `Docker 面板【容器】${name} ${label}使用率已恢复正常`, null);
  }
}
```

- [ ] **Step 5: 跑测试**

Run: `cd server; npx tsc --noEmit -p tsconfig.json`
Expected: no errors。

Run: `cd server; node --test --require ts-node/register test/auth-security.test.ts test/webhook-git.test.ts test/trivy.test.ts test/c3.test.ts`
Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
git add server/src/alerting.ts
git commit -m "feat(alerting): 容器级新增 CPU/内存阈值告警（watch_type=cpu/mem）"
```

---

### Task 5: 后端容器级告警规则检查（路由 + 数据打通）

**Files:**
- Modify: `server/test/c3.test.ts`（补充容器 CRUD 测试）
- Verify: `server/src/routes/notifications.ts`（container-rules 路由本就走 createContainerAlertRule，验证可用）

**Interfaces:**
- Consumes: Task 4 的 create/updateContainerAlertRule（已支持阈值）。
- Produces: 容器规则 CRUD 对 cpu/mem + 阈值的端到端可用性；测试覆盖。

- [ ] **Step 1: 写容器 CRUD 测试**（追加到 test/c3.test.ts）

```ts
import { createContainerAlertRule, updateContainerAlertRule, deleteContainerAlertRule } from '../src/alerting';

test('容器 cpu 规则可创建并持久化阈值', () => {
  const r = createContainerAlertRule({ containerId: 'abc123', watchType: 'cpu', warnThreshold: 70, dangerThreshold: 85 });
  expect(r.watchType).toBe('cpu');
  expect(r.warnThreshold).toBe(70);
  expect(r.dangerThreshold).toBe(85);
  cleanup(r.id);
});

test('容器 cpu 规则阈值越界被拒绝', () => {
  expect(() => createContainerAlertRule({ containerId: 'abc123', watchType: 'cpu', warnThreshold: 150, dangerThreshold: 85 })).toThrow();
});

function cleanup(id: number) {
  try { deleteContainerAlertRule(id); } catch { /* ignore */ }
}
```

- [ ] **Step 2: 跑测试**

Run: `cd server; node --test --require ts-node/register test/c3.test.ts`
Expected: PASS（增加容器 CRUD 用例）。

- [ ] **Step 3: 核查路由**（无需改代码，验证 container-rules 路由透传 body 即可）

`/container-rules` 的 POST/PUT 已调用 createContainerAlertRule/updateContainerAlertRule(req.body)，Task 4 已让这两个函数接受 warnThreshold/dangerThreshold。核查无额外改动。

- [ ] **Step 4: Commit**

```bash
git add server/test/c3.test.ts
git commit -m "test: 覆盖容器 CPU 资源阈值规则 CRUD 与校验"
```

---

### Task 6: 前端告警中心（规则表 + 容器规则）

**Files:**
- Modify: `web/src/pages/notifications.tsx`（AlertRule 类型、host 规则表渲染、ContainerRule 表单与列表）
- Modify: `web/src/pages/notifications.less`（如需单位标注样式）

**Interfaces:**
- Consumes: 后端 `/rules` 返回含 gpu/net（currentPercent 兼容，前端按 type 显示单位）；`/container-rules` 返回含 watchType=cpu/mem + warnThreshold/dangerThreshold + 前端回填当前值。
- Produces: 告警中心展示 GPU/网络规则行；容器规则支持 cpu/mem 监听与阈值输入。

- [ ] **Step 1: 扩展 AlertRule 类型与宿主规则表**

在 notifications.tsx 的 `AlertRule` 类型（L26-38）— 该类型按后端返回结构。后端 `getAlertRules()` 返回的数组项已是 `type/name/enabled/warnThreshold/dangerThreshold/...`，`GET /rules` 再附 `currentPercent`。类型无需新增字段（type 放宽为 string 即可），但前端渲染需按 type 显示单位。核查类型定义，若 type 是字面量联合需放宽。

- [ ] **Step 2: 渲染 GPU/网络 规则行**

宿主规则表格中遍历 `rules`（来自 `/rules`），对每行按 type 渲染单位后缀：

- 阈值输入：GPU 后跟 `%`，网络后跟 `Mbps`
- 当前值列：GPU 显示 `xx%`，网络显示 `xx.x Mbps`（区分方向若后端返回方向则显示，否则按 currentPercent 单值）

在渲染阈值/当前值处增加按 type 映射：

```tsx
const unitOf = (type: string) => (type === 'net' ? 'Mbps' : type === 'gpu' ? '%' : '%');
```

并将当前值展示 `currentPercent`（网络可能为 0，属正常）。

- [ ] **Step 3: 扩展容器规则表单与列表**

`ContainerRule` 类型（types/index.ts L820-858）增 `warnThreshold`/`dangerThreshold` 字段；`ContainerRuleWatchType` 增 `'cpu' | 'mem'`。

公告中心容器规则表格：
- 「监听类型」Select 增加 `cpu`、`mem` 选项（标签「CPU 使用率」「内存使用率」）
- 当选中 cpu/mem 时，显示 warnThreshold/dangerThreshold 两个数字输入（默认 75/90）
- 列表行显示当前使用率（后端需在 `/container-rules` 为 cpu/mem 行附当前值——见 Task 7 后端补充；若后端未附带，则此处仅显示阈值）

新建/编辑弹窗的表单 state 增加 warnThreshold/dangerThreshold 字段并在提交 body 中带上。

- [ ] **Step 4: 构建验证**

Run: `cd web; npx tsc -b`
Expected: no errors。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/notifications.tsx web/src/pages/notifications.less web/src/types/index.ts
git commit -m "feat(web): 告警中心支持 GPU/网络规则与容器 CPU/内存阈值"
```

---

### Task 7: 后端 `/rules` 与 `/container-rules` 当前值补充 + 端到端回归

**Files:**
- Modify: `server/src/routes/notifications.ts`（`/rules` 的 current、`/container-rules` 的当前值回填）
- Modify: `server/src/alerting.ts`（`getContainerAlertRules` 内回填当前值，或新增辅助）

**Interfaces:**
- Consumes: Task 1 的 `MonitorPoint`（gpu、netRate、containerStats）。
- Produces: 前端可展示 GPU 当前利用率、网络当前 Mbps、容器当前 CPU/内存使用率。

- [ ] **Step 1: `/rules` 的 current 补齐 gpu/net**

L182-184 current 对象补：

```ts
    const point = getCurrentMonitor();
    const curGpu = point && point.gpu && point.gpu.length > 0 ? Math.max(...point.gpu.map((g) => g.utilization || 0)) : null;
    const curNet = point && point.netRate ? Math.max(point.netRate.rxMbps, point.netRate.txMbps) : null;
    const current = point
      ? { cpu: point.cpu.percent, mem: point.mem.percent, disk: point.disk.percent, gpu: curGpu, net: curNet }
      : { cpu: null, mem: null, disk: null, gpu: null, net: null };
```

- [ ] **Step 2: `/container-rules` 为 cpu/mem 行回填当前值**

修改 `getContainerAlertRules`（alerting.ts L1002-1015），读取 `getCurrentMonitor().containerStats` 构建 id→usage 映射，给 cpu/mem 规则附加 `currentValue`：

```ts
export async function getContainerAlertRules(): Promise<ContainerAlertRule[]> {
  const docker = await getDockerClient();
  const names = new Map<string, string>();
  try {
    const list = (await docker.listContainers({ all: true })) as any[];
    for (const c of list) {
      const nm = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '') || c.Id.slice(0, 12);
      names.set(c.Id, nm);
    }
  } catch {
    // 忽略，名称回退
  }
  const rules = loadContainerRules(names);
  const point = getCurrentMonitor();
  const statMap = new Map<string, { cpuPercent: number; memPercent: number }>();
  if (point && point.containerStats) {
    for (const cs of point.containerStats) statMap.set(cs.id, { cpuPercent: cs.cpuPercent, memPercent: cs.memPercent });
  }
  for (const r of rules) {
    if (r.watchType === 'cpu' || r.watchType === 'mem') {
      const st = statMap.get(r.containerId);
      (r as any).currentValue = st ? (r.watchType === 'cpu' ? st.cpuPercent : st.memPercent) : null;
    }
  }
  return rules;
}
```

`ContainerAlertRule` 类型（L735）可加可选字段 `currentValue?: number | null` 以承载（非必须，可用 `any` 扩展，但为类型干净建议加）。

- [ ] **Step 3: 跑全量测试**

Run: `cd server; node --test --require ts-node/register test/auth-security.test.ts test/webhook-git.test.ts test/trivy.test.ts test/c3.test.ts`
Expected: 全部通过。

Run 前后端类型检查：
- `cd server; npx tsc --noEmit -p tsconfig.json`
- `cd web; npx tsc -b`

- [ ] **Step 4: 端到端冒烟（启动服务）**

Run（后台）: `cd server; npm run start`（或项目既有 dev 命令）→ 等待就绪。
验证接口：
- `GET /api/notifications/rules` 含 gpu/net 行且 current 含 gpu/net
- `GET /api/notifications/container-rules` 正常返回

Expected: 均 200，结构含新维度。

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/notifications.ts server/src/alerting.ts
git commit -m "feat(notifications): /rules 与容器规则接口补充 GPU/网络/容器当前值"
```

---

### Task 8: 全仓代码审查 + 收尾推送

**Files:**
- 审查整个 C3 分支 diff。

**Interfaces:**
- Consumes: 全部前述任务。

- [ ] **Step 1: 全仓 diff 审查**

Run: `git diff origin/main..HEAD --stat` 与 `git diff origin/main..HEAD`
Expected: 改动集中在 monitor.ts、alerting.ts、storage.ts、notifications.ts、notifications.tsx、types/index.ts、test/c3.test.ts。核查：无密钥泄露、无注入面、类型一致、字段命名跨任务一致（netRate/containerStats/currentValue/warnThreshold/dangerThreshold）。

- [ ] **Step 2: 补充集成测试（可选）**——若端到端冒烟发现 `/container-rules` 当前值或 gpu/net current 结构相关问题，补修。

- [ ] **Step 3: 运行完整测试与双端构建**

Run: `cd server; node --test --require ts-node/register test/auth-security.test.ts test/webhook-git.test.ts test/trivy.test.ts test/c3.test.ts`
Run: `cd server; npx tsc --noEmit -p tsconfig.json`
Run: `cd web; npx tsc -b`

Expected: 全部通过 / 无类型错误。

- [ ] **Step 4: 推送**

```bash
git add -A
git commit -m "docs: 记录 C3 更细粒度告警设计与实现"   # 若 spec/plan 未随代码提交，此处统一提交
git push
```

确认 `origin/main` 已同步（`git rev-parse origin/main` 与 `git rev-parse main` 一致）。

---

## Self-Review 记录

**Spec 覆盖核对：**
- §4.1 monitor 扩展（netRate/containerStats）→ Task 1 ✓
- §4.2 宿主 gpu/net（DEFAULT_RULES、check、fireRecovery、updateAlertRule 白名单）→ Task 3 ✓
- §4.3 容器 resource 规则（watch_type cpu/mem、ALTER 加列、判定、CRUD）→ Task 2 + Task 4 ✓
- §5 数据模型（alert_rules 无需 ALTER、container_alert_rules 加列、alert_records TEXT）→ Task 2/4 ✓
- §6 API（/rules current、/container-rules currentValue）→ Task 5 + 7 ✓
- §7 前端（规则表 GPU/网络、容器规则 cpu/mem）→ Task 6 ✓
- §8 安全边界（nvidia-smi 固定命令、容器 id 匹配、无 GPU 跳过、差分防突刺）→ 内嵌于各 Task ✓
- §9 测试（computeNetRate、evaluateLevel、容器 CRUD、宿主规则自动补齐、端到端）→ Task 1/3/5/7 ✓

**占位符扫描：** 无 TBD/TODO；所有代码步骤含完整代码。
**类型一致性：** `computeNetRate`、`MonitorContainerStat`、`netRate`、`containerStats`、`warnThreshold/dangerThreshold`、`currentValue` 在各任务签名保持一致。

> 已知实现风险提示：GPU 告警的_定制文案_（含 GPU 名/方向）在 Task 3 Step 3 标注为"可接受复用统一文案"，若实现复杂非阻塞；判定与记录/推送正确性优先。
