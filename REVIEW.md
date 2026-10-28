# REVIEW.md — 本仓库的审查章程

> 给人类审查者与 AI 审查器的共同指引。发现问题时必须附**文件名 + 行号**作为证据。
> 本仓库管理的是真实服务器（Docker、防火墙、主机文件），漏过一个 bug 的代价是被管理的机器出事。

## 一、本仓库的"失败"长什么样（必须抓住）

按爆炸半径从高到低：

1. **认证与凭据**（`server/src/auth.ts`、`server/src/routes/auth.ts`、`server/src/routes/creds.ts`）
   - 登录/令牌/凭据存储的任何改动都是 Deep 审查；禁止放宽校验、禁止明文落库。
2. **命令执行通道**
   - `server/src/routes/hostTerminal.ts`、`server/src/routes/compose.ts`、`server/src/aiActionExecutor.ts`
   - 拼接 shell 命令必须转义；用户输入（含 AI 生成的命令）进入 exec 前必须有白名单/审批边界（`approvals.ts`）。
   - 命令注入 = 服务器被拿走，宁可误拦不可放行。
3. **主机文件与路径解析**（`server/src/routes/files.ts`、`server/src/routes/hostFiles.ts`）
   - 路径穿越（`../`、符号链接）必须在边界校验；删除/覆写操作必须有范围限制。
4. **防火墙 / 站点 / 证书 / 引擎**（`firewall.ts`、`sites.ts`、`certs.ts`、`engines.ts`）
   - 配错一条规则可能把用户锁在服务器外。破坏性操作需二次确认与回滚说明。
5. **数据库 schema 与配置导入导出**（`server/src/db/`、`configTransfer.ts`、`backups.ts`）
   - SQLite schema 变更必须幂等兼容存量数据；configTransfer 全量导入对并发敏感（CI 中已顺序执行）。
6. **打包与升级**（`packaging/`、Windows 升级计划任务）
   - 安装器/升级脚本出错 = 用户服务中断；版本号同步由 `npm run docs:check` 把关。

## 二、审查强度分档（由变更内容决定，与作者无关）

| 档位 | 适用范围 |
|------|---------|
| **Deep** | 上表 1~6 涉及的文件；任何引入新 exec/新端点/新持久化的 diff |
| **Standard** | 普通功能、web 页面（`web/src/`）、其余 server 路由 |
| **Quick** | 文档、CHANGELOG、截图、README 版本号 |

## 三、可跳过审查的路径

- `docs/*.md` 纯翻译同步（中英文互译）
- `images/` 截图重采（`npm run docs:check` 已校验死链）
- `CHANGELOG.md` 版本归档本身

## 四、Nit 限制

- 单次审查 **Nit ≤ 3 条**；纯风格问题（引号、空行、命名偏好）不提，交给工具。

## 五、发现（findings）分级

- **Important**：数据丢失、命令注入、越权、锁死服务器——必须修复或给出理由
- **Nit**：可选改进
- **Pre-existing**：PR 之前就有的问题——标注即可，不阻塞合并

## 六、测试与文档契约

- 新增测试文件必须手动加入 `server/package.json` 的 `test:unit` / `test:api` 显式列表（见 AGENTS.md）。
- 触及功能行为 → 同步更新 CHANGELOG / README / 两份手册 / 帮助中心（`npm run docs:check` 校验），否则 CI 的 docs job 会拦下。
- 文本编辑禁用 PowerShell `Get-Content`/`Set-Content`（中文乱码），用编辑工具或 node 脚本。
