# AI 智能助手功能开发文档

> 版本：v1.0 | 日期：2026-08-26 | 状态：开发基线

---

## 一、AI 文件上传分析

### 1.1 功能概述
用户通过上传 Dockerfile、docker-compose.yml、日志文件等，由 AI 自动分析并给出优化建议、安全审计、问题诊断。

### 1.2 竞品分析

| 产品 | 能力 | 亮点 |
|------|------|------|
| ChatGPT Code Interpreter | 20+ 文件格式，沙箱分析，自动图表 | 自动识别文件类型选择分析策略 |
| Docker Desktop Gordon | 上下文感知，读取容器/日志/Compose | 三种安全模式，MCP 扩展 |
| Docker Review CLI | 13 条 Dockerfile 规则 + 11 条 Compose 规则 | 自动修复，安全评分(0-10) |
| Hadolint | 100+ Dockerfile lint 规则 | 行业标准，CI/CD 集成 |

### 1.3 技术方案

#### 支持的文件类型
| 类型 | 扩展名 | 分析方式 |
|------|--------|----------|
| Dockerfile | Dockerfile, *.dockerfile | 规则检查 + AI 优化建议 |
| Compose | docker-compose.yml, *.yml | 结构分析 + 最佳实践 |
| 日志 | *.log, *.txt | 模式识别 + 错误诊断 |
| 配置文件 | *.conf, *.json, *.yaml | 安全审计 + 配置优化 |
| 纯文本 | 其他 | AI 通用分析 |

#### 后端设计
- 端点：`POST /api/ai/analyze`（JSON：`{ filename, type, content }`，避免 multipart 依赖）
- 文件大小限制：5MB（超出截断并向 AI 说明）
- 流程：接收 → 规则预处理（仅 Dockerfile）→ 构建带文件内容的 prompt → 调用 AI → 返回结构化结果
- 规则预处理（Dockerfile 专用）：
  - 基础镜像是否用 `latest`（非可追溯）
  - 是否缺少 `USER` 指令（非 root 运行）
  - `COPY` vs `ADD` 使用是否恰当
  - 是否使用多阶段构建
  - 是否缺少 `HEALTHCHECK`
  - 是否泄露敏感信息（ENV 中的密码/token）

#### 前端设计
- 聊天输入区上方添加"上传分析"按钮
- 支持拖拽 + 点击选择
- 选择文件后自动将内容读取并填入分析请求
- 分析结果显示：
  - 评分卡片（安全/性能/维护性 0-10 分）
  - 问题列表（严重级别标签）
  - 优化建议（markdown 渲染）

### 1.4 实现步骤
1. 后端：创建 `server/src/aiFileAnalyzer.ts` — 类型检测、Dockerfile 规则引擎、prompt 构建
2. 后端：添加 `POST /api/ai/analyze` 路由（复用 `chatCompletion`）
3. 前端：创建上传分析组件（拖拽 + 点击）
4. 前端：分析结果展示（评分 + 问题列表 + 建议）
5. 集成：分析结果可作为对话上下文注入

---

## 二、Docker Model Runner 集成

### 2.1 功能概述
管理本地 AI 模型服务（Ollama / Docker Model Runner / vLLM / LM Studio），支持模型列表、状态监控、拉取/删除模型。

### 2.2 竞品分析

| 产品 | 特点 | 端口 |
|------|------|------|
| Ollama | 最简单的本地 LLM，REST API | 11434 |
| Docker Model Runner | 内置于 Docker Desktop，OCI 分发 | 12434 |
| vLLM | 高吞吐推理，PagedAttention | 8000 |
| LM Studio | GUI 管理，统一 API | 1234 |

### 2.3 技术方案

#### 已有能力（复用）
- `aiPresets.ts` 已有 Ollama/LM Studio 预设
- `getLocalModelStatus()` 已实现模型列表查询（`/v1/models`）
- Profile 系统支持多 local kind 配置
- 前端已实现"检测本地服务"按钮

#### 新增功能
1. **模型管理面板**：
   - 显示已安装模型列表（大小、状态）
   - 本地服务健康状态

2. **模型快捷操作**（通过 Ollama REST API `:11434`）：
   - `POST /api/ollama/pull` — 拉取模型（`/api/pull`，流式进度可后续优化）
   - `DELETE /api/ollama/models/:name` — 删除模型（`/api/delete`）
   - `GET /api/ollama/ps` — 运行中模型列表（`/api/ps`）
   - `GET /api/ollama/status` — 服务健康 + 版本

> 说明：Ollama 相关管理端点走 `http://localhost:11434`（或用户配置的 host/mock），与 OpenAI 兼容 `/v1` 分离。若未安装 Ollama，接口返回明确错误提示。

### 2.4 实现步骤
1. 后端：创建 `server/src/ollamaClient.ts` — 管理 API 调用（pull/delete/ps/status）
2. 后端：添加 `/api/ai/local/*` 路由
3. 前端：创建本地模型管理面板（模型列表 + 拉取 + 删除 + 状态）
4. 前端：集成到 AI 配置中心

---

## 三、操作执行引擎

### 3.1 功能概述
AI 建议的操作经用户审批后，自动调用 Docker API 执行，并追踪执行结果。

### 3.2 当前状态
- `aiActions.ts` 已有完整审批 CRUD
- `parseActionsFromResponse()` 已实现 AI 响应解析
- 前端审批面板已完成
- **缺失**：审批通过后的自动执行

