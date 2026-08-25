# 镜像 GC 策略（策略化自动回收）· 实施设计（PRD + 技术方案）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档：`docs/competitor-analysis-brainstorm.md` 第二梯队 #6
> 原则：**复用现有 scheduler（`registerTaskHandler`）+ `image_pull_history`（拉取时间）+ `images.ts` 的 prune/列表逻辑**，把"手动/定时全量清理"升级为"按策略自动回收"。零第三方依赖。

---

## 一、背景与目标

现有 `prune` 计划任务只能全量清理悬空/未使用镜像。生产环境中更常见的是「**按策略保留最近 N 个标签版本**」「**清理超过 X 天的未被引用的镜像**」「**构建缓存 TTL**」。本方案在现有任务系统上扩展一套**镜像 GC 策略**：

1. **保留 N 个**：对每个 `repo` 按镜像创建时间排序，仅保留最近 `keep` 个 tag（历史版本超过即删）。
2. **按年龄**：清理创建时间超过 `olderThanDays` 且未被任何容器引用的镜像。
3. **悬空/缓存**：已有的 dangling 清理 + buildCache TTL 组合。
4. **预演（dry-run）**：先算"将被清理清单"供确认，再执行。

**两种使用形态**：
- **一次性体检页**（`/gc`）：选择策略 → dry-run 预览 → 确认清理。
- **定时策略**：在计划任务里新增 `imageGc` 任务类型，按 cron 自动执行（复用 scheduler）。

---

## 二、总体架构

```
浏览器 /gc 或 计划任务
   │  POST /api/gc/plan   { keepPerRepo?, olderThanDays?, pruneDangling?, pruneBuildCache?, preview:true }
   ▼
server/src/routes/gc.ts（新建）
   ├─ 列表：docker.listImages({ all:false }) + image_pull_history（最近使用时间）
   ├─ 引用判定：docker.listContainers({all:true}) 收集被引用 ImageId 集
   ├─ planGc()（纯函数，可单测）：按 keepPerRepo/olderThanDays 算候选 + 危险(在用)排除
   └─ 执行：对候选逐 remove({force:false})，复刻并增强 images.ts prune 的回收汇总
同时：scheduler 注册新 handler 类型 'imageGc'（复用 runPruneHandler 模式）
```

- **只读优先**：`/api/gc/plan` 仅计算不删除；`/api/gc/run` 才执行（前端二次确认）。
- **安全**：**绝不删除被容器引用的镜像**（即使在用集合有误，删除也会被 Docker 拒绝并捕获）。

---

## 三、数据与核心模块

### 3.1 复用对象

| 复用点 | 来源 |
|--------|------|
| 镜像列表 + 拉取时间 | `images.ts` 的 `docker.listImages({all})` + `image_pull_history.ts` 的 `getPullTime` |
| 悬空判断 / prune filters | `images.ts` 的 `/prune`（modem dial 正确 filters） |
| 定时注册 | `scheduler.ts` 的 `registerTaskHandler(type, fn)`（`tasks.ts` 已注册 5 类，新增第 6 类） |
| 审计 | `operationLog.ts` 的 `logOperation` |

### 3.2 核心模块 `server/src/gc.ts`（新建，纯函数可单测）

```ts
export interface GcImage {
  id: string;
  repoTags: string[];       // ["nginx:1.25"]
  created: number;          // 秒
  lastPullAt?: number;      // 最近拉取时间（秒）
  usedByContainers: boolean;
  dangling: boolean;        // repoTags 为空
  size: number;
}

export interface GcPolicy {
  keepPerRepo?: number;     // 每 repo 保留最近 N 个 tag（按 created 排序）
  olderThanDays?: number;   // 超过该天数才考虑删（按 created，且 lastPullAt 也超时才算闲）
  pruneDangling?: boolean;  // 清理悬空（无标签）
  pruneBuildCache?: boolean;// 清理构建缓存（modem dial /build/prune?all=true）
  onlyUnused?: boolean;     // 默认 true：绝不删 usedByContainers
}

export interface GcPlan {
  candidates: GcImage[];       // 将被清理
  keepers: GcImage[];          // 被保留（有容器引用或未超龄/未超 N）
  skipped: Array<{ name: string; reason: string }>;  // 因在用/被 keep 跳过，便于解释
  totals: { toFree: number; bytes: number };
  warnings: string[];
}

/** 纯函数：根据策略计算清理计划（不执行任何删除） */
export function planGc(images: GcImage[], policy: GcPolicy): GcPlan;
```

**planGc 逻辑**：
1. `usedByContainers` 的镜像 → 永远进 `keepers`（并记 `skipped` 原因"有容器引用"）。
2. `keepPerRepo`：按 `repo`（`RepoTags[i].split(':')[0]`）分组 → 按 `created` 降序 → 保留前 `keep` 个 tag → 其余（若该 tag 无容器引用）进 `candidates`。
3. `olderThanDays`：`created` 超过阈值 **且**（有 `lastPullAt` 时也超过阈值）→ 未被 keep 者进 `candidates`。
4. `pruneDangling`：`dangling` 且无引用 → 进 `candidates`。
5. `pruneBuildCache`：仅计 `totals`（build prune 是独立 modem 调用，非镜像删除，单独汇总）。
6. 输出 `warnings`：如"检测到 N 个有引用镜像被策略跳过（安全保留）"。

