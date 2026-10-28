> 提交前确认：CI 五个 job（unit / typecheck / docs / api / e2e）本地可验证项已通过；
> AI 审查发现已全部回应（修复或带理由关闭线程）。审查标准见根目录 `REVIEW.md`。

## 变更说明

<!-- 为什么做这个变更？解决什么问题？ -->

## Testing（怎么验证的）

<!-- 粘贴测试输出 / 截图 / regression:* 结果。没有证据 = 未验证。 -->

- [ ] `npm run test:server:unit` 通过（新增测试文件已加入显式清单）
- [ ] 类型检查通过（web `tsc -b` + server `--noEmit`）
- [ ] 涉及 API/页面行为的改动跑过对应 `npm run regression:<页面>` 或 e2e
- [ ] 文档同步：CHANGELOG / README / 操作手册（中英）/ 帮助中心（`npm run docs:check` 通过）

## Risk（风险与爆炸半径）

<!-- 风险档位：Quick / Standard / Deep（标准见 REVIEW.md）。
     是否触碰高风险区：认证凭据 / 命令执行 / 主机文件 / 防火墙站点 / schema / 打包升级？ -->

- 风险档位：
- 影响范围：

## How to revert（怎么撤销）

<!-- 一句话说明撤销方式：revert commit / 数据库迁移回滚 / 无需特殊处理。 -->
