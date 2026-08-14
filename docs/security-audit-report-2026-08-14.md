# DockerDesktop 安全审计报告

| 项目 | 内容 |
| --- | --- |
| 报告日期 | 2026-08-14 |
| 审计对象 | DockerDesktop 管理面板（server + web） |
| 审计类型 | 访问控制 / RBAC 权限审计 |
| 审计方法 | 后端路由逐条核对 `requireAdmin` 覆盖 + 前端角色联动交叉比对 + 竞品权限模型对照 |
| 风险等级说明 | **高**＝数据泄露/不可逆破坏；**中**＝越权控制；**低**＝信息泄露或一致性隐患 |

---

## 一、执行摘要

本次审计重点核查基于角色的访问控制（RBAC）在前后端的落地情况，覆盖：**写操作（增删改/执行/清理）** 与 **敏感数据读取（备份/用户/日志/宿主文件/终端）** 两端点。

**共发现并修复 13 项安全缺陷**，其中：

- 🔴 **高危 2 项**（认证缺失可致数据泄露 / 不可逆破坏）
- 🟠 **中危 5 项**（越权控制 / 越权配置）
- 🟡 **低危 / 一致性问题 6 项**（前端入口未联动、权限模型不一致）

审计结论：后端「写操作」整体已有 `requireAdmin` 兜底，但存在**若干敏感 GET 接口未受保护**，可被普通用户直接调用造成数据泄露；另有部分破坏性写路由（网络清理、数据库更新、容器克隆）初始遗漏了 `requireAdmin`。**以上均已在审计过程中修复并推送**，后端仍为最终可信权限边界。

---

## 二、审计范围与方法

### 2.1 范围

- **后端**：`server/src/routes/*.ts` 全部 23 个路由文件，逐条核对所有 `router.post / put / delete / get` 的 `requireAdmin` 覆盖情况。
- **前端**：`web/src/pages/*.tsx` 各业务页面的 `isAdmin() / canManage / canDelete` 联动情况，以及路由/侧边栏入口。
- **权限模型**：与主流通用容器管理平台（Portainer、K8s RBAC）的权限设计作对照。

### 2.2 方法

1. 枚举后端全部写路由，标注是否受 `requireAdmin` 保护；
2. 单独枚举**敏感读取类 GET 接口**（此前仅核查写操作，遗漏了读取侧）；
3. 前端各页面按钮/函数与后端作交叉比对，找出「前端开放 + 后端也开放」的缺口；
4. 竞品调研（Portainer 标准用户可启停、只读用户才全只读；K8s 普通运维可重启）确定容器生命周期操作的合理权限边界。

### 2.3 角色模型

当前为双角色：
- `admin`：全部操作（管理员）
- `user`：基础只读 + 容器日常启停/重启/暂停 + 看日志

后端通过中间件 `requireAdmin`（`server/src/auth.ts`）按服务端会话角色校验，为**唯一可信边界**；前端 `isAdmin()` 读取 localStorage 中的 `role`，仅用于按钮级体验控制。

---

## 三、漏洞分级统计

| 等级 | 数量 | 类型 |
| --- | --- | --- |
| 🔴 高 | 2 | 未授权敏感数据下载、未授权破坏性清理 |
| 🟠 中 | 5 | 越权控制 / 越权配置 / 越权枚举 |
| 🟡 低（一致性） | 6 | 前端未联动、权限模型不一致 |
| **合计** | **13** | |

---

## 四、漏洞详情

### 🔴 SEC-01【高危】数据库备份接口未授权，可下载含密码哈希的数据库

- **位置**：`server/src/routes/system.ts` → `GET /api/system/backup`
- **类型**：未授权敏感数据下载（Broken Access Control）
- **描述**：该接口导出整个面板 SQLite 数据库（含用户口令哈希、镜像源配置、操作日志等）。审计前**未加 `requireAdmin`**，任何已登录的普通用户通过 `GET /api/system/backup` 即可下载数据库文件。
- **影响**：口令哈希可被离线破解；镜像源配置（可能含私有仓库凭据）泄露；拖库。
- **修复**：补 `requireAdmin`；前端设置页「导出备份」按钮及 `handleBackup` 函数同步加管理员守卫。

### 🔴 SEC-02【高危】网络清理接口未授权，可一键破坏网络配置

- **位置**：`server/src/routes/networks.ts` → `POST /api/networks/prune`
- **类型**：不可逆的未授权破坏性操作
- **描述**：该接口批量断开并删除所有未被容器连接的自定义网络。审计前**未加 `requireAdmin`**，普通用户可调用造成业务网络拓扑被破坏。
- **影响**：清除全部未使用网络，影响依赖自定义网络的应用编排。
- **修复**：补 `requireAdmin`。

