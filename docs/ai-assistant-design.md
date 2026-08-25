# AI 智能助手 · 实施设计（PRD + 技术方案）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档：`docs/competitor-analysis-brainstorm.md` 第一梯队 #1
> 原则：**遵循项目"零第三方运行时依赖、Windows、Node≥22、SQLite"约束**。AI 能力做成**可选开关**，未配置时不引入任何常驻依赖，UI 优雅隐藏。

---

## 一、背景与目标

主流面板（如 1Panel）已上线 AI 助手，是当前最大差异化空白。本方案为 Docker 管理面板引入 **AI 智能助手**，覆盖四大高频场景：

1. **Compose 智能生成**：口语化描述 → 生成 compose yaml，可直接落盘为工程。
2. **日志智能分析**：容器/宿主机日志一键"总结 + 异常定位 + 根因建议"。
3. **排障问答**：NL 提问（"为什么容器 OOM/退出了？"）→ 结合上下文返回诊断建议。
4. **命令生成器**：白话 → docker CLI 或面板 API 命令。

**核心约束设计**：AI 走 **OpenAI 兼容 Chat Completions 协议**，通过设置配置 `base / apiKey / model / systemPrompt`，**apiKey 经 `encryptSecret` 对称加密落库**。未配置时所有 AI 接口返回 `{ enabled: false }`，前端隐藏入口，不产生任何外部调用。

---

## 二、总体架构

```
浏览器 AI 助手页 /assistant
   │  post /api/ai/chat { messages, tool? }
   ▼
server/src/routes/ai.ts   ──►  server/src/aiClient.ts (OpenAI 兼容协议，手写 fetch，零依赖)
        │                        │                     │
        │                     enabled 判定           读取运行时上下文（做了哪些能力）
        ▼                        ▼                     ▼
   ai_settings 表(加密)   setupCheck()/assertEnabled()   tools: composeInfer(getRunningContainers)
                                                                  + logs(getContainerLogs)
```

- **端口**：走现有后端端口（9528），无需新服务。
- **鉴权**：`/api/ai/*` 全部 `requireAuth`（复用 `app.ts` 挂载）。
- **流式**：可选。首期用**非流式**（简洁、易实现）；预留 `stream: true` 字段的 SSE 演进（复用项目已有 SSE/WS 经验）。

---

## 三、数据模型（`server/src/storage.ts`）

在 `createTables()` 末尾追加（沿用现有风格，`CREATE TABLE IF NOT EXISTS`）：

```sql
-- AI 助手配置（单行，密钥经 encryptSecret 对称加密）
CREATE TABLE IF NOT EXISTS ai_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),  -- 强制单行
  enabled        INTEGER NOT NULL DEFAULT 0,           -- 总开关
  base_url       TEXT NOT NULL DEFAULT '',             -- OpenAI 兼容端点
  model          TEXT NOT NULL DEFAULT '',             -- 模型名
  api_key_enc    TEXT NOT NULL DEFAULT '',             -- encryptSecret(apiKey)
  system_prompt  TEXT NOT NULL DEFAULT '',             -- 自定义系统提示词
  timeout_ms     INTEGER NOT NULL DEFAULT 60000,
  updated_at     INTEGER NOT NULL
);

-- AI 对话历史（按用户留存，可选。首期可只存最近 N 条在内存，该表作为扩展点）
CREATE TABLE IF NOT EXISTS ai_chat_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,                          -- 会话用户
  role         TEXT NOT NULL,                          -- user / assistant / system
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
```

> `setting` 表现有的 KV 读取模式（`hubConfig.ts`）也可替代 `ai_settings` 表，但独立表更清晰、便于加 `CHECK(id=1)` 单行约束，故采用独立表。

---

## 四、后端实现

### 4.1 `server/src/aiClient.ts`（新建，零依赖 OpenAI 兼容客户端）

仿 `trivyCli.ts` / `gitCli.ts` 风格（可选工具 + 探测 + 优雅降级 + 纯函数可单测）。

```ts
/** AI 配置（解密后的运行时视图） */
export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  timeoutMs: number;
}

export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string; }

/** 判断是否已配置可用（enabled && baseUrl && apiKey && model） */
export function isAiConfigured(): boolean;

/** 读取配置（解密 apiKey），未配置返回 { enabled:false } */
export function getAiConfig(): AiConfig;

/** 未启用时抛 statusCode=503 便于前端识别 */
export function assertAiEnabled(): AiConfig;

/** 调用 OpenAI 兼容 /chat/completions（手写 fetch，超时用 AbortController），返回 assistant 文本 */
export async function chatCompletion(cfg: AiConfig, messages: AiMessage[], opts?: {
  timeoutMs?: number;
}): Promise<string>;

/* 另含纯函数便于单测 */
export function buildSystemPrompt(cfg: AiConfig, context: string, capabilities: string[]): AiMessage[];
export function parseChatResponse(body: unknown): string;
```

