# Docker Manager 对标 1Panel 功能完善实施方案

> 本文档是参照 1Panel 功能对当前 Docker Manager（Windows 版 Docker 管理面板）进行功能完善的详细实施方案（PRD + 技术方案）。
>
> 范围：本次仅覆盖用户确认优先完善的 **四大方向**，其余差异见文末「后续可选方向」章节，不在本期实施。

---

## 一、背景与目标

当前项目已有较完整的 Docker 核心管理能力（容器/镜像/卷/网络/Compose/应用商店/监控/备份/审计），但对标 1Panel 仍有如下差距。本期补齐四大能力：

1. **定时任务 + 自动清理/备份** —— 对标 1Panel「计划任务」
2. **容器内文件管理** —— 对标 1Panel「文件管理」在容器维度
3. **应用商店升级为 Compose 套件** —— 对标 1Panel「应用商店多容器编排/升级」
4. **数据库可视化管理** —— 对标 1Panel「数据库」模块

> 说明：本方案完全基于现有代码架构（`server/src`、`web/src`）设计，遵循现有技术栈（Express + `node:sqlite` + React/Vite）+ 现有代码风格（`asyncHandler`、`client.ts` 封装、`NAV_ITEMS` 菜单等），不需要引入新的第三方运行时依赖。文档中标注了每个模块需要新建/改动的文件清单。

---

## 二、通用改动（四个功能的前置基础设施）

### 2.1 新增 SQLite 业务表（`server/src/storage.ts`）

在 `createTables()` 函数末尾追加以下建表 SQL（均为 `CREATE TABLE IF NOT EXISTS`）：

```sql
-- 定时任务表
CREATE TABLE IF NOT EXISTS cron_tasks (
  id         TEXT PRIMARY KEY,             -- uuid
  name       TEXT NOT NULL,                -- 任务名称
  type       TEXT NOT NULL,                -- 任务类型（见 §3）
  cron       TEXT NOT NULL DEFAULT '',     -- cron 表达式（或如 seconds/centered 同义写法）
  enabled    INTEGER NOT NULL DEFAULT 1,   -- 是否启用
  config     TEXT NOT NULL DEFAULT '{}',   -- 任务参数 JSON
  last_run_at  INTEGER,                    -- 上次执行时间（秒）
  last_status  INTEGER,                    -- 上次结果：0成功/1失败
  last_detail  TEXT,                       -- 上次结果详情
  next_run_at  INTEGER,                    -- 下次执行时间（秒）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 应用商店安装记录表（记录 Compose 套件安装实例的参数快照，用于升级/重装比对）
CREATE TABLE IF NOT EXISTS appstore_instances (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id       TEXT NOT NULL,              -- 目录应用 id
  project_name TEXT NOT NULL,              -- compose 项目名
  version      TEXT,                       -- 当前部署版本/镜像标签快照
  params       TEXT NOT NULL DEFAULT '{}', -- 安装时用户自定义参数快照(JSON)
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(app_id)
);
```

> 采用与现有 `operation_logs` 一致的建表风格（`INTEGER PRIMARY KEY AUTOINCREMENT` + 时间戳秒），并补 `next_run_at` 索引便于定时调度查询：
> `CREATE INDEX IF NOT EXISTS idx_cron_tasks_next_run ON cron_tasks(next_run_at);`

### 2.2 通用定时调度器（新建 `server/src/scheduler.ts`）

参照 `server/src/docker/monitor.ts` 的 `setInterval + unref + started 标志` 模式实现一个轻量调度器：

- 每个**已启用**任务维护 `next_run_at`；
- 用一个 `setInterval`（默认 10 秒 tick）扫描 `cron_tasks` 中 `next_run_at <= now && enabled=1` 的任务并执行；
- 支持 cron 表达式 → 下一次执行时间的解析（实现一个最小 cron 解析器，支持 `秒/分 时 日 月 周` 5 段，覆盖 `*`、`*/n`、`数字`、`数字,数字`，够用即可）；
- 执行时更新 `last_run_at / last_status / last_detail / next_run_at`；
- 执行函数通过「任务类型 → handler 映射表」分发，handler 抛错则记 `last_status=1`；
- `scheduler.start()` 在 `server/src/index.ts` 启动流程中调用（紧接 `startMonitor()`），`scheduler.stop()` 在退出钩子中调用；
- `timer.unref()` 保证不影响进程退出。

