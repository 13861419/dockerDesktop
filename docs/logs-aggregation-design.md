# 日志聚合中心 · 实施设计（PRD + 技术方案）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档：`docs/competitor-analysis-brainstorm.md` 第二梯队 #5
> 原则：**复用现有 `GET /api/containers/:id/logs`（tail/since/until 分页）与 `compose logs` 能力**，做跨容器统一检索聚合，不重复造轮子。零第三方依赖。

---

## 一、背景与目标

排障时往往要在**多个容器之间**对比日志、按关键字检索跨容器命中。现状只有单容器日志查看与下拉，无法跨容器聚合检索。本方案新增「日志聚合中心」：

1. **跨容器统一检索**：多选容器 → 合并日志 → 关键字/容器过滤 → 时间线排序。
2. **语法高亮与上下文**：命中关键字高亮、每行带容器标签与时间戳、上下文（前后 N 行）。
3. **导出**：过滤结果导出为 `.log` / `.txt`（复用现有 `download` 封装）。
4. **（可选对接）AI 日志分析**：聚合结果一键送入 AI 助手总结（依赖 `ai-assistant-design.md`，本期做接口预留）。

---

## 二、总体架构

```
浏览器 日志聚合中心 /logs
   │  GET /api/system/container-logs?containerIds=a,b&since=&until=&keyword=&tailPer=&streams=
   ▼  （服务端对每个容器并发调用 dockerode container.logs，合并 + 输出已带容器名）
server/src/routes/logs.ts（新建）   →  复用 containers.ts 的 demuxBufferToText（或抽为共享 util）
   ▼
  返回 { lines: [{ ts, container, stream, text }], truncated, matched }
```

- **只读**：全部为只读 `container.logs`，无任何写操作。
- **复用**：容器名/流解析逻辑从 `containers.ts` 抽为 `server/src/docker/logUtil.ts` 共享。
- **零依赖**：不变更 dockerode 用法。

---

## 三、接口与核心模块

### 3.1 共享工具 `server/src/docker/logUtil.ts`（新建，从 containers.ts 抽出复用）

```ts
/** 解析 dockerode 多路复用日志 Buffer → 行数组（迁移 containers.ts 的 demuxBufferToText，拆出按流分组） */
export function demuxLogToLines(
  buf: Buffer,
  tty: boolean,
): Array<{ stream: 'stdout' | 'stderr'; ts?: number; text: string }>;

/** 单容器拉取日志（tail/since/until 透传），返回标准化行 + 容器名 */
export async function fetchContainerLog(
  docker: Dockerode,
  containerId: string,
  opts: { tail?: number; since?: number; until?: number; timestamps?: boolean },
): Promise<{ name: string; lines: Array<{ stream: 'stdout'|'stderr'; ts?: number; text: string }> }>;
```

> 说明：`containers.ts` 现有 `demuxBufferToText` 是它自己内部函数；抽到 `logUtil.ts` 后 `containers.ts` 改 import（不改变其对外行为），保持一处解析逻辑。

### 3.2 新路由 `server/src/routes/logs.ts`（新建，挂 `/api/logs`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/logs/containers` | 返回可作为检索源的容器候选（复用 listContainers，含 name/image/status） |
| GET | `/api/logs/query` | **核心聚合查询** |
| GET | `/api/logs/query/download` | 导出当前过滤结果 |

**`/api/logs/query` 参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| containerIds | string | 逗号分隔的容器 id（必填，≥1） |
| since / until | number | Unix 秒，透传日志范围 |
| tailPer | number | 每容器尾部行数，默认 500，上限 5000 |
| keyword | string | 可选，客户端过滤关键字（大小写不敏感；支持简单 `|` 或正则？首期用子串匹配） |
| streams | string | 逗号分隔 `stdout,stderr`，默认两者 |

**合并输出**：跨容器**并发**拉取（`Promise.all`），合并后按 `ts ?? 序号` 升序排序，每行 `{ ts, container, stream, text }`。返回 `{ lines, total, truncated: bool, matched: bool }`。

**限流/安全**：容器数上限 20；`tailPer` 上限 5000；`since/until` 校验为有限数；防止超大响应用 `total` 截断 + 前端虚滚动（只需渲染可视区）。

**鉴权**：`requireAuth`（日志聚合为只读，operator/普通用户可用）；`download` 同 `requireAuth`。