关键点：
- **零依赖**：用 Node 全局 `fetch`（Node ≥22 已内置），`AbortController` 实现超时。
- **安全**：`assertAiEnabled()` 在无配置时返回 503，**不向任何外部地址发请求**。
- **SSRF 防护**：校验 `baseUrl` 仅允许 `https://` 或 `http://localhost`/`127.0.0.1`（防止用户把面板配置指向内网任意地址被诱导调用）。

### 4.2 `server/src/routes/ai.ts`（新建，挂 `/api/ai`）

复用现有 `asyncHandler`、`logOperation`、`requireAuth` 约定。接口设计：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ai/settings` | 读取配置（**apiKey 脱敏**，前端仅显示"已配置/未配置"） |
| PUT | `/api/ai/settings` | 写入配置（apiKey 留空=不更新；传入新值则 `encryptSecret` 落库）；`body.enabled` 总开关 |
| POST | `/api/ai/test` | 连通性测试（发一条最小请求验证 base/model/key） |
| GET | `/api/ai/capabilities` | 返回当前可用的 AI 工具能力清单（compose-generate / logs-analyze / diagnose / command） |
| POST | `/api/ai/chat` | 主对话入口，`{ messages, tool? }`。`tool` ∈ compose-infer / logs / none |

**`/api/ai/chat` 的 tool 上下文注入**（体现"助手能看你的环境"）：
- `tool: 'compose-infer'`：服务端先 `getDockerClient().listContainers()` 拉取正在运行的容器（id/name/image/ports），把「可逆向的容器列表」作为上下文拼进 system prompt，让助手提示用户"从哪个容器生成 compose"。
- `tool: 'logs'`：服务端先读取目标容器最近日志（`GET /api/containers/:id/logs` 同款逻辑），作为上下文让助手做总结/排障（超长截断，如前 400KB）。
- 落库 `ai_chat_history`（可选，若启用：写本轮 user/assistant），并 `logOperation(...)` 记录 AI 调用审计。

> 安全：**AI 不直接执行任何 Docker 写操作**。生成的 compose / 命令仅回显给用户，由用户在对应页面确认后由既有接口执行。杜绝"AI 自主删容器"风险。

### 4.3 路由挂载（`server/src/app.ts`）

```ts
import aiRouter from './routes/ai';
// ...
app.use('/api/ai', requireAuth, aiRouter);
```

---

## 五、前端实现

按项目约定（三种注册法 + 通用组件 + 三段式渲染 + BEM less）。

### 5.1 新增文件
| 文件 | 说明 |
|------|------|
| `web/src/pages/aiAssistant.tsx` | 助手页：左聊天区 + 右侧工具快捷入口 |
| `web/src/pages/aiAssistant.less` | 页面样式（`ai-assistant__*` BEM） |

### 5.2 注册（`web/src/App.tsx` / `web/src/components/Layout.tsx`）
```tsx
// App.tsx
const AiAssistantPage = lazy(() => import('./pages/aiAssistant'));
// <Layout> 内
<Route path="/assistant" element={<PageSuspense><AiAssistantPage /></PageSuspense>} />