### 2.3 前端侧边栏新增菜单（`web/src/components/Layout.tsx`）

在 `NAV_ITEMS` 数组中按序追加三项：

| to | label | 图标建议 |
|----|-------|----------|
| `/tasks` | 计划任务 | 时钟 SVG |
| `/appstore` | 应用商店 | （已有，改造） |
| `/files` | 文件管理 | 文件夹 SVG |
| `/databases` | 数据库 | 数据表 SVG |

> 新增菜单只需在 `NAV_ITEMS` 追加对象；图标用现有 `iconProps` + 内联 SVG path。

### 2.4 前端路由新增（`web/src/App.tsx`）

仿照现有写法，在 `<Route element={<Layout />}>` 内追加：

```tsx
const TasksPage = lazy(() => import('./pages/tasks'));
const FilesPage = lazy(() => import('./pages/files'));
const DatabasesPage = lazy(() => import('./pages/databases'));
// ...
<Route path="/tasks" element={<PageSuspense><TasksPage /></PageSuspense>} />
<Route path="/files" element={<PageSuspense><FilesPage /></PageSuspense>} />
<Route path="/databases" element={<PageSuspense><DatabasesPage /></PageSuspense>} />
```

### 2.5 后端路由注册（`server/src/app.ts`）

新增路由统一挂载（与现有路由风格一致）：

```ts
import tasksRouter from './routes/tasks';
import filesRouter from './routes/files';
import databasesRouter from './routes/databases';
// ...
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/files', requireAuth, filesRouter);
app.use('/api/databases', requireAuth, databasesRouter);
```

> 权限：各路由新增写操作统一调用 `logOperation(res.locals.username, ...)` 写入审计日志（复用现有 `operationLog`），并校验 `res.locals.user?.role === 'admin'` 时仅 admin 可执行「删除/恢复/启停系统级」操作。

---

## 三、功能一：定时任务 + 自动清理/备份

对标 1Panel「计划任务」，让用户把频繁手工操作（prune、备份、拉取、compose up）变成可配置的定时策略。

### 3.1 支持的任务类型（`type` 字段枚举）

| type | 能力 | 所需参数（config） |
|------|------|--------------------|
| `prune` | 定时清理未使用资源 | `{ images:bool, containers:bool, volumes:bool, networks:bool, buildCache:bool }`（默认全开） |
| `backup` | 定时备份（面板库 / 指定数据卷） | `{ target:'database'\|'volumes', volumes?:string[], keepCount?:number }` |
| `pull` | 定时拉取镜像 | `{ image:string, source?:string }`（复用 `pullWithFailover`） |
| `composeUp` | 定时拉起指定 Compose 项目 | `{ project:string }` |
| `composeDown` | 定时停止指定 Compose 项目 | `{ project:string }` |

### 3.2 API 设计（新建 `server/src/routes/tasks.ts`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | 任务列表（含 next_run_at 下一次执行时间） |
| POST | `/api/tasks` | 新建任务 |
| PUT | `/api/tasks/:id` | 更新任务（改 cron/参数/名称） |
| POST | `/api/tasks/:id/enable` | 启用/停用（body: `{ enabled }`） |
| POST | `/api/tasks/:id/run` | 立即手动执行一次该任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| GET | `/api/tasks/logs` | 任务执行历史（分页，可存最近 N 条到 `cron_tasks_logs` 表） |

- 手动 `run` 与定时触发共用同一「handler 分发」逻辑，便于复用与测试。
- 「立即执行」同样更新 `last_run_at`，并写操作日志。

