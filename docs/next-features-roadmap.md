# Docker 管理面板 · 下一阶段功能路线图

> 生成日期：2026-08-19
> 视角：产品经理 + 架构师头脑风暴
> 依据：对 31 个前端页面、约 30 个后端路由模块、28 张 SQLite 业务表的完整盘点

## 结论

项目功能地基已相当扎实（无占位页），当前能力的"手动/定时"阶段已较完整。
下一阶段重点不在补漏，而在**向上抽象与自动化演进**，集中在四大战略主题：

- **主题 A · CI / 部署自动化**：从"手动 + 定时"升级为"事件驱动"
- **主题 B · 安全与合规**：增强镜像安全与审计
- **主题 C · 资源组织与精细化**：标签体系、卷管理、细粒度告警
- **主题 D · 多机与体验**：跨引擎批量操作、设置中心化

---

## 候选方向一览（10 项）

| # | 方向 | 核心功能 | 依赖（涉及文件 / 技术） | API 设计 | 优先级 |
|---|------|----------|--------------------------|----------|:------:|
| A1 | **Webhook 触发 + 自动部署流水线** | 新增 git-pull-build / compose-update-release 任务类型；暴露 Webhook 监听端点，代码 push → 拉取 → 构建 → 部署闭环 | `server/src/routes/tasks.ts`、`server/src/scheduler.ts`、`server/src/routes/build.ts`、`server/src/routes/compose.ts`；Git 走系统命令、构建走 dockerode（零第三方依赖） | `POST /api/webhook/:token`、`POST /api/tasks`（扩展 taskType） | ⭐⭐⭐ |
| A2 | **构建进度实时推送** | `docker build` 各阶段日志通过 SSE/WS 流式推送；支持多阶段 `target`、`--platform` 平台选择 | `web/src/pages/build.tsx`、`server/src/routes/build.ts`；复用 `ws`/SSE | `GET /api/build/:id/log`（SSE） | ⭐ |
| B1 | **镜像漏洞扫描** | 匹配/封装本机 Trivy 或轻量 CVE 匹配器；展示漏洞等级（严重/高危/中危）与修复建议 | `web/src/pages/imageDetail.tsx`、`web/src/pages/health.tsx`、`server/src/routes/images.ts`；可选调用本机 Trivy 二进制或自研匹配 | `GET /api/images/:name/scan` | ⭐⭐⭐ |
| B2 | **只读审计角色 + 敏感操作二次确认** | 新增"审计员"角色（只看不能操作资源）；删除/恢复/引擎切换追加二次确认端点 | `server/src/users.ts`、`server/src/auth.ts`、`web/src/components/RequireAuth.tsx`；扩展 RBAC 角色枚举 | `POST /api/operations/:id/confirm`、扩展 `Role` 类型 | ⭐ |
| C1 | **标签体系** | 容器/镜像/卷统一打标签（labels 已读取）；按标签过滤视图、一键启动业务分组、标签管理页 | `server/src/routes/containers.ts`（labels 已读取）、`web/src/pages/containers.tsx`、`web/src/pages/images.tsx`、`web/src/pages/volumes.tsx` | `GET/PUT /api/resources/:kind/:id/labels`、`GET /api/labels` | ⭐⭐ |
| C2 | **卷精细管理** | 卷大小/使用量统计、卷克隆、导出 tar 下载、未用卷清理 | `web/src/pages/volumes.tsx`、`server/src/routes/volumes.ts`、`server/src/routes/volumeFiles.ts` | `POST /api/volumes/:id/clone`、`GET /api/volumes/:id/export`、`DELETE /api/volumes` | ⭐ |
| C3 | **更细粒度告警** | 告警类型新增 GPU 使用率、网络 RX/TX、卷剩余空间、容器级 CPU/内存阈值 | `server/src/alerting.ts`、`server/src/notify.ts`、`web/src/pages/notifications.tsx`；复用现有 role 结构与推送链路 | 扩展 `alert_rules` / `container_alert_rules` 类型枚举 | ⭐⭐ |
| D1 | **跨引擎批量操作 + 网络拓扑** | 跨引擎批量启停/删除；容器-网络-端口关系拓扑可视化（纯前端 SVG） | `server/src/routes/engines.ts`、`server/src/routes/aggregate.ts`、`web/src/pages/networks.tsx`（已有拓扑先例） | `POST /api/engines/batch/:action`、`GET /api/topology` | ⭐ |
| D2 | **设置中心化** | 散落的环境变量默认值收敛为通用 KV 配置中心；设置页多 Tab（通用/运行/安全/数据保留/通知默认） | `server/src/storage.ts`（`setting` 表扩展为 KV）、`web/src/pages/settings.tsx` | `GET/PUT /api/settings`、`GET/PUT /api/settings/:key` | ⭐ |
| C3' | **镜像瘦身 / 层分析（已完成）** | 镜像层空间分析、Top 大层、瘦身建议 | 已实现于 `web/src/pages/imageDetail.tsx`、`server/src/routes/images.ts`（`/layers`） | `GET /api/images/:name/layers` | ✅ 完成 |

---

## 推荐优先级排序

| 优先级 | 方向 | 理由 |
|:------:|------|------|
| ⭐⭐⭐ 首选 | **A1 Webhook 自动化部署** | 带来"自动化"质变；复用 scheduler/build/compose；零第三方依赖可落地 |
| ⭐⭐⭐ 次选 | **B1 镜像漏洞扫描** | 安全是刚需 + 差异化卖点；挂在现有镜像详情/健康体检即可 |
| ⭐⭐ | **C3 更细粒度告警** | 复用成熟告警链路，增量小、见效快 |
| ⭐⭐ | **C1 标签体系** | 提升资源组织体验，中等成本 |
| ⭐ | B2 / C2 / D1 / D2 / A2 | 均值得，适合后续分批推进 |

---

## 战略主题说明

- **主题 A · CI / 部署自动化（A1、A2）**：当前任务系统仅 5 类、定时驱动；A1 引入 Webhook 触发器实现事件驱动闭环，A2 提升构建过程可观测性。
- **主题 B · 安全与合规（B1、B2）**：B1 补足镜像层安全能力，B2 补足合规审计与危险操作强确认。
- **主题 C · 资源组织与精细化（C1、C2、C3）**：C1 标签组织、C2 卷精细管理、C3 告警维度补全。
- **主题 D · 多机与体验（D1、D2）**：多引擎已有聚合查看，D1 扩展为跨引擎批量 + 拓扑，D2 收敛分散配置。

> 注：以上方向均与项目"零第三方运行时依赖、Windows、Node>=22、SQLite"约束兼容。
> A1/B1 建议优先推进，可直接进入 brainstorming → design → plan 流程落地。
