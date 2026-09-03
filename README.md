# Docker Manager（Docker 管理面板）

一个跨平台的 Docker 容器管理面板（类似 1Panel），支持 **Windows**、**Ubuntu 24** 和 **RHEL 9 系**（AlmaLinux / Rocky），提供浏览器可视化管理 Docker 引擎的能力。支持容器、镜像、数据卷、网络、Compose、应用商店、Docker Hub 镜像搜索/拉取、实时监控、容器终端等核心功能。

## ✨ 功能特性

- **总览监控**：Docker 引擎信息、系统资源实时曲线（CPU / 内存 / 网络 / 磁盘分区）；支持 NVIDIA GPU 利用率 / 显存 / 温度监控（`nvidia-smi`）
- **容器管理**：列表、启停/删除/重启/克隆、镜像过滤、查看日志与详情、内置 Web 终端（xterm.js + WebSocket）、设置重启策略等
- **镜像管理**：列表、拉取/推送/导入/导出、删除、打标签、清理、镜像详情与构建历史；支持多镜像源自动切换与失败重试；展示构建时间与本地拉取时间
- **构建镜像**：基于宿主机目录的 Dockerfile 独立构建（支持构建参数 / noCache），构建结果持久化为**构建历史**（可回溯日志、一键复用配置、清空）
- **镜像源（Hub）**：配置国内镜像加速源（内置轩辕、1ms）、Docker Hub 在线搜索、常用镜像快捷拉取
- **数据卷 / 存储 / 网络**：卷与网络列表、创建、删除、清理未使用；存储使用统计与一键回收
- **Compose**：编排文件查看与编辑、`docker compose up / down / pull / build`
- **应用商店（AppStore）**：内置应用目录，一键安装部署
- **计划任务**：定时任务（周期 / 依存的容器操作、定时安全基线扫描并推送违规变更告警等）管理
- **文件管理**：容器内文件浏览 / 上传 / 下载 / 编辑
- **宿主机文件 / 终端**：宿主机文件浏览与远程终端（xterm）
- **Docker 引擎**：多 Docker 引擎端点管理（新增 / 编辑 / 设为当前 / 删除）
- **数据库可视化**：容器数据库 / Redis 的可视化查询与信息查看（只读保护）
- **备份恢复**：DATA / Compose / 卷 / 站点备份恢复中心；支持将备份文件**上传到云端**（S3 / OSS / WebDAV）
- **云端备份**：S3 / OSS / WebDAV 目标配置（零第三方依赖，https 手写）、连通性测试、文件上传
- **站点反代 / SSL**：基于反代容器的站点反向代理、启停与配置 reload、SSL 证书状态与替换
- **防火墙**：Windows 防火墙入站端口放行管理（基于系统 `netsh`，管理员权限提示）
- **事件流**：实时查看 Docker 引擎事件（含统计可视化）；事件**持久化到 SQLite**，可查询**历史**、**导出 CSV**、清空
- **操作日志**：管理操作审计日志，含统计与 JSON / CSV 导出；**保留天数可配置**（默认 90 天），超期数据每日自动清理，AI 用量明细 / 巡检记录同模式（默认 30 天）
- **告警中心 / 通知渠道（C3）**：宿主级（CPU / 内存 / 磁盘 / GPU / 网络带宽 Mbps）与容器级（退出 / 健康状态 / 端口监听 / CPU 内存阈值）告警规则；支持**静默时段 / 仅工作日 / 工作时间**；**推送窗口聚合防风暴**（窗口内多条告警合并为一条摘要，恢复通知始终即时，不同级别分桶发送）；**连续周期防抖**（连续 N 个采样周期超阈值才触发，过滤瞬时毛刺）；**多渠道路由**（仅首个 / 全部启用渠道 / 按级别路由：warn / danger / recovery 各自勾选目标渠道）；**渠道消息模板**（{{level}} / {{message}} / {{time}} / {{channel}} 变量按渠道渲染）；**容器自愈**（按容器名监听健康检查失败或退出，自动重启/拉起，冷却期防重，全程留痕推送）；通知渠道（Webhook / 邮件 / 钉钉 / 飞书 / Telegram / 企业微信 / Slack，敏感凭证加密存储）；**渠道送达率统计**（按渠道聚合推送成功 / 失败 / 成功率与最近失败明细）；**高危操作审批流**（非管理员危险操作转审批，审批中心含近 30 天统计看板与**记录导出 CSV**）；告警记录查询、**CSV 导出 / 归档**、实时资源快照手工检测
- **镜像漏洞扫描**：镜像详情页基于本机 **Trivy** 的 CVE 漏洞扫描（零 npm 依赖，按严重等级分级，未安装时给出引导文案）
- **容器模板 / Compose 模板库**：一键保存 / 复用容器创建配置（`/api/templates`）与 Compose 编排模板，支持"从模板创建"回填
- **编排（启动依赖排序）**：为容器配置启动依赖，拓扑排序（含环检测）+ 一键分层并行启动 / 逆序停止 / 重启，编排历史失败项可重试
- **Swarm 服务管理**：Swarm 集群状态、服务列表 / 详情、服务删除与副本伸缩（未启用 Swarm 时写入优雅降级）
- **跨引擎容器迁移 / 镜像传输**：`docker save | load` 管道直通式跨引擎镜像迁移与容器迁移（自动带镜像传输），适合大镜像不占内存
- **跨引擎聚合总览**：一次展示多台 Docker 主机的资源与对象数量（单引擎离线不影响其它）
- **全局搜索**：顶栏全局搜索，跨 容器 / 镜像 / 卷 / 网络 / Compose 聚合匹配并跳转
- **系统健康体检**：聚合引擎状态、资源使用率、未使用对象与容器重启状态，输出 0-100 健康评分与逐项体检
- **容器资源占用看板**：总览页 Top CPU / Top 内存容器排行
- **监控持久化历史**：实时监控数据落库，提供 1 小时 / 24 小时 / 7 天历史趋势
- **模板 / 镜像中心增强**：镜像分类批量清理、创建容器端口占用检测、镜像漏洞扫描与构建历史
- **配置导入 / 导出**：面板配置 JSON 级选择性导入导出（引擎 / 模板 / 计划任务 / 站点 / 告警规则 / 通知渠道 / 云端目标 / 数据库实例 / 镜像源 / 用户），敏感字段支持脱敏占位导出与导入端重新加密，冲突策略 skip / overwrite / error
- **Webhook / Git 自动部署**：计划任务支持匿名 **Webhook token** 触发（`POST /api/webhook/:token`，可选 Header 二次校验）与 **Git 仓库 clone / pull 自动部署**（HTTPS / SSH 凭证加密存储）
- **用户与鉴权**：登录鉴权、会话管理、用户增删/改密、RBAC（内置 admin / operator / user / auditor 四角色 + **自定义角色与操作白名单**：14 项资源域权限按组勾选授权）、前端操作入口按权限显隐、内置权限边界自动化测试
- **系统设置**：主题、界面语言（中文 / English，i18n 骨架 + 五批英文包全量覆盖（中英双语完整支持），未翻译页面自动回退中文）等偏好设置；告警静默 / 快捷引导等
- **日志聚合**：跨容器日志检索、过滤与导出，排障刚需一步到位
- **网络拓扑**：容器-网络-端口关系可视化（跨引擎聚合）
- **容器标签体系**：自定义标签管理与按标签过滤（容器 / 卷 / 镜像详情）
- **数据卷精细管理**：卷克隆（跨引擎）、导出为 tar、标签过滤
- **构建进度与可视化**：构建日志 SSE 实时推送；镜像层大小热力图、历史构建时长对比条形图
- **运维工具箱**：JSON 格式化 / 校验、正则测试、Base64、时间戳、进制转换、端口与网段计算等常用小工具（纯前端）
- **端口地图**：跨引擎端口占用聚合、冲突检测与端口分布图
- **Prometheus / Grafana 对接**：内置 `/metrics` 指标端点（Prometheus 文本格式，可选 Token 鉴权），一键导出可导入的 Grafana Dashboard JSON
- **安全基线扫描**：特权容器、敏感挂载（docker.sock 等）、资源限制、重启策略、属主标签等 6 项基线只读检查与违规报告；内存 / CPU / 重启策略违规支持在线一键修复（非管理员可配置走审批流）
- **高危操作审批流**：开启后非管理员的删除容器/卷、停止编排、批量删镜像、清理类等高危操作自动进入「审批中心」待审批，管理员批准后系统执行；支持手动提交镜像删除、网络清理等申请，全程留痕；支持批量批准/拒绝（拒绝理由必填）、AI 高危操作建议自动转审批单；支持两级审批链（第一级运维/管理员、末级强制管理员）与审批单编号（AP-YYYYMMDD-ID）、超时前自动催办
- **面板数据库备份**：面板自身 SQLite 数据库一致性快照（不停服），支持定时任务自动备份、保留份数自动清理、一键恢复（含完整性与格式校验）与下载
- **只读审计角色**：auditor 角色仅可查看监控 / 日志 / 审计信息，不可执行任何变更操作
- **安全加固**：2FA 双因素认证（TOTP，登录二步验证）、在线会话管理（列表 / 撤销 / 并发上限）、IP 白名单（全局 + 按用户，IPv4 CIDR）、密码策略（最小长度 / 复杂度 / 有效期过期强制改密）
- **可观测性**：主机 / 容器指标 7 天原始采样 + 90 天小时级聚合长周期曲线（30d/90d 时间窗）；Trivy 漏洞定时扫描计划任务，按 CVE id 差集对比、新增 Critical / High 自动推送告警，镜像详情内置扫描历史对比
- **AI 智能助手**（可选）：多模型配置中心（任意 OpenAI 兼容端点：云端 / Ollama / LM Studio 等，密钥加密存储）、AI 对话、文件分析、智能巡检、告警诊断、周报生成、知识库、Token 用量治理；未配置时入口自动隐藏，零常驻依赖
- **帮助中心**：内置快速上手指南、常见问题 FAQ 与全功能速查表
- **OpenAPI 接口文档**：`GET /api/openapi.json` 输出 OpenAPI 3.0 核心端点骨架（认证 / 监控 / 容器 / 镜像 / 审批等 34 路径），侧栏「API 文档」页按域分组浏览与搜索，便于二次开发与自动化对接
- **Kubernetes 只读巡检**：配置 kubeconfig 即可接入一个或多个 K8s 集群（多 context 切换、Pod 部署自动 InCluster）；集群概览（节点状态 / metrics-server 资源占用 / 1d-90d 节点资源趋势，快照落库接入 90 天小时级聚合）、工作负载巡检（Pod / Deployment / Service / PVC / ConfigMap / Secret 脱敏 / Ingress / Helm Release）、节点详情与 Pod 级指标落库（1d-90d 曲线）、事件本地持久化（集群不可达时回看 7 天历史）、Pod 详情（容器状态 / 日志 / 交互式终端 / CPU 与内存实时曲线）、集群事件（支持 WebSocket 实时流）；支持有限写操作（扩缩容 / 滚动重启 / 删除 Pod，接入高危操作审批流），不影响 Docker 管理功能
- **系统参数中心化**：面板级参数（安全开关、抓取 Token、压缩配置等）统一在「设置 → 系统参数」管理，带类型与分组描述