---

### 🟠 SEC-03【中危】用户枚举：`GET /api/system/users` 未授权

- **位置**：`server/src/routes/system.ts` → `GET /api/system/users`
- **类型**：信息泄露 / 用户枚举
- **描述**：返回全部用户名与角色。审计前未受保护。
- **影响**：普通用户可枚举账户，为口令爆破或社工提供信息基础。
- **修复**：补 `requireAdmin`。

### 🟠 SEC-04【中危】操作日志查询与导出未授权

- **位置**：`server/src/routes/operationLogs.ts` → `GET /api/operation-logs`、`GET /api/operation-logs/export`
- **类型**：信息泄露
- **描述**：含用户名、操作记录、目标资源等审计数据。审计前两者均未受保护（仅 DELETE 清空受限）。
- **影响**：普通用户可查看/导出全部操作审计日志，了解他人操作与系统拓扑。
- **修复**：两个 GET 均补 `requireAdmin`。

### 🟠 SEC-05【中危】宿主机文件系统遍历未授权

- **位置**：`server/src/routes/hostFiles.ts` → `GET /api/hostfiles/list`
- **类型**：信息泄露 / 路径遍历
- **描述**：返回指定路径的目录/文件名、类型、大小、修改时间。审计前未受保护。
- **影响**：普通用户可遍历宿主文件系统结构，为后续攻击提供侦察。
- **修复**：补 `requireAdmin`。

### 🟠 SEC-06【中危】数据库实例更新接口未授权（可改凭据/连接配置）

- **位置**：`server/src/routes/databases.ts` → `PUT /api/databases/:id`
- **类型**：越权配置修改
- **描述**：更新数据库实例的宿主/端口/用户/**口令**/连接信息。审计前未加 `requireAdmin`。
- **影响**：普通用户可篡改数据库连接凭据导向恶意地址，或破坏其可连接性。
- **修复**：补 `requireAdmin`；前端「编辑实例」入口同步限管理员。

### 🟠 SEC-07【中危】终端会话信息未授权

- **位置**：`server/src/routes/hostTerminal.ts` → `GET /api/hostterminal/info`
- **类型**：信息泄露（低危，但保持一致收口）
- **描述**：返回宿主机会话工作目录与可用 shell。虽为轻度信息，但终端系高危面，应收口一致。
- **修复**：补 `requireAdmin`。

---

### 🟡 SEC-08【低/一致性】容器生命周期操作权限边界曾被错误收紧

- **位置**：`server/src/routes/containers.ts`（start/stop/restart/pause/unpause）
- **描述**：审计过程中曾一度将这些生命周期操作全部设为 `requireAdmin`，导致与竞品共识（Portainer 标准用户可启停、K8s 普通运维可重启）不符、且过度限制普通用户。
- **修复**：依据竞品调研**恢复开放给普通用户**；仅保留**重命名**（破坏容器名依赖）、**克隆**（等价创建）为仅管理员，并补齐 `/:id/clone` 的 `requireAdmin`。

### 🟡 SEC-09【低/一致性】容器「清理未使用」入口前端未联动

- **位置**：`web/src/pages/containers.tsx`（`confirmPrune` 调 `/api/system/prune`）
- **描述**：调系统级清理接口（本就 admin），但前端清理按钮/函数未做管理员禁用与守卫。
- **修复**：前端补 `disabled` 与函数守卫。

### 🟡 SEC-10【低/一致性】容器重命名按钮前端未联动

- **位置**：`web/src/pages/containers.tsx`（`openRename` / `confirmRename`）
- **描述**：后端 rename 需 admin，但前端按钮未禁/函数未守卫。
- **修复**：前端补 `disabled` 与函数守卫。

### 🟡 SEC-11【低/一致性】容器克隆按钮前端未联动

- **位置**：`web/src/pages/containers.tsx`（`openClone` / `confirmClone`）
- **描述**：后端 clone 需 admin，前端已补。
- **修复**：前端补 `disabled` 与函数守卫。

### 🟡 SEC-12【低/一致性】数据库实例「登记/编辑」前端需限管理员

- **位置**：`web/src/pages/databases.tsx`
- **描述**：后端登记（POST `/`）与更新（PUT `/:id`）均需 admin；前端编辑入口与提交需对普通用户禁用。
- **修复**：前端补管理员禁用/守卫，并同步 `useCallback` 依赖。

### 🟡 SEC-13【低/一致性】应用商店、镜像中心、构建、宿主机文件等页面写入口未联动

