# AGENTS.md — 代理协作约定

## 提交远端前的文档检查（必做）

每次执行 `git push`（或准备发布远端的提交）之前，逐项核对文档是否与代码同步：

1. **CHANGELOG.md**：本批次变更是否已按 Keep a Changelog 归入对应版本段（Added / Fixed / Changed / Test）
2. **README.md**：
   - 功能特性列表是否包含新功能
   - 安装包 / 版本号是否与根 `package.json` 一致（`npm run docs:check` 已自动校验；不一致时 `npm run docs:sync-version` 一键改写）
   - 数据表清单是否包含新增的 SQLite 表
3. **两份手册**（`docs/DockerManager-操作手册.md` 与 `docs/DockerManager-User-Manual.md`）：新功能是否有对应章节（中英文都要）；章节编号连续
4. **截图**：`images/` 目录覆盖文档全部图片引用，零死链。注意 GitHub 按文档所在目录解析相对路径：`docs/*.md` 中必须写 `../images/`（`npm run docs:check` 已按此规则校验）。
   一键重采：`cd e2e && CAPTURE=1 npx playwright test capture.spec.ts`
5. **应用内帮助中心**（`web/src/pages/help.tsx`）：功能速查表与 FAQ 是否覆盖新功能
6. **一致性**：CentOS 7 / glibc 等平台提法在四份文档中保持统一（Node 22 要求 glibc ≥ 2.28）

快速校验命令：

```powershell
npm run docs:check   # 图片死链检查（0 缺失为通过）；CI 的 docs job 同样执行
```

## 代码审查（提交 PR 前必读）

- 根目录 `REVIEW.md` 是审查章程：高风险区清单（认证凭据 / 命令执行 / 主机文件 / 防火墙站点 / schema / 打包升级）、审查强度分档（Quick/Standard/Deep）、Nit 限制、findings 分级。
- 提 PR 前固定自验证：`npm run test:server:unit` + 类型检查；证据先行，不许"声称完成"。
- PR 模板三栏（Testing / Risk / How to revert）必填；审查轮次上限 3 轮，超轮退回重新考虑方案。
- 触碰 Deep 档区域（见 REVIEW.md）的 diff，合并前必须获得 Code Owners 人工批准，代理批准不算数。
- **AI 审查自动化**（`.github/workflows/ai-review.yml`）：PR 打开/推送新提交时自动运行，按 REVIEW.md 标准输出分级发现（Important / Nit / Pre-existing），发现须逐条回应（修复或带理由关闭）；该 job 为建议性质不阻塞合并，人类批准才是合并闸门。调用 OpenAI 兼容接口（DeepSeek/GLM/Qwen/中转站均可），**运行在自托管 runner（本机）上**——因中转站接口不对 GitHub 托管 runner 开放；需本机注册 runner 且 git/node ≥ 18 可用，仓库 Secrets 配置 `AI_API_KEY`，可选 Variables：`AI_BASE_URL`（接口基地址）、`AI_MODEL`（模型名，默认 deepseek-chat）。审查逻辑见 `.github/scripts/ai-review.js`；runner 安装与新电脑接入步骤见 `docs/self-hosted-runner-setup.md`。
- 触碰 Deep 档区域（见 REVIEW.md）的 diff，合并前必须获得 Code Owners 人工批准，代理批准不算数。

## 项目关键约定

- **文本文件编辑禁用 PowerShell `Get-Content`/`Set-Content`**（会损坏 UTF-8 中文，产生乱码）；一律使用 edit 工具或 node 脚本文件。`powershell -File` 执行含中文的 `.ps1` 需带 UTF-8 BOM。
- **测试清单**：`server/package.json` 的 `test:unit` / `test:api` 是显式文件列表，新增测试文件必须手动加入。
- **测试命令**：单测 `npm run test:server:unit`；API 集成 `npm run test:server:api`（需 9528 后端）；E2E `cd e2e && npx playwright test`（自动拉起 9526 vite）。