### 3.3 备份能力增强（改动 `server/src/routes/system.ts` / storage）

现有 `exportDatabase()` 只能备份面板自身的 SQLite 库。本期扩展：

1. **库备份**：沿用 `VACUUM INTO`，任务 handler 调用后把备份文件归档到 `data/backups/`（按时间命名），并清理超过 `keepCount` 的旧备份。
2. **数据卷备份**：新建 `server/src/routes/tasks.ts` 内 `backupVolumes(volumes[])`：
   - 用 `docker.pull` 或用本地已有 `alpine` 镜像（兜底临时拉取）起一次性 `--rm` 容器挂载目标卷到 `/backup`，宿主归档目录挂载到 `/out`；
   - 容器内执行 `tar -czf /out/<vol>_<ts>.tar.gz /backup/<vol>`；
   - 用 `execAsync`（复用 compose 的同款封装）执行，完成后容器自动移除。
   - 归档目录：`data/backups/volumes/`。
3. **恢复**：预留 `POST /api/backup/restore-volume`（上传 tar → 同样用临时容器 `tar -xzf` 解包回卷），本期实现，前端页面提供「选择备份 → 恢复」入口。

### 3.4 前端页面（新建 `web/src/pages/tasks.tsx`）

- 任务列表卡片/表格：名称、类型、cron 表达式、启用开关、下次/上次执行时间、上次结果徽标（成功/失败）。
- 新建/编辑弹窗：选择类型 → 动态渲染对应参数表单（prune 勾选类别；backup 选「面板库/数据卷」；pull 填镜像名；compose 选项目）。
- cron 快捷输入 + 说明（如「每天 3 点」等中文预设，可映射成表达式）。
- 「立即执行」按钮、删除按钮（二次确认）。
- 执行历史抽屉（分页表格）。

---

## 四、功能二：容器内文件管理

对标 1Panel 文件管理在容器维度，提供宿主机与容器间文件浏览器 + 上传下载。

### 4.1 技术方案

基于 `dockerode` 的 `getContainer().getArchive()` / `.putArchive()` / 容器内 `exec`（`tar`/`ls`/`rm`/`mv`/静态命令），封装为文件系统语义接口。所有路径操作限制在容器内，不做宿主机路径。

### 4.2 API 设计（新建 `server/src/routes/files.ts`，挂 `/api/files`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files/:containerId/ls?path=` | 列出容器内目录（复用 `stats`/`exec` 或 dockerode inspect 驱动；实现用 `exec` 执行 `ls -la` 或 dockerode 的 `getArchive` 流式解析） |
| GET | `/api/files/:containerId/read?path=` | 读取小文件内容（文本预览，限大小如 1MB，超限提示下载） |
| GET | `/api/files/:containerId/download?path=` | 下载容器内文件（`docker cp` 语义：`getArchive` → 解 tar → 流式 res.download） |
| POST | `/api/files/:containerId/upload` | 上传文件到容器（`multer` 内存临时文件 + `putArchive` 打包上传，`path` 上传目标目录） |
| POST | `/api/files/:containerId/mkdir` | 新建目录（`exec mkdir -p`） |
| POST | `/api/files/:containerId/delete` | 删除文件/目录（body: `{path}`，用 `exec rm -rf`，前端二次确认） |
| POST | `/api/files/:containerId/rename` | 重命名（`exec mv`） |

- 前置校验：容器必须存在，且处于 running（`ls`/`mv` 等需要运行中的 shell）；已停止容器提示「请先启动容器」。
- 路径安全：拒绝解析到容器根目录以外的路径（`path.resolve` 校验），拒绝空 path。
- 上传走 `express.raw({ limit: '500mb' })` 或临时文件挂接 `putArchive`，与现有镜像导入上限策略一致。

### 4.3 前端页面（新建 `web/src/pages/files.tsx`）