- **位置**：`web/src/pages/{appstore,hub,build,hostFiles,sites,compose,backups,cloudBackup,images,tasks}.tsx`
- **描述**：这些页面对应的后端写操作均为 `requireAdmin`，但前端各安装/拉取/构建/写文件/站点/备份/镜像/任务按钮初始未做管理员禁用。
- **修复**：统一补 `canManage` 禁用态与函数级守卫；同时为 `sites /reload`（应用反代配置）、`build /image`、`images` 系列操作补齐后端 `requireAdmin` 或前端联动。

---

## 五、已采取修复措施汇总

对应提交（`fork/main`）：
- `65057ef` 完善前端 RBAC 危险操作限制
- `1f43cec` 完善前端 RBAC 危险操作限制（续）
- `8aae49f` 完成权限前端联动与操作日志增强
- `e0202d6` 按竞品共识调整容器权限模型并补齐审计遗漏
- `b98633f` 收紧敏感读取接口为仅管理员

### 后端（新增/修正 `requireAdmin`）
| 接口 | 文件 | 状态 |
| --- | --- | --- |
| `GET /api/system/backup` | system.ts | ✅ 已修复 |
| `GET /api/system/users` | system.ts | ✅ 已修复 |
| `GET /api/operation-logs` `/export` | operationLogs.ts | ✅ 已修复 |
| `GET /api/hostfiles/list` | hostFiles.ts | ✅ 已修复 |
| `GET /api/hostterminal/info` | hostTerminal.ts | ✅ 已修复 |
| `DELETE /api/operation-logs` | operationLogs.ts | ✅（审计前已正确） |
| `POST /api/networks/prune` | networks.ts | ✅ 已修复 |
| `PUT /api/databases/:id` | databases.ts | ✅ 已修复 |
| `POST /api/containers/:id/clone` | containers.ts | ✅ 已修复 |
| `CONTAINERS start/stop/restart/pause/unpause` | containers.ts | ✅ 恢复为普通用户可用（按竞品共识） |
| `POST /api/containers/:id/rename` | containers.ts | ✅ 设为仅管理员 |
| 其余写路由（镜像/卷/引擎/任务/备份/站点/云端/应用商店/镜像中心/构建/宿主文件/终端） | 各 routes | ✅ 审计前已 / 本次已补齐 |

### 前端（角色联动）
- 容器：删除/创建/克隆/编辑镜像(recreate)/重命名/清理未使用 → 管理员禁用+守卫；启停/重启/暂停/恢复 → 普通用户可用。
- 数据库：登记/编辑实例 → 管理员。
- 设置页：导出备份 → 管理员（此前仅恢复受限）。
- 应用商店 / 镜像中心 / 构建 / 宿主机文件 / 站点 / Compose / 备份 / 云端备份 / 镜像 / 任务 → 各写操作按钮均加 `canManage` 禁用与守卫。

**操作日志增强**：关键写操作（清空日志、新增镜像源、测试云端目标、启停站点、重载反代、构建镜像、宿主机命令执行失败等）均已记录操作人/目标/成功与否，为审计追溯提供支撑。

---

## 六、残余风险与后续建议

### 残余风险
1. **页面入口未做角色隔离**：管理类页面（设置、操作日志、镜像中心、应用商店、宿主机文件等）的路由与侧边栏对普通用户仍显示、可点入。由于后端 `requireAdmin` 已兜底，普通用户进入后**写操作会被 403 拦截**，仅能浏览只读内容，故为**中低风险**；但如需更严格的「不可见即不可达」，需加路由级/菜单级角色过滤。
2. **前端 `role` 存于 localStorage 可被篡改**：`isAdmin()` 依赖 localStorage。但因后端以服务端会话角色校验，篡改前端仅影响 UI 显隐，**不构成越权**。
3. **`GET /api/system/settings` 暴露部分引擎元数据**（主机名、CPU、内存、容器数）。属基础系统信息，评估为低敏感，本次未收紧；如需可后续封闭。

### 建议（后续可选项）
1. **路由/菜单级角色准入**：在 `App.tsx` 为管理类路由嵌套「仅管理员」守卫（基于 `/api/auth/me` 返回的角色而非 localStorage 可篡改值），并在 `Layout.tsx` 的 `NAV_ITEMS` 增加 `adminOnly` 标记过滤菜单——与后端 `requireAdmin` 形成「前端隐藏入口 + 后端强制校验」双重防护。
2. **补充自动化测试**：为 `requireAdmin` 权限边界编写后端集成测试（普通用户对上述接口应得 403），防止回归。
3. **口令哈希加固**：确认用户口令使用强哈希（如 bcrypt/argon2）而非弱哈希，以降低拖库后的破解风险。
4. **审计周期化**：将本报告作为基线，定期复查新增路由/页面的权限覆盖。

---

*本报告由权限审计过程自动生成，所有位置/修复均经代码核对；详见各提交的 diff。*
