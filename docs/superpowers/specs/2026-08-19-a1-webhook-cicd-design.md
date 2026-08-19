# A1「Webhook 自动化部署」设计文档

> 日期：2026-08-19
> 类型：功能设计（brainstorming → design）
> 状态：待用户审阅

## 1. 背景与目标

在现有计划任务系统之上，新增**事件驱动（Webhook）触发能力**与 **Git → 构建/部署流水线**，实现"代码推送 → 自动构建/部署"闭环，并支持 **Git 私有仓库凭证**。

保持项目**零第三方运行时依赖、Windows、Node>=22、SQLite** 约束。

### 已确认的关键决策
- **产物形态**：构建镜像为主、Compose 部署为主，或两者组合（按任务配置区分）
- **Webhook 粒度**：每个任务一个独立 secret token，`POST /api/webhook/:token` 直接触发该任务
- **私有仓库凭证**：支持 HTTPS token 与 SSH 私钥两类，加密落库

---

## 2. 现状分析（关键依据）

- 现有任务系统在 [tasks.ts](file:///f:/ai_work/dockerDesktop/server/src/routes/tasks.ts) 注册了 8 类 handler：`prune / backup / pull / composeUp / composeDown / restart / command / healthcheck`
- 调度器 [scheduler.ts](file:///f:/ai_work/dockerDesktop/server/src/scheduler.ts)：cron 触发 + 防重入（`runningIds`）+ 执行历史回调 + 失败告警
- 已有 `POST /api/tasks/:id/run`（手动触发）与 `dispatchTask`（手动/定时共用 handler）
- compose 通过本机 `docker compose` CLI（`runCmd`）；构建通过 dockerode `buildImage`（[build.ts](file:///f:/ai_work/dockerDesktop/server/src/routes/build.ts)）
- 敏感字段已用 `encryptSecret` / `decryptSecret` 对称加密落库（见 [storage.ts](file:///f:/ai_work/dockerDesktop/server/src/storage.ts)、[cloud.ts](file:///f:/ai_work/dockerDesktop/server/src/routes/cloud.ts)），前端不返回明文，仅 `hasCred` 标记

**核心缺口**：任务系统缺"事件驱动（Webhook）"触发入口；缺 `git-pull-build` 这类"拉取→构建→部署"组合能力。

---

## 3. 架构总览

```
GitHub/GitLab/自建 ──POST /api/webhook/:token──▶ cron_tasks.webhook_token 匹配
                                                      │
                                                      ▼
                                    复用 executeTask / dispatchTask 链路（防重入、历史、告警）
                                                      │
                                        ┌─────────────┴──────────────┐
                                        ▼                           ▼
                              git-pull-build（新 handler）      既有 8 类 handler
                 git 拉取(凭证解密) → docker build → tag          (composeUp/composeDown …)
                                        │
                                        └──▶ 可选 compose 部署
```

Webhook 是**独立于 cron / 手动的第三种触发源**，触发后完全复用现有执行、历史、告警链路。

---

## 4. 数据模型（最小字段增量）

给 `cron_tasks` 增加两列：

| 列 | 类型 | 说明 |
|---|---|---|
| `webhook_token` | TEXT NULL | 每任务唯一 secret；NULL/空=未开启 Webhook |
| `git_cred_encrypted` | TEXT NULL | 加密后的凭证 JSON（`{type, token?, privateKey?}`）；私钥/token 再用 `encryptSecret` 加密 |

> 无需新表。一个任务可同时有 cron 与 webhook 两种触发，互不冲突。

### git-pull-build 任务配置（存于现有 `config` JSON）

```jsonc
{
  "mode": "image" | "compose",
  "repoUrl": "https://github.com/x/y.git",
  "branch": "main",
  "destDir": "",            // 本地工作目录；空则自动创建于 <tmp>/docker-git-pipeline/<taskId>
  "dockerfile": "Dockerfile",   // mode=image
  "imageName": "myapp:latest",  // mode=image
  "buildArgs": {},              // mode=image
  "composeProject": "myproj",   // mode=compose
  "alsoBuild": false            // mode=compose 时是否先构建镜像
}
```

---

## 5. 后端变更

### 5.1 新增端点

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `POST` | `/api/webhook/:token` | 匿名（靠 token） | Webhook 入口；匹配任务并异步触发执行，快速返回 |
| `POST` | `/api/tasks/:id/webhook` | admin | 生成/重置 webhook_token，返回 `{url, token}` |
| `DELETE` | `/api/tasks/:id/webhook` | admin | 关闭 webhook（清空 token） |

### 5.2 任务 CRUD 调整
- `POST /api/tasks` / `PUT /api/tasks/:id`：body 可选 `gitCred`（`{type, token?, privateKey?}`），服务端 `encryptSecret` 加密落库
- `GET /api/tasks`：序列化增加 `webhookToken`(仅 admin 可见) 与 `gitCred: { type?, hasCred: boolean }`（不含明文）

### 5.3 新增 task handler：`git-pull-build`
在 [tasks.ts](file:///f:/ai_work/dockerDesktop/server/src/routes/tasks.ts) 注册新 handler，按 `config.mode` 分支：
- **image 模式**：git 拉取到工作目录 → dockerode `buildImage`（支持 Dockerfile、buildArgs、`--pull`）→ 打标签 `imageName`
- **compose 模式**：`composeProject` 目录本身即该仓库的 git 工作目录（首次由后端 `git clone` 建立，后续每次 `git pull` 更新）→（`alsoBuild` 时先构建）→ `docker compose -f <file> up -d --build`
- 任一失败：复用 `reportTaskFailure` 告警 + `cron_task_logs` 记失败；detail 标注触发来源（webhook/cron/manual）

> 工作目录统一落在 `<os.tmpdir()>/docker-git-pipeline/<taskId>`（image 模式）或由 `composeProject` 决定（compose 模式），与既有 `COMPOSE_ROOT` 语义保持一致。

### 5.4 Git 私有仓库凭证使用
- HTTPS token：通过 URL/凭据注入 `git clone/pull`，避免落盘
- SSH 私钥：临时写 `os.tmpdir()` 下 600 权限私钥文件，`git -c core.sshCommand=...` 拉取，`-o StrictHostKeyChecking=accept-new` 避免首次交互卡死；执行后清理
- 凭证仅在 handler 执行拉取时 `decryptSecret` 解出使用

### 5.5 Webhook 安全
- token = 32 位随机 hex（`crypto.randomBytes`）
- 可选 Header 校验 `X-Docker-Panel-Token` 与 path token 双校验，规避 URL 泄露/重放

---

## 6. 前端变更（[tasks.tsx](file:///f:/ai_work/dockerDesktop/web/src/pages/tasks.tsx)）

1. `TASK_TYPES` 增加 `git-pull-build`（"Git 自动部署"）
2. 表单新增 git-pull-build 配置区：mode 切换（构建镜像/Compose 部署）、仓库地址、分支、Dockerfile/镜像名、compose 项目、`alsoBuild` 勾选
3. 表单新增"私有仓库凭证"区：类型下拉（HTTPS Token / SSH 私钥）、token 输入/私钥 textarea；编辑时显示"已配置凭证"，留空不改
4. 任务详情/卡片新增 **Webhook** 区块：URL + token 展示、复制、重置、关闭

---

## 7. 错误处理与幂等
- Git/构建/部署失败 → 复用告警 + 日志
- Webhook 请求快速返回（200 即时应答；任务异步执行，不阻塞 HTTP）
- 防重入：复用调度器 `runningIds`，同一任务同一时刻仅执行一次

---

## 8. 测试与验证
- 后端：`git-pull-build` handler 与 webhook 路由的单元/集成测试（沿用 `server/test/auth-security.test.ts` 模式）
- 回归：`npm run regression:tasks`
- 手工：创建任务 → 生成 token → `curl -X POST /api/webhook/<token>` → 查看 `cron_task_logs` 新增记录 + detail 标注来源

---

## 9. 范围边界（明确不做）
- 不做真正的 CI 沙箱/多阶段产物缓存（依赖 docker 构建原生能力）
- 不做与 GitHub/GitLab 的深度 webhook 事件解析（如按分支/PR 精细分流），仅做"每任务 token 触发"
- 不做镜像推送（可后续扩展）；本轮聚焦"构建/部署到本地当前引擎/Compose 项目"
