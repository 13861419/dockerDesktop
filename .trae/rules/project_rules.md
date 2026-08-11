# 项目规则

## 代码推送约定（必须遵循）

本项目的代码在**每次开发完成并验证通过后**，必须推送到远程 GitHub 仓库。

- **远程仓库**：`git@github.com:13861419/dockerDesktop.git`（使用 SSH 认证）
- **默认分支**：`main`（本地已跟踪 `origin/main`，可直接 `git push`）
- **认证方式**：SSH 密钥（本机已生成 `id_ed25519`，公钥已添加到 GitHub；`~/.ssh/config` 已配置走 `ssh.github.com:443` 以提升国内连通性）

### 提交与推送流程

1. 开发完成后，先运行前后端类型检查/构建验证通过（例如 `web` 下 `npx tsc -b`、`server` 下 `npx tsc --noEmit`）。
2. 使用 `git status` / `git diff` 检查改动，确认无误。
3. `git add -A`
4. `git commit -m "<清晰的提交信息>"`
5. `git push`
6. 推送完成后确认远程 `origin/main` 已同步。

### 安全约束（绝对禁止）

- **禁止**把任何密钥、密码、访问令牌（PAT）、会话凭据写入仓库内任何文件（含 `.gitignore`、`rules`、脚本、日志）。
- 本项目 `.gitignore` 已忽略敏感内容（`data/`、`.env*`、`*.exe`、`dist`/`node_modules` 等），提交前须用 `git status` 复核，确保不误提交这些文件。
- 数据库（`data/`）含用户密码哈希与镜像源配置，**严禁**提交到仓库。

## 开发注意事项

- 本面板基于 Node + React + TypeScript + Express + dockerode，SQLite（`node:sqlite`）做持久化，力求零第三方运行时依赖。
- 后端源码在 `server/src`，前端在 `web/src`；新增模块须同时挂载路由（`server/src/app.ts`）、页面路由（`web/src/App.tsx`）与侧边栏菜单（`web/src/components/Layout.tsx`）。
- 前端组件为单文件默认导出导入（如 `import Card from '../components/Card'`），`Select/Input/Field` 来自 `../components/Form`。
