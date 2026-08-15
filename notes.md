# Notes: Volumes Page Regression

## Sources

### Source 1: web/src/pages/volumes.tsx
- Key points:
  - 页面拉取 `/api/volumes` 显示数据卷列表。
  - 支持刷新、新建卷、清理未使用卷、删除卷。
  - 支持搜索卷名或挂载点，以及分页（每页 15/30/50 条、上一页/下一页、页码跳转）。
  - 详情弹窗拉取 `/api/volumes/:name` 和 `/api/containers?all=true`。
  - 空态文案：`暂无数据卷`、`未找到匹配数据卷`。
  - 列表列：`名称`、`驱动`、`挂载点`、`创建时间`。

## Synthesized Findings

### Regression Focus
- 页面加载后应出现 `数据卷`、`搜索卷名或挂载点`、`新建卷`、`清理未使用卷`、`刷新`。
- 空态应包含 `暂无数据卷` 或 `未找到匹配数据卷`。
- 搜索填入不匹配关键字后应出现 `未找到匹配数据卷`。
- 详情弹窗应包含 `卷详情`、`名称`、`驱动`、`挂载点`。
- 采集网络错误和控制台错误，页面不应出现 `拉取数据卷列表失败`。
