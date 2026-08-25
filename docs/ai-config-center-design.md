# AI 模型配置中心（多套配置文件 + 本地/三方预设）· 实施设计（PRD + 技术方案）

> 生成日期：2026-08-25
> 视角：产品经理 + 架构师
> 对应：`docs/ai-assistant-design.md` 的配置增强
> 原则：**复用现有 `aiClient.ts`（OpenAI 兼容客户端）+ `storage.ts`（`encryptSecret`）**，把"单套裸表单配置"升级为"多套配置文件 + 内置本地/三方预设，一键填充、随时切换"。零第三方依赖。

---

## 一、背景与目标

现状：AI 助手只有一个 `ai_settings` 单行表 + 一个裸配置弹窗（baseUrl / model / key / 超时 / 提示词）。用户想换本地或三方模型时，要自己记地址、手填模型名、填代码参数，填错就报"fetch failed"。且只存一套，不能本地/三方并存切换。

**目标**：把"填一堆参数"变成"选一个 Profile"。支持：
1. **多套配置文件并存**（本地一套、三方一套…），AI 助手页一键切换。
2. **内置提供商预设**（本地 Ollama / LM Studio / 本地网关 + 三方 OpenAI / DeepSeek / Kimi / 通义 / 智谱），点击自动填充 baseUrl + 常用模型。
3. **平滑升级**：已有 `ai_settings` 数据自动迁移为首个 Profile，不丢配置。
4. 仍保留手填"自定义"能力。

---

## 二、总体架构

```
AI 助手页「模型配置中心」弹窗
   │  GET /api/ai/presets            ← 内置预设清单（只读）
   │  GET|POST|PUT|DELETE /api/ai/profiles   ← 用户配置 CRUD
   │  POST /api/ai/profiles/:id/test ← 单套测试
   │  PUT  /api/ai/profiles/:id/default      ← 设为默认
   ▼
server/src/routes/ai.ts（扩展）+ server/src/aiProfiles.ts（新建，纯函数可单测）
   ├─ ai_profiles 表（SQLite，api_key_enc 加密）
   ├─ 迁移：启动时 ai_settings → 首条 profile + 默认
   └─ chatCompletion(cfg, messages) 改为接收指定 profile，不再读全局单套
前端：web/src/pages/aiAssistant.tsx 配置弹窗升级为「模型配置中心」
```

- **兼容**：保留 `GET/PUT /api/ai/settings`，改为读写"当前默认 profile + 全局 enabled 开关"，旧前端逻辑不崩。
- **安全**：`api_key_enc` 复用 `encryptSecret` 加密；前端回显仅标记"已配置"；baseUrl 复用手写 SSRF 白名单（`https://` 或 `http://localhost/127.0.0.1/[::1]`）。

---

## 三、数据与核心模块

### 3.1 新表 `ai_profiles`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK AUTOINCREMENT | 主键 |
| `name` | TEXT | 配置名，如"本地 Ollama" |
| `kind` | TEXT (`local`\|`cloud`) | 决定 SSRF 提示 / 是否必填 key |
| `provider` | TEXT | `ollama`\|`lmstudio`\|`gateway`\|`openai`\|`deepseek`\|`moonshot`\|`dashscope`\|`zhipu`\|`custom` |
| `base_url` | TEXT | OpenAI 兼容端点 |
| `model` | TEXT | 模型名 |
| `api_key_enc` | TEXT | 加密后的 key（本地可空） |
| `system_prompt` | TEXT | 系统提示词（可空，覆盖默认） |
| `timeout_ms` | INTEGER | 超时毫秒，默认 60000 |
| `is_default` | INTEGER 0/1 | 是否当前默认 |
| `created_at` / `updated_at` | INTEGER | 时间戳 |

### 3.2 迁移（`server/src/aiProfiles.ts` 内 `ensureAiProfiles()`）

- 启动时检测：若 `ai_settings` 存在数据（`enabled` / `base_url` / `model` 任一非空），则迁成第一条 profile（`is_default=1`，`name` 由 baseUrl/kind 智能命名），随后旧表保留用于兼容读取；不重复迁移（用"已迁移"标记或 `ai_settings.id=1` 数据是否已消费判断）。

### 3.3 内置预设（`server/src/aiPresets.ts`，只读常量）

```ts
interface AiPreset {
  id: 'ollama'|'lmstudio'|'gateway'|'openai'|'deepseek'|'moonshot'|'dashscope'|'zhipu'|'custom';
  name: string;
  kind: 'local'|'cloud';
  baseUrl: string;
  models: string[];        // 常用模型下拉
  keyHint?: string;        // key 提示/是否必填
}
```

