# docker run → Compose 逆向 · 实施设计（PRD + 技术方案）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档：`docs/competitor-analysis-brainstorm.md` 第一梯队 #3
> 原则：**遵循项目"零第三方运行时依赖、Windows、Node≥22、SQLite"约束**。逆向逻辑为纯函数（可单测），生成的 compose 复用现有 `validateComposeYaml` + `POST /api/compose` 落盘链路，不重复造轮子。

---

## 一、背景与目标

用户经常用 `docker run ...`（或面板"创建容器"）跑起一堆容器后，想**沉淀成可维护的 Compose 工程**。目前这只能靠手工重写 yaml，容易遗漏端口/卷/环境变量，且难以与现有 Compose 模块打通。

本方案提供"**从现存容器一键逆向出 compose yaml**"能力，并打通"预览 → 校验 → 落盘为工程"闭环。

**核心价值**：
1. 极低学习成本，一眼看出"原来这个容器这么配的"。
2. 输出可直接复用现有 Compose 编辑/部署/结构视图链路。
3. 纯函数实现，可单测、零依赖、安全（仅读，不执行任何写操作）。

---

## 二、总体架构

```
浏览器 容器列表/详情页 → "生成 Compose" 按钮
   │  POST /api/compose/infer { containerIds: string[] }
   ▼  （dockerode 只读 inspect，不执行写操作）
server/src/composeInfer.ts  (纯函数：inspect[] → compose yaml 字符串)
   │       ▲
   │       └─ normalize 系列（迁移自 compose.ts 的 normalizePorts/Volumes/Environment/DependsOn，改进复用）
   ▼
 返回 { content, projectName, services: [...] }
   │
   ▼  （浏览器预览编辑器，可编辑）
POST /api/compose  →  validateComposeYaml() → 落盘 COMPOSE_ROOT  →  可在 Compose 页部署
```

- **只读**：逆向过程只用 `getContainer(id).inspect()`，**绝不启动/停止/删除/创建容器**。
- **复用**：逆向输出的 yaml 直接走既有 `POST /api/compose`（含 YAML 校验 + 目录防穿越 + 审计）落盘。
- **零依赖**：yaml 序列化手写（缩进渲染），不引入 yaml 库。

---

## 三、数据流与接口

### 3.1 新增接口（`server/src/routes/compose.ts` 内部新增，复用同文件 asyncHandler）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/compose/infer` | 入参 `{ containerIds?: string[] }`，返回逆向出的 compose 内容与可预览服务概要；`containerIds` 为空时返回**可逆向容器候选列表**（供前端选择） |

- 鉴权：`requireAdmin`（与 `POST /api/compose` 一致，因为逆向结果可一键落盘）。
- 审计：仅逆向预览时可记 `logOperation(..., 'Compose 逆向预览', ...)`；真正落盘已由 `POST /api/compose` 记录，**避免重复审计**。

### 3.2 交互流程

1. 用户在 **容器列表页/多选** 或在 **容器详情页** 点「生成 Compose」。
2. 若未给 `containerIds`：服务端返回当前运行容器候选（`id / name / image / status`），前端弹窗多选。
3. 前端提交 `containerIds` → 拿到 `{ content, projectName, services, warnings }`。
4. 前端编辑器预览 + 可编辑 + 显示"建议项目名" → 点「保存为 Compose 工程」。
5. 保存走既有 `POST /api/compose`（服务端二次 `validateComposeYaml`）。
6. 保存成功 → 跳转/提示可在 Compose 页 `up -d`。

---

## 四、核心模块：`server/src/composeInfer.ts`（新建）

纯函数模块，零依赖，便于单测。入口与辅助函数：