## 🧰 技术栈

| 层级        | 技术                                                                  |
| --------- | ------------------------------------------------------------------- |
| 前端        | React 18 · TypeScript · Vite · Less · xterm.js · ECharts(LineChart) |
| 后端        | Node.js ≥ 22 · TypeScript · Express 4 · ws（WebSocket）              |
| Docker 交互 | dockerode（Docker Engine API）                                        |
| K8s 交互   | @kubernetes/client-node（kubeconfig / InCluster）                     |
| 数据存储      | SQLite（node:sqlite，零依赖）                                          |
| 打包发布      | Windows: NSIS + NSSM + TrayApp · Linux: deb/rpm + systemd          |

## 💾 数据存储说明（SQLite，无第三方数据库服务）

> 本项目使用 **SQLite** 作为数据存储，基于 **Node.js 内置的** **`node:sqlite`** **模块**，**零第三方依赖、零编译**（无需安装 MySQL / PostgreSQL 等数据库服务）。

所有业务数据统一存储在 **`data/docker-manager.db`** 这一个 SQLite 数据库文件（自包含、可整体复制备份），由后端通过 `node:sqlite` 的 `DatabaseSync` 同步 API 读写。采用 WAL 日志模式，兼顾并发读与崩溃安全。

| 表                    | 内容                             | 对应模块                             |
| -------------------- | ------------------------------ | -------------------------------- |
| `users`              | 用户账号、盐值（salt）与加盐 scrypt 密码哈希   | `server/src/users.ts`            |
| `hub_sources`        | 镜像加速源列表（含内置默认源）                | `server/src/hubConfig.ts`        |
| `setting`            | 键值配置（如自定义搜索源基址 `searchSource`） | `server/src/hubConfig.ts`        |
| `image_pull_history` | 镜像 ID → 本地拉取时间戳（秒）映射           | `server/src/imagePullHistory.ts` |
| `operation_logs`     | 管理员操作审计日志                       | `server/src/operationLog.ts`     |
| `cron_tasks` / `cron_task_logs` | 计划任务定义与执行日志            | `server/src/routes/tasks.ts`     |
| `appstore_instances` / `appstore_app_params` | 应用商店已安装实例与应用参数 | `server/src/appstore/`           |
| `database_instances` | 数据库 / Redis 可视化实例定义            | `server/src/routes/databases.ts` |
| `docker_engines`     | 多 Docker 引擎端点配置                | `server/src/routes/engines.ts`   |
| `cloud_targets`      | 云端备份目标（S3 / OSS / WebDAV）    | `server/src/routes/cloud.ts`     |
| `sites`              | 站点反代配置                          | `server/src/routes/sites.ts`     |
| `backups`            | 备份记录（DATA / Compose / 卷 / 站点） | `server/src/backup/manager.ts`  |
| `image_build_history`| 镜像构建历史（日志预览 / 耗时 / 结果）      | `server/src/routes/build.ts`     |
| `docker_events`      | Docker 事件持久化历史（实时事件落库）       | `server/src/docker/events.ts`   |
| `firewall_ports`     | Windows 防火墙放行端口规则              | `server/src/routes/firewall.ts`  |
| `notify_channels`    | 告警通知渠道（Webhook/邮件/钉钉/飞书/Telegram/企业微信/Slack，敏感凭证加密） | `server/src/notify.ts`           |
| `alert_rules`        | 宿主级告警规则（CPU/内存/磁盘/GPU/网络带宽等，含静默时段） | `server/src/alerting.ts`         |
| `alert_records`      | 告警触发记录 / 归档 / 导出                | `server/src/alerting.ts`         |
| `container_alert_rules` | 容器级告警规则（退出/健康/端口监听/CPU/内存阈值） | `server/src/alerting.ts`         |
| `host_metrics` / `container_metrics` | 资源监控持久化（1h/24h/7d 历史趋势） | `server/src/docker/monitor.ts`   |
| `container_templates`| 容器模板库（一键回填创建配置）              | `server/src/routes/templates.ts` |
| `compose_templates`  | Compose 编排模板库                      | `server/src/routes/composeTemplates.ts` |
| `appstore_custom_apps` | 应用商店自定义应用                     | `server/src/appstore/`           |
| `container_dependencies` | 容器启动依赖编排（拓扑排序）           | `server/src/routes/orchestrate.ts` |
| `orchestrate_runs`   | 编排执行历史（失败项可重试）               | `server/src/routes/orchestrate.ts` |
| `approvals`          | 高危操作审批单（含批量审批 / AI 转审批）    | `server/src/routes/approvals.ts` |
| `roles`              | 自定义角色与操作白名单（RBAC）              | `server/src/rbac.ts`             |
| `selfheal_rules`     | 容器自愈规则（unhealthy/退出自动恢复，冷却期） | `server/src/selfheal.ts`         |