- 顶部选择容器（下拉 + 搜索），进入后展示容器内文件树 / 列表（面包屑导航）。
- 表格列：名称、类型图标、大小、修改时间；操作：预览/下载/重命名/删除/新建目录。
- 「上传文件」按钮（多选），进度提示。
- 与已有 `ContainerTerminal` 风格统一（复用现有 Button/Modal/Toast 组件）。

---

## 五、功能三：应用商店升级为 Compose 套件

对标 1Panel 应用商店的多容器编排与版本/升级管理。当前 `AppDefinition` 是「单容器 + label」模型（hash 见 `appstore/catalog.ts`、`status.ts`、`routes/appstore.ts`）。

### 5.1 演进策略（兼容现有，不破坏）

1. **保留单容器模式**：现有 `catalog.ts` 的简单应用（nginx/redis/alpine 等）继续走 `dockerode createContainer` 老路径，`status.ts` 的 label 关联逻辑不动。
2. **新增 Compose 套件模式**：在 `AppDefinition` 上新增可选字段：
   ```ts
   interface AppComposeDef {
     compose: string;            // compose 文件内容模板（含 ${VAR} 占位）
     services: string[];         // 需要映射到页面展示的服务
     ports: AppPort[];           // 汇总要展示/可覆盖的端口
     volumes: AppVolume[];       // 汇总要展示/可覆盖的卷
     env: AppEnv[];              // 可自定义变量（替换 compose 里的占位）
     defaultVersion?: string;    // 默认镜像标签版本
   }
   ```
3. **升级安装链路**（`routes/appstore.ts` 新增分支）：
   - 判断 `app.compose` 存在 → 走「写 compose 项目目录 + `docker compose up -d`」流程（复用 §四 compose 的 `COMPOSE_ROOT`、`runCmd`、`findComposeFile` 逻辑）；
   - 把安装参数快照写入 `appstore_instances` 表（§2.1），记录 `project_name` 与 `params`；
   - 目录中新增一个**派生 label/标记文件**（如 `project_name` 关联），用于应用页展示安装状态与定位容器（`compose ps` 或按 project 名过滤）。

### 5.2 新增/改造接口（`routes/appstore.ts` + `routes/compose.ts`）

| 方法/路径 | 说明 |
|-----------|------|
| GET `/api/appstore` | 返回应用列表，`AppDefinition` 增加 `mode: 'single'\|'compose'` 标记 |
| POST `/api/appstore/:id/install` | 兼容：`single` 走旧逻辑；`compose` 走 Compose 套件安装 |
| POST `/api/appstore/:id/upgrade` | **新增**：拉取新镜像（`compose pull`）+ `compose up -d --force-recreate`，实现应用升级；更新 `appstore_instances.version` |
| POST `/api/appstore/:id/update-params` | **新增**：修改已装应用的端口/环境变量参数（重写 compose 并重建） |
| POST `/api/appstore/:id/start\|stop\|restart` | `compose` 模式映射到 `compose up\|down\|restart` |
| POST `/api/appstore/:id/uninstall` | `compose` 模式走 `compose down -v` + 删目录 + 删 `appstore_instances` |

### 5.3 新增 Compose 套件应用（扩充 `catalog.ts`）

首批内置 3~5 个多容器套件（复用现有 compose 模板能力，见 `web/src/pages/compose.tsx` 内置模板）：

| 应用 id | 服务 | 说明 |
|---------|------|------|
| `wordpress` | wordpress + mysql | 经典建站套件 |
| `nginx-php` | nginx + php-fpm + mariadb | LNMP 单站套件 |
| `redis-cluster` | redis（主从） | 演示多服务编排 |
| `grafana-prometheus` | grafana + prometheus + node-exporter | 监控套件 |

### 5.4 前端改造（`web/src/pages/appstore.tsx`）

- 应用卡片/详情增加「版本」「服务数」「模式」标识；
- 安装弹窗对 `compose` 应用展示「服务拓扑」摘要 + 可编辑端口/卷/环境变量（映射到 compose 占位）；
- 详情页增加「升级」按钮（执行 `upgrade`，成功后 Toast 提示）；「参数修改」入口；
- 安装状态在 `appstore_instances` 基础上结合 `compose ps` 实时显示 running/stopped 与端口。