```ts
export interface InferInput {
  id: string;
  Name?: string;                 // 容器名
  Config?: {
    Image?: string;
    Cmd?: string[];
    Entrypoint?: string[];
    Env?: string[];
    Labels?: Record<string, string>;
    User?: string;
    WorkingDir?: string;
    Hostname?: string;
    Tty?: boolean;
    Healthcheck?: { Test?: string[]; Interval?: number; Timeout?: number; Retries?: number };
  };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
    Binds?: string[];
    RestartPolicy?: { Name?: string };
    NetworkMode?: string;
    Privileged?: boolean;
    AutoRemove?: boolean;
    NanoCpus?: number;
    Memory?: number;
    CpusetCpus?: string;
    CpuShares?: number;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Target?: string; RW?: boolean }>;
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID?: string; Aliases?: string[] }>;
  };
}

export interface InferService {
  name: string;
  image: string;
  ports: Array<{ published?: string; target?: string; protocol?: string }>;
  volumes: Array<{ type: string; source?: string; target: string; readOnly?: boolean }>;
  environment: string[];
  networks: string[];
  labels: Record<string, string>;
  // 可选：command / entrypoint / user / working_dir / restart / privileged / deploy::resources
}

/** 主入口：多个容器 inspect → compose 对象（内部含服务命名去重、端口/卷归一化、网络归集） */
export function inferCompose(inputs: InferInput[], opts?: { projectName?: string }): {
  projectName: string;
  services: InferService[];
  yaml: string;
  warnings: string[];
};

/** 纯函数：把 services 渲染为 compose yaml 字符串（手写缩进，无 yaml 库） */
export function renderComposeYaml(services: InferService[], volumes: string[], networks: string[]): string;

/** 纯函数：单容器 inspect → InferService（拆出便于单测） */
export function inferService(input: InferInput): InferService;
```

### 4.1 映射规则（核心算法）

| inspect 字段 | compose 字段 | 处理 |
|--------------|-------------|------|
| `Config.Image` | `image` | 必填；缺失则 `warning` 并跳过该容器 |
| `Config.Cmd` | `command` | 非空且非"镜像默认"时输出数组形式 |
| `Config.Entrypoint` | `entrypoint` | 数组形式 |
| `Config.Env` | `environment` | 过滤掉 compose 自动注入的 `PATH`、`HOSTNAME`、`HOME`、`TERM` 等平台默认变量（降低噪音） |
| `Config.User` | `user` | 非空输出 |
| `Config.WorkingDir` | `working_dir` | 非空输出 |
| `Config.Hostname` | `hostname` | 仅当显式设置时输出 |
| `Config.Labels` | `labels` | **过滤**掉 compose 自动写入的 `com.docker.compose.*` 与 `org.opencontainers.image.title` 等面板/运行时标签 |
| `Config.Healthcheck` | `healthcheck` | 仅当 `Test` 存在时输出（Test/Interval/Timeout/Retries），Interval/Timeout 从 ns→s |
| `HostConfig.PortBindings` | `ports` | 见下方端口规则 |
| `HostConfig.Binds` / `Mounts` | `volumes` | 见下方卷规则 |
| `HostConfig.RestartPolicy.Name` | `restart` | `no`→省略；其余原样 |
| `HostConfig.Privileged` | `privileged` | 仅 true 时输出 |
| `HostConfig.NetworkMode` | `network_mode` / `networks` | `default`→省略；`bridge`/`host`/`none`→`network_mode`；自定义网络→归集到 `networks` 段 |
| `HostConfig.NanoCpus/Memory` | `deploy.resources.limits` | 二者任一非 0 时输出；`NanoCpus`→`cpus`（n→数值）、`Memory`→`memory`（bytes→"4g" 人类可读） |
| `Config.AutoRemove` | `--rm` 等价 | 写 `warning`：compose 无 `--rm` 语义，提示用户 |

**端口规则**（迁移并增强 `normalizePorts`）：
- 遍历 `PortBindings`：key=`"80/tcp"` → `target=80, protocol=tcp`；value[0] 的 `HostPort`→`published`；`HostIp` 非 `0.0.0.0` 且非空时记录 `published_ip` 写 `warning`。
- 生成 `"8080:80"`（published:target）形式；协议非 tcp 时补 `/udp`。