### 3.3 路由挂载（`server/src/app.ts`）

```ts
import logsRouter from './routes/logs';
// ...
app.use('/api/logs', requireAuth, logsRouter);
```

---

## 四、前端实现

| 文件 | 说明 |
|------|------|
| 新建 `web/src/pages/logs.tsx` | 聚合检索页 |
| 新建 `web/src/pages/logs.less` | 样式（`logs__*` BEM） |
| 改 `web/src/App.tsx`、`web/src/components/Layout.tsx` | 注册 `/logs` 菜单与路由 |

### 页面布局
- **顶部筛选区**：容器多选（下拉 + 搜索，数据来源 `/api/logs/containers`）+ 时间范围（快捷：最近 5m/1h/24h/7d）+ 关键字 + streams 勾选 + 刷新。
- **结果区**：虚拟滚动列表。每行 `<时间戳> [容器名] (stdout|stderr)  <高亮命中文本>`；`keyword` 命中处 `<mark>` 高亮；`stderr` 行红色。
- **上下文**：点某行「展开 ±5 行上下文」（用 `keyword` 命中定位后向前后补拉——首期可基于已加载内存行实现，避免额外请求）。
- **导出**：`download('/api/logs/query/download?...', 'logs.txt')`（复用 `api/client.ts` 的 `download`）。
- **AI 分析入口（预留）**：若 `ai` 已配置，显示「分析日志」按钮，把聚合文本投给 `/api/ai/chat { tool:'logs' }`（本期仅预留按钮与空态，依赖 AI 文档 T3 完成后接线）。

### 类型（`web/src/types/index.ts`）
```ts
export interface LogSourceContainer { id: string; name: string; image: string; status?: string; }
export interface LogLine { ts?: number; container: string; stream: 'stdout' | 'stderr'; text: string; }
export interface LogsQueryResponse { lines: LogLine[]; total: number; truncated: boolean; matched: boolean; }
```

### 三段式渲染
`loading ? <SkeletonRows> : error ? <Empty kind="error"> : lines.length===0 ? <Empty title="无日志"> : <虚拟滚动列表>`。

---

## 五、安全与合规

1. **只读**：全链路只调 `container.logs`，无写操作；导出为只读 CSV/文本。
2. **资源限制**：容器数 ≤20、tailPer ≤5000、since/until 校验，防超大响应与资源耗尽。
3. **关键字过滤**：仅子串匹配（首期），避免正则 ReDoS；后续如需正则需加复杂度上限。
4. **RBAC**：只读，`requireAuth` 即可；无新增敏感面。

---

## 六、任务拆分（可独立验收）

| # | 任务 | 涉及文件 | 验收 |
|---|------|----------|------|
| T1 | 抽 `logUtil.ts`（demux 按流 + fetchContainerLog）并让 containers.ts 复用 | 新建 `server/src/docker/logUtil.ts`、改 `server/src/routes/containers.ts` | 单容器日志行为与之前一致；`convert` 无回归 |
| T2 | 写 `logs.ts` 路由（候选/聚合查询/下载） | 新建 `server/src/routes/logs.ts`、`server/src/app.ts` | 多容器并发聚合、排序、截断、下载正常 |
| T3 | 前端聚合页 + 虚拟滚动 + 高亮 + 导出 | 新建 `web/src/pages/logs.tsx`(`.less`)、改 `App.tsx`/`Layout.tsx` | 多选检索、关键字高亮、导出下载正常 |
| T4 | 类型 + 编译 + 回归 | `web/src/types/index.ts` | `npm run build` 通过；容器页日志零回归 |
| T5 | 端到端验证 | 手测 + 现有回归 | 对 2+ 容器关键字检索命中、时间线正确；无写操作 |

**依赖顺序**：T1→T2→T4 ∥ T3 依赖 T2；T5 收尾。

---

## 七、验证清单

1. 对 2 个容器的 `tailPer=200` 聚合 → 正确合并并按时间排序；`keyword` 检索命中并高亮。
2. `since/until` 生效；`streams=stderr` 只回 stderr。
3. 单容器日志原页面 + 现有 `docker compose logs` 无回归（logUtil 抽取后）。
4. 资源限制触发（>20 容器）时返回友好错误。
5. `npm run build` 通过；容器/Compose 既有页面零回归。
