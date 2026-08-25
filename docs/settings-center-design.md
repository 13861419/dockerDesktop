# 设置中心化（配置中心）· 实施设计（PRD + 技术方案）

> 生成日期：2026-08-24
> 视角：产品经理 + 架构师
> 对应头脑风暴文档 `next-features-roadmap.md` D2（roadmap 已有抽象，本文给出可落地实施）。
> 原则：**把散落的环境变量默认值 + `setting` 表 KV + 各模块配置收敛为统一 KV 配置中心**，提供设置页多 Tab + 导入导出一致性。零第三方依赖。

---

## 一、背景与目标

现状配置分散多处：
- **环境变量**：`PORT`/`HOST`/`AUTH_TTL_HOURS`/`DOCKERMANAGER_DATA`/`ADMIN_USER`/`ADMIN_PASS`/`COMPOSE_ROOT` 等（进程级，难 UI 管理）。
- **`setting` 表 KV**：`searchSource`、`alert.cooldown`（新增）等散落。
- **各路由模块静态默认值**：`scheduler.ts` 的 TICK、告警默认规则等。

目标：**设置页多 Tab（通用/运行/安全/数据保留/通知默认）**，可读可改；关键项落库为 KV；环境变量作为"初始默认值"（未落库时兜底）。**不改动现有模块对外行为**（读取时"已落库值 > 环境变量 > 模块默认"）。

---

## 二、总体架构

```
浏览器 /settings 多 Tab
   │  GET/PUT /api/settings（KV 批量）
   │  GET/PUT /api/settings/:key
   ▼
server/src/settings.ts（新建，统一 KV 配置中心）
   ├─ getSetting(key, envFallback, default)   ← 三态回退
   ├─ setSetting(key, value)
   ├─ listSettings()                          ← 返回"已知键 + 描述 + 来源(env/db/default)"
   └─ INI 级别的键表注册（descriptor：key/env/default/hint/type：’number|string|bool|secret’）
   ▼
  各模块改从 settings.getSetting() 读取（保持默认行为）
```

- **兼容**：现有 `setting` 表结构不变，`settings.ts` 封装在其上；不破坏 `hubConfig.ts`/`system.ts` 现有读写。
- **优先级**：`db`（已保存） > `env`（进程） > `default`（模块）。

---

## 三、核心模块 `server/src/settings.ts`

```ts
export interface SettingDescriptor {
  key: string;
  label: string;
  hint?: string;
  type: 'number' | 'string' | 'bool' | 'secret';
  env?: string;          // 对应环境变量名（如 'PORT'）
  def?: any;             // 默认值
  group: 'general' | 'runtime' | 'security' | 'retention' | 'notification';
}

/** 注册中心（模块在加载时 registerSetting） */
export function registerSettings(descriptors: SettingDescriptor[]): void;

/** 读取（三态回退） */
export function getSetting<T>(key: string): T;
export function getSettingRaw(key: string): { value: any; source: 'db' | 'env' | 'default' };

/** 写入（secret 类型经 encryptSecret） */
export function setSetting(key: string, value: any): void;

/** 列出全部已知设置（含描述/来源/分组，供前端渲染） */
export function listSettings(): Array<SettingDescriptor & { value: any; source: string }>;
```

**首批注册的键**（示例，覆盖已有资源）：

| key | env | def | 分组 |
|-----|-----|-----|------|
| `server.port` | PORT | 9528 | runtime |
| `server.host` | HOST | 0.0.0.0 | runtime |
| `auth.ttlHours` | AUTH_TTL_HOURS | 24 | security |
| `scheduler.tickMs` | — | 10000 | runtime |
| `alert.cooldown` | — | 300 | notification |
| `logs.maxTail` | — | 5000 | retention |
| `ai.baseUrl`/`ai.model`/`ai.apiKey`(secret) | DOCKERMANAGER_AI_* | "" | general（联动 AI 设计） |
| `compose.root` | COMPOSE_ROOT | tmp 默认 | runtime |

> 各现有模块改为 `getSetting('server.port')` 等，但**保留环境变量回退**，确保老部署无缝升级。

---

## 四、路由与前端

### 4.1 路由（`server/src/routes/settings.ts`，挂 `/api/settings`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/settings` | 已知设置 + 值 + 来源 + 分组 |
| PUT | `/api/settings` | 批量更新（body: `{ key: value }`）；secret 字段加密 |
| PUT | `/api/settings/:key` | 单个更新（可含"恢复默认"） |

- 鉴权：更新 `requireAdmin`；读取 `requireAuth`（secret 字段回显仅 `configured:boolean`）。
- 审计：批量更新记 `logOperation`。

### 4.2 前端（改 `web/src/pages/settings.tsx`）

- 改为**多 Tab**：通用 / 运行 / 安全 / 数据保留 / 通知默认。
- 每 Tab 渲染该分组的 descriptor（label/hint/type），`number` 用 Input，`bool` 用 Switch，`secret` 显示"已配置/未配置"。
- 「保存」→ `PUT /api/settings`；「恢复默认」→ 清除 DB 值。

---

## 五、安全与合规

1. **secret 加密**：`ai.apiKey` 等经 `encryptSecret`，回显只给 `configured`。
2. **优先级契约**：DB 覆盖 env，env 覆盖 default——老用户不因升级丢失行为。
3. **校验**：`number` 类型做范围/格式校验；`bool` 归一。
4. **分权**：读取全量，写入 admin + 审计。

---

## 六、任务拆分

| # | 任务 | 涉及文件 | 验收 |
|---|------|----------|------|
| T1 | 写 `settings.ts`（descriptor 注册 + 三态回退 + secret） | 新建 `server/src/settings.ts` | getSetting 三态回退正确；secret 加密不泄露 |
| T2 | 首批键接入各模块（port/host/auth/compose/alert/logs 等） | 改 `server/src/*.ts` | 行为与原先（env 回退）一致 |
| T3 | 写 `/api/settings` 路由 | 新建 `server/src/routes/settings.ts`、`server/src/app.ts` | GET/PUT 批量、单 key、恢复默认、审计正常 |
| T4 | 前端多 Tab 设置页 | 改 `web/src/pages/settings.tsx`、`web/src/types/index.ts` | Tab 渲染、保存/恢复默认、secret 脱敏 |
| T5 | 编译 + 回归 + 端到端 | — | `npm run build` 通过；各模块原 env 行为零回归 |

**顺序**：T1→T2→T3（后端闭环）→T4 →T5。

---

## 七、验证清单

1. 未落库时 `getSetting('server.port')` 跟随环境变量 `PORT`；落库后 DB 优先。
2. `ai.apiKey` 写成 secret，读取不回显明文，仅 `configured`。
3. 设置页多 Tab 正确渲染分组；保存更新审计可见。
4. 恢复默认后回退到 env/default。
5. `npm run build` 通过；老部署 env 行为零回归。
