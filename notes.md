# Notes: Networks Page Regression

## Sources

### Source 1: web/src/pages/networks.tsx
- Key points:
  - 页面拉取 /api/networks 显示网络列表；失败态文案「拉取网络列表失败」。
  - 稳定锚点：页面标题「网络」、`新建网络`、`清理未使用网络`、`刷新` 按钮。
  - 空态：`暂无网络`（待确认）。
  - 列表项展示：名称、驱动、子网（IPAM.Config[0].Subnet）、是否内部。
  - 网络详情：点「详情」打开弹窗查看完整 inspect + 容器列表（只读）。弹窗内还有「连接容器」「断开容器」等操作，回归中不点击。
  - 删除/清理/创建均为破坏性，回归不触发。

### Source 2: server/src/routes/networks.ts
- Route endpoints: router.get ×2, router.post ×4, router.delete ×1, router.post(double? prune) etc.

## Synthesized Findings

### Regression Focus
- 外壳：`网络` 标题、`新建网络`、`清理未使用网络`、`刷新`。
- 列表或空态；采集「拉取网络列表失败」需置为失败。
- 打开网络详情弹窗验证只读渲染后关闭（若存在网络项）。
- 网络/控制台错误采集；不触发创建/删除/清理/连接/断开。