### 3.3 技术方案

#### 支持的操作类型 → dockerode 映射
| 操作类型 | dockerode 调用 | 参数 |
|----------|---------------|------|
| `restart_container` | `docker.getContainer(id).restart()` | containerId |
| `stop_container` | `docker.getContainer(id).stop({ t: 10 })` | containerId |
| `start_container` | `docker.getContainer(id).start()` | containerId |
| `remove_container` | `docker.getContainer(id).remove({ force: true })` | containerId |
| `remove_image` | `docker.getImage(id).remove({ force: true })` | imageId |
| `system_prune` | `docker.pruneContainers()` + `docker.pruneVolumes()` | 无 |

#### 执行流程
1. 用户点击"批准" → `approveAction(id)` 置 `approved`
2. `approve` 端点内异步触发 `executeAction(id)`
3. 成功 → `markExecuted(id, result, true)` → `executed`
4. 失败 → `markExecuted(id, errorMessage, false)` → `failed`
5. 前端加载详情时展示执行结果

#### 安全设计
- 仅 `approved` 状态可执行（防止重复执行）
- 执行超时：30 秒（`AbortController`）
- 危险操作（remove_container, remove_image, system_prune）前端需二次确认
- 执行日志写入 operation_log
- 执行结果返回给前端展示

### 3.4 实现步骤
1. 后端：创建 `server/src/aiActionExecutor.ts` — 执行引擎（dockerode 调用 + 超时 + 结果记录）
2. 后端：`routes/ai.ts` 的 approve/reject 端点触发执行
3. 后端：`GET /api/ai/actions` 返回含 result 的完整记录
4. 前端：审批面板展示"执行中/已执行/失败"状态与结果
5. 前端：危险操作二次确认弹窗

---

## 四、运维知识库 RAG

### 4.1 功能概述
上传运维文档（Docker 文档、内部 Wiki、配置说明），AI 基于知识库内容与检索上下文回答问题。

### 4.2 竞品分析

| 方案 | 向量库 | 特点 |
|------|--------|------|
| pgvector | PostgreSQL | 自托管最简，IVFFlat/HNSW |
| Qdrant | 独立服务 | 高性能，HNSW，过滤 |
| FAISS | 内存 | 零依赖，最快单机 |
| Writer/Query Split | FAISS + BM25 | 混合搜索，高吞吐 |

### 4.3 技术方案

**零依赖约束下的方案选择**：项目"零第三方运行时依赖"，不能引入外部向量数据库。

**推荐方案：SQLite 存储 + 内存 TF-IDF 向量 + 可选用 Ollama embedding**

1. **存储层**：`ai_knowledge` 表（含 embedding BLOB）
2. **Embedding 双模式**：
   - 默认：TF-IDF 特征向量（基于中文文本分词 + IDF 权重，无外部依赖）
   - 增强：如配置了本地 Ollama，调用 `/api/embeddings` 获取高质量向量（异步升级，不阻塞）
3. **检索**：余弦相似度，内存计算 Top-K
4. **分块**：按段落/标题分块，每块约 512 字符，50 字符重叠
5. **回答**：Top-K 相关块注入系统 prompt，AI 基于上下文回答（标注"参考知识库"）

#### 数据库设计
```sql
CREATE TABLE IF NOT EXISTS ai_knowledge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  embedding   BLOB,
  username    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_category ON ai_knowledge(category);
```

#### API 设计
| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/ai/knowledge` | 列出知识条目 |
| `POST` | `/api/ai/knowledge` | 上传文档（JSON `{ title, content, category }`） |
| `DELETE` | `/api/ai/knowledge/:id` | 删除条目 |
| `POST` | `/api/ai/knowledge/search` | 语义搜索（返回 Top-K） |
| `DELETE` | `/api/ai/knowledge/clear` | 清空知识库（admin） |

#### RAG 集成到聊天
在 `resolveChatRequest` 中：
1. 取用户最后一条消息
2. 搜索知识库 Top-3
3. 有匹配则追加到系统 prompt 作为参考上下文
4. AI 回答引用知识库

### 4.4 实现步骤
1. 后端：`storage.ts` 添加 `ai_knowledge` 表
2. 后端：创建 `server/src/aiKnowledge.ts` — CRUD + 分块 + TF-IDF + 相似度
3. 后端：添加知识库管理 API 路由
4. 后端：修改 `resolveChatRequest` 集成 RAG
5. 前端：知识库管理面板（上传/浏览/删除/搜索）
6. 前端：引用知识库状态标记

---

## 五、开发优先级与排期

| 序号 | 功能 | 预估 | 优先级 | 依赖 |
|------|------|------|--------|------|
| 1 | AI 文件上传分析 | 2-3h | P0 | 无 |
| 2 | Docker Model Runner 集成 | 1-2h | P1 | 无 |
| 3 | 操作执行引擎 | 1-2h | P0 | 已有审批 |
| 4 | 运维知识库 RAG | 3-4h | P1 | 无 |

## 六、风险与注意事项
1. **文件上传安全**：限制类型、大小（5MB），避免超长内容
2. **本地模型服务**：面板仅做连接管理，需用户自装 Ollama 等服务
3. **操作执行安全**：危险操作二次确认、执行超时 30s、仅 approved 可执行
4. **RAG 质量**：TF-IDF 向量质量有限，建议配置本地 Ollama embedding 增强
5. **零依赖约束**：RAG 用 SQLite + 内存计算，不引入外部向量库
