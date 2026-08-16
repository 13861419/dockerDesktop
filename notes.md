# Notes: Compose Page Regression

## Sources

### Source 1: web/src/pages/compose.tsx
- Key points:
  - 页面拉取 `/api/compose` 显示 Compose 项目列表，并对每个项目拉取 compose ps 状态。
  - 稳定锚点：`Compose 项目`（页面标题）、`新建项目` 按钮、`暂无 Compose 项目` 空态。
  - 列表列：项目名、状态（已配置/未配置）、服务、操作按钮（启动/停止/重启/配置/删除）。
  - 新建项目弹窗：`项目名称`、`docker-compose.yml`、模板下拉（空白 + 内置模板）、`创建` / `取消` 按钮。
  - 查看配置弹窗：`${configTitle} - 配置`，`pre.config-viewer` 展示文件内容，`关闭` 按钮。
  - 错误态：`拉取项目列表失败`。

### Source 2: server/src/routes/compose.ts
- Route endpoints: router.get('/api/compose') 等（共 12 个 get/post/delete）。

## Synthesized Findings

### Regression Focus
- 页面外壳：`Compose 项目`、`新建项目`；列表或空态 `暂无 Compose 项目`。
- 打开「新建项目」弹窗应看到 `项目名称` / `docker-compose.yml` / `创建` / `取消`，随后关闭（不创建）。
- 若有项目，点「配置」打开 `${name} - 配置` 只读弹窗并关闭。
- 采集网络/控制台错误；不得出现 `拉取项目列表失败`。
- 不触发启动/停止/重启/删除，不提交新建表单。