| id | name | kind | baseUrl | 常用模型 |
|----|------|------|---------|----------|
| ollama | Ollama | local | `http://localhost:11434/v1` | llama3.1 / qwen2.5 / mistral |
| lmstudio | LM Studio | local | `http://localhost:1234/v1` | （动态，见 3.5） |
| gateway | 本地网关 | local | `http://127.0.0.1:<端口>/v1` | 用户自定义 |
| openai | OpenAI | cloud | `https://api.openai.com/v1` | gpt-4o / gpt-4o-mini |
| deepseek | DeepSeek | cloud | `https://api.deepseek.com/v1` | deepseek-chat / deepseek-reasoner |
| moonshot | Kimi | cloud | `https://api.moonshot.cn/v1` | moonshot-v1-8k / 32k / 128k |
| dashscope | 通义千问 | cloud | `https://dashscope.aliyuncs.com/compatible-mode/v1` | qwen-plus / qwen-max / qwen-turbo |
| zhipu | 智谱 GLM | cloud | `https://open.bigmodel.cn/api/paas/v4` | glm-4-plus / glm-4-flash |

### 3.4 后端 API（`server/src/routes/ai.ts` 扩展）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ai/presets` | 内置预设清单（admin） |
| GET | `/api/ai/profiles` | 我的配置列表（含 is_default / hasKey） |
| POST | `/api/ai/profiles` | 新增（校验 SSRF + 必填） |
| PUT | `/api/ai/profiles/:id` | 编辑 |
| DELETE | `/api/ai/profiles/:id` | 删除（默认项删除后自动另选默认；禁止删最后一条） |
| POST | `/api/ai/profiles/:id/test` | 测试连接（复用 `testAiConnection`） |
| PUT | `/api/ai/profiles/:id/default` | 设为默认 |
| GET | `/api/ai/settings` | 兼容：`{ enabled, defaultProfileId, ... }` |
| PUT | `/api/ai/settings` | 兼容：全局 enabled 开关 + 改默认 |

`chatCompletion` 签名改为接收完整 profile（含 baseUrl/model/apiKey/timeout），不再内部读全局单套。

### 3.5 模型动态下拉（增强项，可选）

- Ollama / LM Studio / gateway 等 local 预设，可通过 `GET {baseUrl}/models`（Ollama 用 `{baseHost}/api/tags`）拉取**本机已装模型**填入下拉。
- 静默失败降级为内置常用模型（不弹错，仅提示"拉取失败，用内置列表"）。
- 属增强项，首版可后置。

---

## 四、前端交互（`web/src/pages/aiAssistant.tsx` + 类型）

配置弹窗升级为「**模型配置中心**」，两个 Tab：

1. **Tab · 预设**：点选提供商卡片（本地/三方分组）→ 自动填 baseUrl + 模型下拉（可选动态）→ 填 name 与 key → 保存（新增 profile）。
2. **Tab · 我的配置**：已存 profiles 列表（名称 / 类型 / 模型 / 是否默认 / key 已配置标记）+ 操作：新增 / 编辑 / 删除 / 设为默认 / 测试连接。

AI 助手页顶部新增「**当前模型**」下拉：直接选默认 profile（读取 `/api/ai/settings` 的 defaultProfileId + `/api/ai/profiles` 生成）。

所需前端类型（`web/src/types/index.ts`）：
```ts
interface AiProfile { id:number; name:string; kind:'local'|'cloud'; provider:string; baseUrl:string; model:string; hasKey:boolean; isDefault:boolean; timeoutMs:number; }
interface AiPreset { id:string; name:string; kind:'local'|'cloud'; baseUrl:string; models:string[]; keyHint?:string; }
```

---

## 五、测试计划

- **单测**（`server/test/aiProfiles.test.ts`、`aiPresets.test.ts`）：
  - 迁移：`ai_settings` 有数据 → 迁成首条 profile + 默认；无数据 → 不迁移；幂等（不重复迁移）。
  - CRUD：新增/编辑/删除/设默认；删除最后一条被拒；删除默认后再选默认。
  - 预设：清单完整性（9 项）、每项 baseUrl 与 kind 正确、SSRF 白名单校验覆盖所有预设。
  - 回归：现有 `aiClient.test.ts` 不破（`chatCompletion` 接收 profile）。
- **端到端**：配置本地/云端 profile → 测试连接 → 切换默认 → AI 对话走默认 profile。

---

## 六、实施清单

| 步骤 | 文件 |
|------|------|
| 1. 建表 + 迁移 | `server/src/storage.ts`（建 `ai_profiles` 表）、`server/src/aiProfiles.ts`（新建，ensureAiProfiles + CRUD 纯函数） |
| 2. 预设常量 | `server/src/aiPresets.ts`（新建） |
| 3. `chatCompletion` 改造 | `server/src/aiClient.ts` |
| 4. 路由扩展 | `server/src/routes/ai.ts` |
| 5. 前端类型 | `web/src/types/index.ts` |
| 6. 配置中心 UI | `web/src/pages/aiAssistant.tsx` + `.less` |
| 7. 单测 + 回归 | `server/test/aiProfiles.test.ts`、`aiPresets.test.ts` |

---

## 七、风险与兼容

- **SSRF**：所有预设 baseUrl 均满足白名单（local 需本地回环，cloud 走 https）；`custom` 也必须通过同一校验。
- **兼容**：保留 `/api/ai/settings`；`ai_settings` 旧表不清除（只读兼容），新增数据全在 `ai_profiles`。
- **key 安全**：全程只存加密值，回显仅 `hasKey` 布尔。
- **首个版本不做**：多 key 轮询、用量统计、限流（YAGNI）。
