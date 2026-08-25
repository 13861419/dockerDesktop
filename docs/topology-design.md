# 网络拓扑可视化 · 实施设计（PRD + 技术方案）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档：`docs/competitor-analysis-brainstorm.md` 第一梯队 #4
> 与现有 roadmap D1「跨引擎批量操作 + 网络拓扑」互补：本文聚焦**拓扑数据模型与纯前端渲染**，不做跨引擎批处理。
> 原则：**数据源全部复用现有 dockerode 接口；渲染纯前端 SVG/Canvas，零第三方依赖**（不引入 d3/cytoscape 等重库）。

---

## 一、背景与目标

多引擎/多容器场景下，运维需要对"容器 ↔ 网络 ↔ 端口 ↔ 依赖"关系有**全局直观视图**。现状单页面只有列表，缺少拓扑。目标：

1. **拓扑图**：节点 = 容器（含状态着色），边 = 所属网络 / 端口依赖 / compose 依赖。
2. **交互**：点击节点看详情（侧滑面板）、按网络/引擎分组、高亮异常节点（Exited / 非健康）。
3. **联动**：从既有容器/网络页一键进入拓扑。

---

## 二、总体架构

```
浏览器 拓扑图 /topology?engine=<endpoint>
   │  GET /api/topology?engine=<endpoint>
   ▼
server/src/routes/topology.ts（新建）
   ├─ docker.listContainers({all:true})   → 容器节点 + 状态
   ├─ docker.listNetworks()               → 网络节点
   ├─ 每容器 docker.getContainer(id).inspect() → 网络归属 / 端口 / 依赖（compose 项目）
   └─ 组装 TopologyGraph（纯前端可直接消费，含 layout 提示）
   ▼
web/src/pages/topology.tsx（纯前端力导向 SVG/Canvas 渲染，节点拖拽/缩放/高亮）
```

- **数据层**：`GET /api/topology` 只做聚合与归一，**不含业务渲染**；图布局/交互全在前端。
- **性能**：容器数多时 `inspect` 为并发 `Promise.all`，但限制最大容器数（如 ≤200），超限提示改用分网络视图。

---

## 三、数据模型

### 3.1 路由 `server/src/routes/topology.ts`（新建，挂 `/api/topology`）

```ts
GET /api/topology?engine=<endpoint>
// engine 缺省用当前引擎（getDockerClient）；指定则 getDockerClientForEndpoint
```

返回（**纯数据，前端渲染**）：

```ts
export interface TopoNode {
  id: string;                 // 容器 id / 网络 id
  kind: 'container' | 'network';
  label: string;              // 容器名 or 网络名
  status?: 'running' | 'exited' | 'created' | 'restarting' | 'paused' | 'dead';
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  image?: string;
  projectName?: string;       // 从 com.docker.compose.project label 推导
  ports?: Array<{ published?: string; target: string; protocol: string }>;
  engine?: string;
}
export interface TopoEdge {
  from: string; to: string;
  kind: 'network' | 'depends';
}
export interface TopologyGraph {
  nodes: TopoNode[];
  edges: TopoEdge[];
  networks: string[];        // 便捷分组
  truncated?: boolean;       // 超限提示
}
```

### 3.2 边（Edge）推导

| 边类型 | 来源 | 说明 |
|--------|------|------|
| `network` | `inspect.NetworkSettings.Networks.*` | 容器 → 所属网络节点 |
| `depends` | compose 项目内服务依赖（或若可从 label 推断的启动依赖） | 可联动 `container_dependencies` 表生成容器间依赖边 |

### 3.3 异常判定
- 节点 `status !== 'running'` 或 `health === 'unhealthy'/'starting'` → 前端标红/闪烁。
- 复用 `aggregate.ts` 容错思想：某个 inspect 失败只跳过该容器，不影响整体。

---

## 四、前端实现（`web/src/pages/topology.tsx`）

- **引擎切换**：顶部下拉（复用 `/api/aggregate/engines` 拿引擎列表）或用当前引擎。
- **渲染**：纯 `<svg>`，**手写力导向**（简单的斥力 + 弹簧布局，迭代 N 次即可，够用）或分层布局（网络在上、容器在下）。无第三方图库。
- **交互**：节点拖拽、滚轮缩放/平移（viewBox + transform）、点击 → 侧滑详情面板（复用现有 `Modal`/`Card`）。
- **筛选**：按网络/引擎/状态过滤；`keyword` 搜索容器名高亮。
- **入口**：在容器页、网络页各加"拓扑"按钮跳 `/topology?focus=<id>`（高亮对应节点）。
- **类型**：`web/src/types/index.ts` 加 `TopologyGraph`/`TopoNode`/`TopoEdge`。

### 注册
`App.tsx` lazy(`./pages/topology`) + `<Route path="/topology" .../>`；`Layout.tsx` NAV_ITEMS 加「拓扑」。

---

## 五、安全与合规

1. **只读**：全链路 `listContainers`/`listNetworks`/`inspect`，无写操作。
2. **资源限制**：`inspect` 并发上限 + 最大节点数（200），超限 `truncated:true` 并提示。
3. **鉴权**：`requireAuth`（只读，operator/普通用户可见）。

---

## 六、任务拆分

| # | 任务 | 涉及文件 | 验收 |
|---|------|----------|------|
| T1 | 写 `topology.ts` 路由（聚合/归一/限流） | 新建 `server/src/routes/topology.ts`、`server/src/app.ts` | 多容器/网络返回正确 nodes+edges；单容器 inspect 失败不整体失败 |
| T2 | 写拓扑页（手写 SVG 布局 + 交互 + 详情） | 新建 `web/src/pages/topology.tsx`(`.less`)、改 `App.tsx`/`Layout.tsx` | 图渲染、拖拽/缩放/点击详情、异常高亮正常 |
| T3 | 类型 + 编译 + 回归 | `web/src/types/index.ts` | `npm run build` 通过；容器/网络页零回归 |
| T4 | 入口 + 端到端验证 | 改容器/网络页、手测 | focus 高亮、引擎切换、超限提示正常 |

**顺序**：T1→T2→T3 ∥ T4；收尾。

---

## 七、验证清单

1. 多个运行容器所属网络 → 网络边正确；stop 容器节点红色。
2. compose 多服务 → depends 边显示；点击节点详情含端口。
3. 单引擎离线/单容器 inspect 失败 → 不崩，跳过。
4. >200 容器 → `truncated` 提示。
5. `npm run build` 通过；既有页面零回归。
