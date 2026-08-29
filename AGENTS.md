# AGENTS.md — 代理协作约定

## 提交远端前的文档检查（必做）

每次执行 `git push`（或准备发布远端的提交）之前，逐项核对文档是否与代码同步：

1. **CHANGELOG.md**：本批次变更是否已按 Keep a Changelog 归入对应版本段（Added / Fixed / Changed / Test）
2. **README.md**：
   - 功能特性列表是否包含新功能
   - 安装包 / 版本号是否与根 `package.json` 一致
   - 数据表清单是否包含新增的 SQLite 表
3. **两份手册**（`docs/DockerManager-操作手册.md` 与 `docs/DockerManager-User-Manual.md`）：新功能是否有对应章节（中英文都要）；章节编号连续
4. **截图**：`images/` 目录覆盖文档全部图片引用，零死链。
   一键重采：`cd e2e && CAPTURE=1 npx playwright test capture.spec.ts`
5. **应用内帮助中心**（`web/src/pages/help.tsx`）：功能速查表与 FAQ 是否覆盖新功能
6. **一致性**：CentOS 7 / glibc 等平台提法在四份文档中保持统一（Node 22 要求 glibc ≥ 2.28）

快速校验命令：

```powershell
# 图片死链检查（0 缺失为通过）
$refs = Select-String -Path README.md,"docs\*.md" -Pattern 'images/[^)"''`]+\.(png|jpg|gif)' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Sort-Object -Unique
$refs | ForEach-Object { if (-not (Test-Path $_)) { $_ } }
```

## 项目关键约定

- **文本文件编辑禁用 PowerShell `Get-Content`/`Set-Content`**（会损坏 UTF-8 中文，产生乱码）；一律使用 edit 工具或 node 脚本文件。`powershell -File` 执行含中文的 `.ps1` 需带 UTF-8 BOM。
- **测试清单**：`server/package.json` 的 `test:unit` / `test:api` 是显式文件列表，新增测试文件必须手动加入。
- **测试命令**：单测 `npm run test:server:unit`；API 集成 `npm run test:server:api`（需 9528 后端）；E2E `cd e2e && npx playwright test`（自动拉起 9526 vite）。