> **旧版兼容**：早期版本使用 JSON/文本文件存储（`data/users.json`、`data/hub-sources.json`、`data/hub-search-source.txt`、`data/image-pull-history.json`）。服务启动时会自动将旧文件数据迁移进 SQLite，并把旧文件重命名为 `.bak` 备份，实现平滑升级、不丢失任何现有配置。

### 鉴权与会话

- 登录采用**内存 Token 方案**（`server/src/auth.ts`）：登录成功后生成随机会话 Token，存于内存 `Map` 并带过期时间（默认 24 小时，可用 `AUTH_TTL_HOURS` 调整）。
- 请求携带 `Authorization: Bearer <token>`，由 `requireAuth` 中间件校验。
- 会话 Token 仅存内存，服务重启后失效，不落库（属于短期会话态，无需持久化）。

### 安全与保障

- 用户密码采用 **scrypt 加盐哈希**（`crypto.scryptSync`），绝不保存明文。
- 通知渠道密钥 / 云端备份密钥 / 数据库口令 / Git 部署凭证等敏感字段采用**对称加密**落库（`storage.ts` 的 `encryptSecret`），前端回显仅标记"已配置"。
- SQLite 数据库文件随 `data/` 目录自动创建；用户表为空时自动以默认管理员初始化，保证首次启动可用。