---

## 六、功能四：数据库可视化管理

对标 1Panel「数据库」模块，聚焦应用商店常见数据库（MySQL / PostgreSQL / Redis / MariaDB）。

### 6.1 能力范围（本期）

- **实例识别**：扫描带 `com.dockermanager.app` label 的数据库容器 + 允许用户手动登记任意数据库容器（记录连接信息到表）。
- **连接配置**：登记/编辑数据库实例（`{ name, type, containerId/项目, host端口, 账号, 密码 }`），密码可加密落库（见 6.3）。
- **可视化管理**（对 MySQL/PostgreSQL/MariaDB）：
  - 库列表、建库、删库；
  - 库内表列表；
  - 只读查询 + 简单表数据浏览（`SELECT * ... LIMIT`）与 SQL 执行面板。
- **Redis**：连接测试、键列表浏览、内存/命中率基础指标、简单键删除（不提供全量命令面板，控制风险）。
- **Web 管理入口跳转**：对已选定的应用（如 Adminer、phpMyAdmin），提供「打开面板」链接（填入已存连接凭据），对标 1Panel 的数据库工具集成。

### 6.2 API 设计（新建 `server/src/routes/databases.ts`，挂 `/api/databases`）

| 方法/路径 | 说明 |
|-----------|------|
| GET `/api/databases` | 数据库实例列表（识别 self 商店数据库 + 手动登记） |
| POST `/api/databases` | 登记实例（body: type/name/host/port/user/password/containerRef） |
| PUT `/api/databases/:id` | 更新实例配置 |
| DELETE `/api/databases/:id` | 删除登记 |
| POST `/api/databases/:id/test` | 连接测试 |
| GET `/api/databases/:id/databases` | 列出库 |
| POST `/api/databases/:id/databases` | 建库（body: `{name, charset?}`） |
| DELETE `/api/databases/:id/databases/:db` | 删库 |
| GET `/api/databases/:id/databases/:db/tables` | 列表 |
| POST `/api/databases/:id/query` | SQL 查询面板（body: `{sql}`，限制只读？可做白名单/只允许 SELECT，或提供可配置开关） |

实现说明：
- **连接库**：不引入庞大 ORM。对 MySQL/PostgreSQL/MariaDB 用**容器内 `exec` + 官方客户端 CLI**（`mysql` / `psql`）执行命令，解析 stdout 为 JSON 行；若无 CLI 则回退：由服务在目标容器内以 `--innodb` 等基础探测。**推荐主路径**：项目主要面向 Windows + Docker 容器，数据库都在容器里，用 `docker exec <container> mysql -uroot -p... -e "..."` 最稳、无需装驱动。
- Redis：`docker exec <container> redis-cli ...`。
- 安全性：连接口令不落明文日志；SQL 面板默认仅放行 `SELECT`（可在设置中开启读写）。

### 6.3 连接凭据存储（SQLite）

在 `storage.ts` 增加一张表，口令用对称加密（密钥由 `AUTH_SECRET` 或首次启动生成的 `data/.secret` 派生，`crypto` PBKDF2）：