**卷规则**（迁移并增强 `normalizeVolumes`）：
- 用 `Mounts` 为主（结构清晰：`Type/Source/Target/RW`），`Binds` 兜底。
- `Type='volume'`（named volume）→ 归集到顶层 `volumes:` 段，服务内用 `"<volname>:/target"`。
- `Type='bind'` → 服务内用 `"/host:/target[:ro]"`。
- `RW===false` → 追加 `:ro`。
- 匿名卷（`Source` 为空的长 hash）→ 写 `warning` 并跳过（无法在 compose 稳定表达）。

**网络规则**：
- 自定义网络名归集为 `networks:` 顶层段；服务内 `networks: [name]`。
- 把已过滤的 `com.docker.compose.*` 标签里的 project 名建议为 `projectName`（若有）。

### 4.2 服务命名

- 优先用容器名（去非法字符：`_`/`-`/字母/数字，非字母开头补前缀 `svc_`）。
- 重名去重：追加 `-2`、`-3`。
- `projectName` 默认 `inferred-<时间戳>`，或从 compose label 的 project 推导。

### 4.3 渲染 `renderComposeYaml`

手写缩进（2 空格），结构顺序稳定：`services:` → 每服务 `image/command/entrypoint/environment/ports/volumes/networks/labels/healthcheck/restart/…` → 顶层 `volumes:` / `networks:`。**输出稳定、可 diff、可直接被 `validateComposeYaml` 解析。**

---

## 五、路由接入：`server/src/routes/compose.ts`

在现有文件新增一个 endpoint（复用同文件 `asyncHandler`、`requireAdmin`、`logOperation`、`validateComposeYaml`）：

```ts
router.post('/infer', requireAdmin, asyncHandler(async (req, res) => {
  const docker = getDockerClient();                  // 复用 docker/client.ts（需先确认导出）
  const ids = Array.isArray(req.body?.containerIds) ? req.body.containerIds : [];
  const inputs: InferInput[] = [];
  if (ids.length === 0) {
    // 未指定：返回可逆向的候选容器列表（不含停止态？含全部 running）
    const list = await docker.listContainers({ all: true });
    return res.json({ candidates: list.map(c => ({ id: c.Id, name: c.Names?.[0]?.replace(/^\//,'') || c.Id.slice(0,12), image: c.Image, status: c.Status })) });
  }
  for (const id of ids) {
    const c = docker.getContainer(String(id));
    const insp = await c.inspect();
    inputs.push(insp as InferInput);
  }
  const { projectName, services, yaml, warnings } = inferCompose(inputs);
  // 用既有校验器先本地校验（不落盘），更早暴露语法问题
  const validateError = await validateComposeYaml(yaml);
  res.json({
    projectName, services,
    content: yaml,
    warnings,
    valid: !validateError,
    validateError: validateError || undefined,
  });
}));
```

> 注：`getDockerClient` 需确认从 `./docker/client` 导出位置（README 有 `client.ts`；若未导出则用现有各路由的 `getDockerClient()` 风格补一个导出，改动最小）。

---

## 六、前端实现

按项目约定（三注册法 + 通用组件 + 三段式 + BEM）。

### 6.1 触发入口
- **容器列表页**（`web/src/pages/containers.tsx`）：工具栏加「生成 Compose」按钮 → 打开多选弹窗（若未传 id）→ 调 `/api/compose/infer`。
- **容器详情页**（`web/src/pages/containerdetail.tsx`）：操作区加「生成 Compose」→ 直接带该容器 id 调 `/api/compose/infer`。

### 6.2 结果预览（新建 `web/src/components/ComposeInferModal.tsx`）
- 复用现有 `Modal` / `TextArea` / `Button` / `Toast` / `Card`。
- 布局：上方 `projectName` 输入（默认值）+ 中间 `content` 只读/可编辑文本域 + 下方 `services` 概要标签（图标+服务名）+ `warnings` 黄色提示列表。
- 「保存为 Compose 工程」→ `POST /api/compose { name: projectName, content }`（复用既有校验/落盘/审计），失败时展示后端 `validateError`。