## 🏗️ 整体系统架构

```mermaid
flowchart TB
    subgraph Browser["浏览器"]
        UI["React 前端 (Vite)<br/>页面 / 路由 / 组件"]
    end

    subgraph Backend["Node.js 后端 (Express, 端口 9528)"]
        API["REST API 路由<br/>/api/*"]
        WS["WebSocket 服务<br/>容器终端 / 事件 / 监控"]
        AUTH["鉴权中间件<br/>内存 Token 会话"]
        MOD["业务模块<br/>containers/images/volumes/networks<br/>compose/appstore/hub/alerting/templates<br/>orchestrate/swarm/transfer/config"]
        STORE["SQLite 存储层<br/>storage.ts + users/hubConfig/imagePullHistory"]
    end

    subgraph Data["数据层 (data/ 目录, 单文件 SQLite)"]
        DB["docker-manager.db"]
    end

    subgraph Docker["Docker 引擎"]
        DAPI["dockerode (Engine API)"]
        D["Docker Desktop (WSL2)<br/>/ 远程引擎"]
        MG["镜像 / 容器 / 数据卷 / 网络<br/>Compose 编排"]
    end

    subgraph Ext["外部服务"]
        HUB["Docker Hub / 镜像加速源"]
    end

    UI -- "HTTP /api + WebSocket /ws" --> API
    UI -- "Xterm 交互" --> WS
    API --> AUTH
    AUTH --> MOD
    MOD --> STORE
    STORE --> DB
    MOD -- "dockerode" --> DAPI
    DAPI --> D --> MG
    D -- "拉取/搜索镜像" --> HUB
```

