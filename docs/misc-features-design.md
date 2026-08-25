# 短小方向合集 · 实施设计（Prometheus / 工具箱 / 构建可视化 / 端口地图 / 安全基线·审批流）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档：`docs/competitor-analysis-brainstorm.md` 第二梯队 #7/#8、第三梯队 #9/#11/#12。
> 这五个方向相对独立、成本适中，合并成一份便于分批排期。每个方向含：目标、接口/模块、前端、任务拆分、验证清单。

---

## 方向 A · Prometheus / Grafana 对接

**目标**：暴露 `/metrics`（Prometheus 文本格式），导出可导入的 Grafana Dashboard JSON，提升可观测性专业度。

**现状**：已有 `monitor.ts`（`getMetricsRange` 1h/7d）、`containerMetrics.ts`、`host_metrics`/`container_metrics` 落库。

**设计**：
- **新路由** `server/src/routes/metrics.ts`（挂 `/metrics`，**无需鉴权**或专用只读 token，供抓取器）。
- 采集：遍历主机指标 + 各容器 `stats` → 输出 Prometheus 文本（`# HELP`/`# TYPE`+ `dm_cpu_*`/`dm_mem_*` 等命名，遵循项目命名族）。
- **导出**：`GET /api/system/grafana-dashboard` 返回可下载的 Dashboard JSON（板内引用上述 metric 名）。
- 命名建议：`dm_engine_cpu_percent`、`dm_engine_mem_used_bytes`、`dm_container_cpu_percent{container}`、`dm_container_mem_usage_bytes{container}`。

**任务**：T1 写 `/metrics` 文本生成（复用 monitor/stats）；T2 写 Grafana JSON 导出；T3 前端「监控」页加「导出 Grafana」按钮；T4 编译+回归。
**验证**：`curl` `/metrics` 返回合法 Prometheus 文本；导入 Grafana 后图表名与示例一致；面板旧功能零回归。

---

## 方向 B · Web 运维工具箱

**目标**：内置运维常用小工具（差异化体验）。

**设计**：纯前端 `/tools` 页，含卡片：YAML/JSON 校验、jq 风格过滤、正则测试、Base64、时间戳↔日期、进制转换、端口/网段计算。全部浏览器内实现，零后端。

- `web/src/pages/tools.tsx` + `tools.less`，NAV_ITEMS 加「工具箱」。

**任务**：T1 页面骨架 + 各工具组件（可逐个迭代）；T2 注册菜单路由；T3 编译+回归。
**验证**：各工具输入输出正确；页面零依赖、离线可用。

---

## 方向 C · 镜像构建可视化（层 + 时长对比）

**目标**：已有构建历史与 `/layers`；增强为「构建层清单 + 各层大小热力图 + 多次构建时长对比」。

**设计**：
- 复用 `GET /api/images/:name/layers`（`docker history`）；前端 `imageDetail.tsx` 加**热力图**（按层大小着色）。
- 多次构建：`image_build_history`（已有 build.ts 记录耗时）→ `build.tsx` 加「历史构建时长对比柱状图」（ECharts 已内置）。

**任务**：T1 层热力图；T2 构建时长对比图；T3 编译+回归。
**验证**：大层高亮可辨识；历史构建对比图数据正确；构建/镜像详情页零回归。

---

## 方向 D · 全局端口占用地图像

**目标**：在已有"端口占用检测"上升级为**跨引擎全局端口地图**。

**设计**：
- **新路由** `server/src/routes/ports.ts`（挂 `/api/ports`）：遍历多个引擎/容器的 `PortBindings` → 汇总 `已占用端口: [容器...]`；检测拥挤/冲突。
- 前端 `/ports` 页：端口范围图表 + 冲突高亮 + 点端口看占用容器。
- 复用 `aggregate.ts` 的跨引擎遍历思路。

**任务**：T1 路由聚合并检测冲突；T2 前端端口地图；T3 编译+回归。
**验证**：多容器同端口冲突标红；跨引擎聚合正确；既有端口检测零回归。

---

## 方向 E · 安全基线 / 策略即代码 + 高危操作审批流

> 本方向面向企业/团队场景，安全敏感，设计需谨慎。建议作为**中长线**，本期可先做"安全基线扫描（只读）"，审批流二期。

**设计**：
- **安全基线（只读，一期）**：`server/src/policy.ts` + `routes/policy.ts`，扫描存量容器，产出不满足项：
  - 禁止 `privileged`；强制 `Memory`/`NanoCpus` 限制；必须定义 `restart`；禁止挂载 `/` `/etc` `/var/run/docker.sock`；容器必须带 `owner` label 等。
  - `GET /api/policy/scan` 返回违规清单（容器 + 规则 + 严重度）。
- **审批流（二期，本期仅留设计）**：危险操作（删除/绑宿主根卷/开 privileged）改为写入 `approvals` 表 → admin 审批后执行；`server/src/auth.ts`/`containers.ts` 创建链路插桩。

**任务**：T1 policy 规则引擎 + 扫描；T2 前端 `/policy` 页展示违规；T3（二期）approvals 表 + 审批接口 + 创建链路拦截；T4 编译+回归。
**验证**：特权容器被标记违规；admin 看到扫描报告；审批流二期内不阻塞可移除。

---

## 汇总优先级建议

| 方向 | 优先级 | 理由 | 说明 |
|------|:------:|------|------|
| B 工具箱 | ⭐⭐ | 成本最低、纯前端、差异化 | 可最先做 |
| C 构建可视化 | ⭐⭐ | 复用现有数据、见效快 | 紧跟 B |
| D 端口地图 | ⭐⭐ | 复用跨引擎聚合 | 依托 T1 复用 aggregate |
| A Prometheus | ⭐ | 专业对接、需稳妥命名 | 需确认 metric 稳定性 |
| E 安全基线 | ⭐ | 企业向、安全敏感 | 一期只读扫描；二期审批流 |

> 全部方向兼容"零第三方运行时依赖、Windows、Node≥22、SQLite"约束；A 的 `/metrics` 与 B 的纯前端工具零依赖最契合项目哲学。