### 6.3 类型（`web/src/types/index.ts` 追加）
```ts
export interface ComposeInferCandidate { id: string; name: string; image: string; status?: string; }
export interface ComposeInferResult {
  projectName: string;
  services: Array<{ name: string; image: string; ports: string[]; networks: string[] }>;
  content: string;
  warnings: string[];
  valid: boolean;
  validateError?: string;
}
```

### 6.4 less
`web/src/components/ComposeInferModal.less`（BEM：`compose-infer__*`），侧边/预览区响应式。

---

## 七、安全与合规要点

1. **只读**：逆向只调用 `inspect()`，**无任何 Docker 写操作**；落盘统一走既有 `POST /api/compose`（已含 `validateComposeYaml` + 目录防穿越 + `requireAdmin` + 审计）。
2. **源字段校验**：所有来自 inspect 的字符串在拼进 yaml 前做转义/类型收窄，规避 YAML 注入（如含 `:`/`#` 的取值，key 换行等）。
3. **RBAC**：逆向预览与落盘均 `requireAdmin`。
4. **不泄漏敏感 env**：`environment` 默认完整回显（与容器详情页一致）；如需可后续加"敏感值脱敏开关"（留档，本期不做）。
5. **审计**：落盘由既有 `POST /api/compose` 记录，不重复。

---

## 八、任务拆分（可独立验收）

| # | 任务 | 涉及文件 | 验收 |
|---|------|----------|------|
| T1 | 写 `composeInfer.ts`：inferService + inferCompose + renderComposeYaml（纯函数） | 新建 `server/src/composeInfer.ts` | 单测：含端口/卷/env/网络/健康检查/资源限制的综合 inspect → 期望 yaml 精确匹配；匿名卷等边界出 warning |
| T2 | 接入 `POST /api/compose/infer`（候选列表 + 逆向 + 本地校验） | `server/src/routes/compose.ts`（+ 确认 `getDockerClient` 导出） | 无 id → 返回候选；带 id → 返回 content/services/warnings/valid |
| T3 | 前端 `ComposeInferModal` + 容器列表/详情入口 | 新建 `web/src/components/ComposeInferModal.tsx`(`.less`)、改 `web/src/pages/containers.tsx`、`containerdetail.tsx` | 多选 → 预览可编辑 → 保存落盘成功 |
| T4 | 类型 + 编译 + 回归 | `web/src/types/index.ts` | `npm run build` 无类型错误；`dev:server`/`dev:web` 正常；保存走的仍是既有 `/api/compose` |
| T5 | 端到端验证 | 手测 + 现有回归脚本 | 对一个真实运行容器逆向 → 保存 → 在 Compose 页 `up -d` 可复现；原有 Compose 功能零回归 |

**依赖顺序**：T1→T2→T4（后端闭环）∥ 前端 T3 依赖 T2；T5 收尾。

---

## 九、后续扩展（本期不做，留档）

- **批量多容器合并**：把多个 `docker run` 容器逆向成**一个** compose 工程（T1 已支持多输入，前端可先开放多选）。
- **敏感 env 脱敏开关**：逆向时对已知变量名（`PASSWORD`/`SECRET`/`TOKEN`/`KEY`）脱敏为 `${VAR}` 占位。
- **Compose ↔ 现状 diff**：逆向结果与 `docker-compose config` 现状比对，标出漂移。
- **平台差异字段**：`device_requests`(GPU)/`sysctls`/`cap_add` 等高级字段映射补全。
- **导出为几套模板**：与 `composeTemplates` 结合，一键存为团队模板。

---

## 十、验证清单

1. 对 `nginx`（暴露 8080、挂载卷、设 env、自定义名）逆向 → yaml 含 `8080:80`、卷、env、`restart`，可通过 `validateComposeYaml`。
2. 匿名卷 / `--rm` 容器 → 输出 `warning` 而非报错。
3. 自定义网络容器 → 顶层 `networks:` 与服务 `networks:` 正确归集。
4. 安全：逆向过程无写操作；落盘走的既有校验/防穿越/审计链路。
5. 回归：`npm run build` 通过；容器/Compose 既有页面零回归。