### 请求链路（示例：拉取镜像）

```
浏览器 images 页
  → POST /api/images/pull {ref, source}
  → requireAuth 校验 Token
  → images 路由：按镜像源顺序尝试 docker.pull
  → 成功后 inspect 获取镜像 Id，recordPullTime 写入 image_pull_history 表（SQLite）
  → 返回 {ok, ref, source, progress}
```

### 开发态前后端代理

- 前端开发服务端口 **9526**（Vite），将 `/api` 代理到 `http://localhost:9528`。
- 后端服务端口 **9528**，前端静态文件由后端在生产模式下一并托管，实现单进程部署。

## 📁 目录结构

```
dockerDesktop/
├── web/                        # 前端工程（React + Vite + TS）
│   └── src/
│       ├── pages/              # 各业务页面
│       ├── components/         # 通用组件（Button/Modal/Form/Layout/Toast 等）
│       ├── api/                # 请求封装与鉴权
│       ├── hooks/              # 自定义 hooks（日志、主题）
│       ├── types/              # 类型定义
│       └── styles/             # 全局样式
├── server/                     # 后端工程（Express + TS）
│   └── src/
│       ├── routes/             # REST API 路由
│       ├── docker/             # dockerode 客户端、监控、事件、终端
│       ├── appstore/           # 应用商店目录、状态与自定义应用
│       ├── platform/           # 平台抽象层（Windows/Ubuntu/CentOS 的 detect / exec）
│       ├── storage.ts          # SQLite 存储层（连接/建表/旧数据迁移/凭证加密）
│       ├── auth.ts             # 会话鉴权与 RBAC 守卫
│       ├── users.ts            # 用户存储（SQLite users 表）
│       ├── hubConfig.ts        # 镜像源存储（SQLite hub_sources/setting 表）
│       ├── imagePullHistory.ts # 拉取时间存储（SQLite image_pull_history 表）
│       ├── alerting.ts         # 告警规则检测与记录（宿主级/容器级，含连续周期防抖）
│       ├── notify.ts           # 通知渠道（Webhook/邮件/钉钉/飞书/Telegram/企业微信/Slack）推送
│       ├── trivyCli.ts         # 零依赖 Trivy 镜像漏洞扫描封装
│       ├── gitCli.ts           # 零依赖 Git CLI 封装（clone/pull + 凭证注入）
│       └── scheduler.ts        # 计划任务调度与下次执行时间计算
├── data/                       # 运行时数据（SQLite 数据库 + 旧 JSON 迁移备份，自动生成）
├── packaging/                  # 打包脚本与 NSIS 安装包工具
└── dist-release/               # 发布产物（构建生成）
```