### 3.3 路由 `server/src/routes/gc.ts`（新建，挂 `/api/gc`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/gc/plan` | 计算策略清理计划（**不删除**），返回 `GcPlan` |
| POST | `/api/gc/run` | 执行清理（body 同 policy；二次确认由前端保证），按 plan 逐镜像 `remove` + build prune，返回删除清单与回收空间并写审计 |

- 鉴权：`requireAdmin`（删除不可逆）。
- 安全：`run` 内部重算一次 `planGc` 作为防线（即使前端跳过了 plan，服务端仍不删在用镜像）。
- 审计：`logOperation(..., '镜像GC策略清理', ...)` + 删除清单。

### 3.4 定时任务类型 `imageGc`（`server/src/routes/tasks.ts` 新增 handler）

```ts
registerTaskHandler('imageGc', async (task, config) => {
  // config: { keepPerRepo, olderThanDays, pruneDangling, pruneBuildCache }
  const plan = await computePlan(config);        // 复用 gc.ts 的 plan 逻辑
  const result = await executePlan(plan, config);// 复用 run 的删除逻辑（无前端二次确认，走定时）
  return { ok: true, detail: summarize(plan, result) };
});
```

**定时语义**：predicted/keep 策略在定时执行时**直接执行**（无人值守），但 `skipped` 明细与删除清单写入 `last_detail`，便于事后审计回看。

---

## 四、前端实现

| 文件 | 说明 |
|------|------|
| 新建 `web/src/pages/gc.tsx` | 镜像 GC 策略页 |
| 新建 `web/src/pages/gc.less` | 样式（`gc__*`） |
| 改 `web/src/App.tsx`、`Layout.tsx` | 注册 `/gc` 菜单 |

### 页面
- **策略配置**：卡片表单（`keepPerRepo` 数字 / `olderThanDays` 数字 / 开关 `pruneDangling` / `pruneBuildCache`）。
- **「预演清理」**：→ `POST /api/gc/plan` → 展示三区：`candidates`（可清理，勾选/全选）、`keepers`（将被保留，含原因）、`skipped`（引用中，灰置 + 原因）。
- **「确认清理」**：仅当已预演且 `candidates` 非空时可用；Trigger 二次确认 `ConfirmDialog` → `POST /api/gc/run` → Toast 结果（`释放空间: xx`）。
- 计划任务页的 `imageGc` 类型在新建任务弹窗里动态渲染同款策略表单（复用 `tasks.tsx` 的动态表单机制）。

### 类型（`web/src/types/index.ts`）
```ts
export interface GcPolicy { keepPerRepo?: number; olderThanDays?: number; pruneDangling?: boolean; pruneBuildCache?: boolean; onlyUnused?: boolean; }
export interface GcImage { id: string; repoTags: string[]; created: number; size: number; dangling: boolean; usedByContainers: boolean; }
export interface GcPlan { candidates: GcImage[]; keepers: GcImage[]; skipped: Array<{ name: string; reason: string }>; totals: { toFree: number; bytes: number }; warnings: string[]; }
export interface GcRunResult { ok: boolean; deleted: string[]; spaceReclaimed: number; detail: string; }
```

---

## 五、安全与合规

1. **在用保护**：服务端 `run` 重算 `planGc`，`usedByContainers` 永不入删除集（双重防线）。
2. **增删策略约束**：`keepPerRepo ≥ 0`、`olderThanDays ≥ 0`、上限校验（防误配置全删）。
3. **只读预演**：`/api/gc/plan` 不删除；`/api/gc/run` 才删除且需 `requireAdmin` + 审计。
4. **buildCache**：删除仅限构建缓存（modem `/build/prune?all=true`），不触其他。

---

## 六、任务拆分（可独立验收）

| # | 任务 | 涉及文件 | 验收 |
|---|------|----------|------|
| T1 | 写 `gc.ts` 纯函数（planGc + 引用收集 + 汇总） | 新建 `server/src/gc.ts` | 单测：keepPerRepo/olderThanDays/dangling/在用保护各场景精确匹配 |
| T2 | 写 `gc.ts` 路由（plan/run，run 内重算防线） | 新建 `server/src/routes/gc.ts`、`server/src/app.ts` | plan 不删除；run 不删在用；释放空间合计正确 |
| T3 | 注册 `imageGc` 定时任务 handler | 改 `server/src/routes/tasks.ts` | 新建 imageGc 任务按 cron 执行并写审计/历史 |
| T4 | 前端 GC 策略页 + 预演/确认 + 计划任务表单 | 新建 `web/src/pages/gc.tsx`(`.less`)、改 `App.tsx`/`Layout.tsx`/`tasks.tsx` | 预演三区展示、二次确认、计划任务复用表单 |
| T5 | 类型 + 编译 + 回归 | `web/src/types/index.ts` | `npm run build` 通过；镜像/存储/计划任务既有页零回归 |

**依赖顺序**：T1→T2→T4 ∥ T3 依赖 T1；T5 收尾。

---

## 七、验证清单

1. 同一 `repo` 配 `keepPerRepo=2` → plan 只保留最近 2 个 tag，其余进 candidates。
2. 有容器引用的镜像配 `olderThanDays=1` → 进 keepers/skipped（安全保留），run 后仍在。
3. dry-run 不删除；确认 run 后 `/api/images` 列表与空间反映正确。
4. 计划任务 `imageGc` 定时执行正确并写 `last_detail` 与审计。
5. `npm run build` 通过；镜像、存储、计划任务既有页面零回归。