```sql
CREATE TABLE IF NOT EXISTS database_instances (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,           -- mysql|postgres|mariadb|redis
  container_ref TEXT,                 -- 关联容器 id（可选）
  host       TEXT NOT NULL DEFAULT 'localhost',
  port       INTEGER NOT NULL,
  user       TEXT,
  cred_encrypted TEXT,                -- 加密后的密码
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 6.4 前端页面（新建 `web/src/pages/databases.tsx`）

- 实例卡片列表 + 「登记实例/从应用商店同步」按钮；
- 实例 → 数据库列表 Tab → 下方操作（建库/删库/SQL 面板/Redis 键浏览）；
- SQL 面板：可折叠 textarea + 「执行」+ 结果表格；
- 「连接测试」按钮展示连通性。

---

## 七、数据表变更汇总（`server/src/storage.ts::createTables()`）

| 表名 | 归属功能 | 说明 |
|------|---------|------|
| `cron_tasks` | 定时任务 | §2.1 |
| `cron_tasks_logs` | 定时任务 | 执行历史（新增） |
| `appstore_instances` | 应用商店套件 | §2.1 |
| `database_instances` | 数据库管理 | §6.3 |

> 所有表均 `CREATE TABLE IF NOT EXISTS`，对旧版数据库无破坏性；如需新增列采用 `ALTER TABLE ... ADD COLUMN` 包裹 try/catch 的方式（与现有 `must_change_password` 迁移一致）。

---

## 八、需要新建/改动的文件清单

### 后端（`server/src/`）
| 文件 | 动作 | 说明 |
|------|------|------|
| `storage.ts` | 改 | 加 4 张表 + 对称加密工具函数 |
| `scheduler.ts` | 新建 | 通用定时调度器 + cron 解析 |
| `routes/tasks.ts` | 新建 | 定时任务 CRUD + 各类 handler + 备份 |
| `routes/files.ts` | 新建 | 容器内文件管理 |
| `routes/databases.ts` | 新建 | 数据库可视化管理 |
| `routes/appstore.ts` | 改 | 支持 compose 模式安装/升级 |
| `appstore/catalog.ts` | 改 | 增加 `compose` 定义 + 新套件应用 |
| `app.ts` | 改 | 挂载新路由 |
| `index.ts` | 改 | 启动/关闭 scheduler |
| `hooks/`/`util/`（可选） | 新建 | 复用 `execAsync`、`pullWithFailover` 等现有工具 |

### 前端（`web/src/`）
| 文件 | 动作 | 说明 |
|------|------|------|
| `pages/tasks.tsx` | 新建 | 计划任务页 |
| `pages/files.tsx` | 新建 | 容器文件管理页 |
| `pages/databases.tsx` | 新建 | 数据库管理页 |
| `pages/appstore.tsx` | 改 | compose 套件展示/升级 |
| `App.tsx` | 改 | 注册新路由 |
| `components/Layout.tsx` | 改 | `NAV_ITEMS` 加菜单 |
| `types/index.ts` | 改 | 补充任务/文件/数据库/套件类型 |

---

## 九、验证清单（实施后逐项自检）

1. 定时任务：新建「每天 00:00 清理镜像」任务 → 点击「立即执行」→ 观察 `last_status=0`、审计日志有记录。
2. 备份：对面板库执行备份 → `data/backups/` 生成文件；对某数据卷执行备份 → tar.gz 存在；恢复接口可用。
3. 容器文件：对运行中 nginx 容器上传/下载/删除 `/usr/share/nginx/html` 下文件正常；对已停止容器有友好提示。
4. 应用商店套件：安装 `wordpress` → 出现两个服务容器且 running；点「升级」→ 重建成功；「参数修改」后配置生效。
5. 数据库：登记 mysql 容器 → 连接测试成功 → 能列表库、建库、执行 SELECT；Redis 能浏览键。
6. 回归：原有容器/镜像/卷/网络/Compose 单机功能不回归（跑一遍 `npm run build` 前后两端无类型错误，`dev:server` / `dev:web` 正常起）。

---

## 十、后续可选方向（本期不实施，留档）

| 方向 | 优先级 | 说明 |
|------|--------|------|
| 多 Docker 引擎端点配置与切换 | 中 | 对标 1Panel Cluster/多引擎 |
| Dockerfile 独立构建镜像 | 中 | 目前只有 compose build |
| 事件流管理完善 / daemon.json 视图 | 低 | 扩展当前事件查看 |
| Windows 防火墙规则管理 | 低 | 需调用 netsh/Windows Firewall API |
| GPU / 主机深度监控 | 低 | 对标 1Panel AI/GPU 卖点 |
| 云端存储备份（S3/OSS/WebDAV） | 中 | 扩展备份介质 |