## 📋 环境要求

- **Node.js ≥ 22**（推荐使用 LTS 版本）
- **npm**（随 Node.js 安装）
- 已启动的 **Docker 引擎**
  - **Windows**：Docker Desktop（需开启 WSL2 后端）
  - **Linux**：docker-ce + docker-compose-plugin（Ubuntu 24 / Debian 12 / RHEL 9 系；Node 22 要求 glibc ≥ 2.28，CentOS 7 无法运行）

## 🚀 安装与运行

### 方式一：源码开发模式

```bash
# 1. 安装依赖（根目录会自动处理 server / web 两个工作区）
npm install

# 2. 启动后端（端口 9528，ts-node-dev 支持热重载）
npm run dev:server

# 3. 另开终端启动前端（端口 9526，自动代理 /api 到后端）
npm run dev:web
```

打开浏览器访问 `http://localhost:9526`。

### 方式二：生产构建 & 本地运行

```bash
# 构建前后端（输出到 server/dist 与 web/dist）
npm run build

# 运行后端（生产模式，自动托管 web/dist 前端静态文件）
cd server && npm start
```

打开浏览器访问 `http://localhost:9528`。

### 方式三：打安装包

#### Windows

```bash
# 生成发布目录 dist-release/DockerManager（含 NSSM、托盘、安装脚本）
npm run package

# 一键生成 NSIS 安装包 setup.exe（自动调用 package 并编译）
npm run package:installer
```