// Layout.tsx NAV_ITEMS 追加
{ to: '/assistant', label: 'AI 助手', icon: <svg {...iconProps}>…✨ 对话 SVG…</svg> }
```

### 5.3 页面骨架（贴合现有模式）
- 顶部：`isAiConfigured` 探测。未配置 → 渲染「配置引导卡」（跳 `/settings` 或内联表单填 base/model/key，走 `PUT /api/ai/settings` + `POST /api/ai/test`）。
- 主区：聊天消息列表（user 右侧 / assistant 左侧气泡）+ 底部输入框（多行 + 发送）。
- 右侧「快捷能力」卡片：`GET /api/ai/capabilities` 渲染四项（Compose 生成 / 日志分析 / 排障 / 命令），点击自动填充一条带 `tool` 的引导消息并触发。
- 渲染：`loading ? <SkeletonRows> : …气泡列表…`；错误用 `showToast('…', 'error')`。
- 调用 `post<AiChatResponse>('/api/ai/chat', { messages, tool })`，展示 `reply` 的 markdown（可用极简代码块高亮，避免引入重库）。

### 5.4 类型（`web/src/types/index.ts` 追加）
```ts
export interface AiSettings { enabled: boolean; baseUrl: string; model: string; hasApiKey: boolean; timeoutMs: number; }
export interface AiCapability { id: string; label: string; description: string; prompt: string; tool?: string; }
export interface AiChatRequest { messages: Array<{ role: string; content: string }>; tool?: string; }
export interface AiChatResponse { enabled: boolean; reply: string; toolContext?: string; }
export interface AiTestResponse { enabled: boolean; ok: boolean; message?: string; }
```

---

## 六、安全与合规要点

1. **写操作隔离**：AI 只"生成/建议"，不"执行/删除"；所有落盘/启停回到既有接口 + 既有二次确认。
2. **密钥加密**：apiKey 用 `encryptSecret` 落库；回显脱敏（仅 `hasApiKey` 布尔）。
3. **SSRF 防护**：baseUrl 仅允许 https / localhost。
4. **审计**：AI 调用记 `operationLog`；对话历史按用户隔离（若启用）。
5. **RBAC**：AI 页默认所有登录用户可用；配置（settings）接口仅 admin（`requireAdmin`）。

---

## 七、任务拆分（可独立验收）

| # | 任务 | 涉及文件 | 验收 |
|---|------|----------|------|
| T1 | 建 `ai_settings` / `ai_chat_history` 表 | `server/src/storage.ts` | 启动建表成功，旧库不破坏 |
| T2 | 写 `aiClient.ts`（配置读写/校验/chatCompletion/纯函数） | 新建 `server/src/aiClient.ts` | 配置未开启返回 enabled=false；`parseChatResponse` 单测通过 |
| T3 | 写 `ai.ts` 路由（settings/test/capabilities/chat + tool 上下文注入 + 写操作隔离 + 审计） | 新建 `server/src/routes/ai.ts` | `/api/ai/settings` CRUD、`/test`、`/chat`（含 compose-infer/logs 上下文）各回归通过 |
| T4 | 挂载路由 + 前端类型 | `server/src/app.ts`、`web/src/types/index.ts` | 启动无错误；类型编译通过 |
| T5 | 前端助手页 + 配置引导 + 快捷能力 | 新建 `web/src/pages/aiAssistant.tsx`(`.less`) | 未配置显示引导卡；配置后能聊天、快捷能力填充 |
| T6 | 注册路由与侧边栏菜单 | `web/src/App.tsx`、`web/src/components/Layout.tsx` | `/assistant` 可访问，菜单可见 |
| T7 | 端到端验证 + 回归 | 手测 + 现有回归脚本 | `npm run build` 无类型错误；`dev:server`/`dev:web` 正常；未配置 AI 时原有功能零影响 |

**依赖顺序**：T1→T2→T3→T4（后端闭环）∥ T5 依赖 T3/T4；T6 依赖 T5；T7 收尾。T1~T4 可先落地并后端单测通过，再联调前端。

---

## 八、后续扩展（本期不做，留档）

- **流式输出（SSE）**：`/api/ai/chat` 支持 `stream:true`，实现打字机效果（复用项目 WS/SSE 经验）。
- **多轮记忆结构化**：把 `ai_chat_history` 升级为按会话聚合，长期保留。
- **Compose 一键落盘**：AI 生成 compose 后"保存为工程"按钮（对接既有 `/api/compose`，仍由用户确认）。
- **告警联动**：告警触发时自动附言 AI 建议（对接既有 `notify.ts` 链路）。
- **接入本地模型**（Ollama 等 OpenAI 兼容端点）已在 baseUrl 能力内，无需额外改动。

---

## 九、验证清单

1. 未配置时：`GET /api/ai/settings` 返回 `enabled:false`；`/api/ai/chat` 返回 503；页面显示配置引导卡；**无任何外部请求**。
2. 配置后：`/test` 连通成功；`/chat` 普通对话正常；apiKey 在 `/settings` 不回显明文。
3. 快捷能力：compose-infer 能列出运行容器并生成 compose；logs 能总结指定容器日志。
4. 安全：AI 回复中无 `docker rm`/`docker rmi` 等破坏性命令直接执行；写操作仍走原接口二次确认。
5. 审计：每次 `/chat` 在操作日志有记录。
6. 回归：`npm run build` 通过，既有页面/接口零回归。