生成 `DockerManager-setup-1.5.0.exe` 安装包，在目标 Windows 电脑上运行即完成安装。

#### Linux（Ubuntu 24 / RHEL 9 系）

```bash
# 方式 A：使用安装脚本（推荐）
# 1. 从 GitHub Releases 下载对应平台的安装包
# 2. 解压后运行安装脚本
sudo bash install.sh

# 方式 B：从源码打包（Docker 容器内构建）
npm run package          # 生成 dist-release/DockerManager
npm run package:deb -- amd64   # 生成 .deb 包（Ubuntu 24，需要 Docker）
npm run package:rpm -- x86_64  # 生成 .rpm 包（AlmaLinux 9，需要 Docker）
```

> - .rpm 包基于 **AlmaLinux 9** 构建环境生成（Node 22 官方二进制要求 glibc ≥ 2.28，CentOS 7 无法运行）。
> - Windows 上本机 bash 为 WSL 且未接入 Docker Desktop 时，可直接用 PowerShell 驱动：`packaging/linux/build-deb-win.ps1` / `build-rpm-win.ps1`。

安装完成后通过 `systemctl` 管理服务：

```bash
sudo systemctl start docker-manager    # 启动
sudo systemctl status docker-manager   # 查看状态
sudo systemctl enable docker-manager   # 开机自启
```

### 🧪 测试（源码模式）

```bash
npm run test:server:unit        # 后端单元测试（含推送聚合器等纯函数模块）
npm run test:server:api         # API 集成测试（需后端运行在 9528）
cd e2e && npx playwright test   # Playwright E2E 冒烟（登录/容器/审批/基线/计划任务）
```

## 🔑 使用说明

| 项目     | 说明                                            |
| ------ | --------------------------------------------- |
| 默认登录账号 | `admin`                                       |
| 默认登录密码 | `admin888`                                    |
| 默认端口   | `9528`（后端）/ `9526`（前端开发）                      |
| 会话有效期  | 24 小时（可用环境变量 `AUTH_TTL_HOURS` 调整）             |
| 数据目录   | Windows: `<安装目录>/data/` · Linux: `/var/lib/docker-manager/` |

### 环境变量

| 变量                          | 说明                                             | 默认值                  |
| --------------------------- | ---------------------------------------------- | -------------------- |
| `PORT`                      | 后端监听端口                                         | `9528`               |
| `HOST`                      | 后端监听地址                                         | `0.0.0.0`            |
| `DOCKER_HOST`               | Docker 引擎端点（`npipe://` / `unix://` / `tcp://`） | 自动探测                 |
| `ADMIN_USER` / `ADMIN_PASS` | 初始管理员账号/密码                                     | `admin` / `admin888` |
| `AUTH_TTL_HOURS`            | 会话过期小时数                                        | `24`                 |
| `STATIC_DIR`                | 生产模式前端静态目录（可选）                                 | `web/dist`           |
| `DOCKERMANAGER_DATA`        | 自定义数据目录路径（Linux 可选）                              | `/var/lib/docker-manager` |

## ⚙️ 环境变量补充说明：Docker 引擎连接

后端通过 `server/src/docker/client.ts` 自动探测可用的 Docker 引擎，按以下顺序连接（使用真实 `ping` 验证）：

**Linux**：
1. 环境变量 `DOCKER_HOST` 显式指定的端点
2. `unix:///var/run/docker.sock`（Linux 默认）

**Windows**：
1. 环境变量 `DOCKER_HOST` 显式指定的端点
2. `npipe:////./pipe/dockerDesktopLinuxEngine`（Docker Desktop WSL2）
3. `npipe:////./pipe/docker_engine`（Windows 默认）

> 注意：Windows named pipe 无法用 `fs.existsSync` 检测，需通过真实连接验证，因此新增端点会自动尝试逐个探测。

<br />

功能总览：

![总览](images/1.png "总览")
![监控体检](images/2.png "监控体检")
![容器](images/3.png "容器")
![容器模板](images/4.png "容器模板")
![编排](images/5.png "编排")

![镜像](images/6.png "镜像")

![构建镜像](images/7.png "构建镜像")

![数据卷](images/8.png "数据卷")

![存储](images/9.png "存储")

![储存](images/9-1.png "存储")

![网络](images/10.png "网络")

![Compose](images/11.png "Compose")

![应用商店](images/12.png "应用商店")

![计划任务](images/13.png "计划任务")

![文件管理](images/14.png "文件管理")

![宿主机文件](images/15.png "宿主机文件")

![宿主机终端](images/16.png "宿主机终端")

![Docker引擎](images/17.png "Docker引擎")

![云端备份](images/18.png "云端备份")

![Swarm](images/19.png "Swarm")

![备份恢复](images/20.png "备份恢复")

![数据库](images/21.png "数据库")

![设置](images/22.png "设置")

![设置](images/22-1.png "设置")

![镜像中心](images/23.png "镜像中心")

![操作日志](images/24.png "操作日志")

![警告中心](images/25.png "警告中心")

![事件流](images/26.png "事件流")

![站点反代](images/27.png "站点反代")

![防火墙](images/28.png "防火墙")

![安全基线扫描](images/policy.png "安全基线扫描")

![审批中心](images/approvals.png "审批中心")

![面板数据库备份](images/settings-db-backup.png "面板数据库备份")



## 🧪 常见问题

- **提示"无法连接 Docker 引擎"**：请确认 Docker Desktop 已启动，必要时设置 `DOCKER_HOST` 环境变量指向可用的引擎端点。
- **镜像搜索失败（502 / 无法搜索）**：国内大多数镜像加速站只代理镜像**拉取**，并不实现 Docker Hub 的 `search` 接口，因此搜索会失败。解决办法：
  - 在**镜像中心 → 镜像源 → 搜索源**填入一个支持搜索的源，例如 `https://docker-0.unsee.tech`（备用 `https://docker.tbap.top`），保存后即可在线搜索。完整实测明细与配置步骤见 [可搜索镜像源文档](docs/docker-hub-search-sources.md)。
  - 上述可搜索源为社区公益服务，可能限流或变更；搜索仍不可用时，可直接在镜像中心点选"常用镜像"，或在"拉取镜像"输入已知镜像名（走镜像源拉取可靠）。
  - 本地开发/自动化回归可启动自带的本地 mock 搜索服务（`npm run mock:hub-search`）作为不依赖外网的兜底。
- **忘记密码**：停止服务后删除 `data/docker-manager.db`（及同目录 `-wal` / `-shm` 文件），重新启动服务，会以 `ADMIN_USER` / `ADMIN_PASS`（默认 `admin` / `admin888`）重新初始化管理员和默认配置。
- **备份/迁移数据**：只需复制整个 `data/` 目录（核心是 `docker-manager.db`）即可完成配置的备份与迁移。详见 [数据迁移指南](docs/migration-guide.md)。
- **镜像漏洞扫描不可用**：镜像详情页的漏洞扫描依赖宿主机已安装 **Trivy**（未安装时会给出引导文案）。可在目标机器安装 Trivy 后刷新即可启用。
- **Webhook 触发任务无反应**：确认计划任务已配置并启用 `webhook_token`，用 `POST /api/webhook/:token` 触发；如需二次校验可在 Header 携带 `X-Docker-Panel-Token`。
- **Linux 安装后无法连接 Docker**：确保 `dockerman` 用户已加入 `docker` 组（`sudo usermod -aG docker dockerman`），并重启服务。

## 📜 License

本项目采用 MIT 许可证 - 查看 [LICENSE](https://github.com/13861419/dockerDesktop/blob/main/LICENSE) 文件了解详情。
