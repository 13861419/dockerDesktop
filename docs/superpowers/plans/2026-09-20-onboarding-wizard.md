# 首次启动向导（Onboarding Wizard）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全新安装的竞品迁移用户首次登录时，经四步向导完成改密提醒、环境纳管确认、可选配置与迁移心智导入；存量用户零打扰。

**Architecture:** 后端仅两处改动——settings 注册中心登记 `onboarding.done`（bool，默认 true = 已完成），storage 初始化在 `users` 表为空（全新安装）时种下 `onboarding.done='0'`；前端新增独立路由 `/onboarding`（RequireAuth 内、Layout 外）四步向导，Layout 挂载时检测标记跳转。

**Tech Stack:** Express + better-sqlite 风格同步 API（node:sqlite）、React 18 + react-router、i18n 中文键体系。

## Global Constraints

- 版本目标 1.88.0（实现完成后再走发版仪式，本计划不含发版）
- 零第三方依赖：不新增任何 npm 包；服务 Worker/manifest 不动
- 文本文件编辑禁用 PowerShell `Get-Content`/`Set-Content`（UTF-8 中文会乱码）；用 edit 工具或 node 脚本
- 新测试文件必须手动登记进 `server/package.json` 的 `test:unit`（显式文件列表）
- i18n 英文键追加在 `web/src/i18n/en.ts` 锚点 `"CI 状态门禁": "CI status gate",` 之后
- 提交信息用中文 feat/docs 前缀（沿用仓库惯例）

---

### Task 1: 后端——`onboarding.done` 设置项与首装种子

**Files:**
- Modify: `server/src/settings.ts`（注册描述符）
- Modify: `server/src/storage.ts`（`seedOnboardingFlag()` + `initStorage` 尾部调用）
- Test: `server/test/onboarding.test.ts`（新建）
- Modify: `server/package.json`（test:unit 登记新测试文件）

**Interfaces:**
- Consumes: `settings.ts` 的 `registerSettings` / `getSettingRaw`；`storage.ts` 的 `initStorage()`（导出）
- Produces: settings 键 `onboarding.done`（bool，默认 `true`，`hidden: true`，group `general`）；`storage.ts` 导出 `seedOnboardingFlag(): void`

- [ ] **Step 1: 写失败测试**

新建 `server/test/onboarding.test.ts`：

```typescript
/**
 * 首次启动向导（1.88.0）单元测试
 *
 * 覆盖：
 *  - onboarding.done 设置描述符注册（bool / 默认 true / hidden）
 *  - 首装种子：users 表为空 → 写入 '0'；有用户 → 不写（存量库不受打扰）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 必须先于 storage 模块加载设置临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-onboard-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, getDb, seedOnboardingFlag } from '../src/storage';
import { getSettingRaw } from '../src/settings';

test('onboarding.done 描述符：bool 类型、默认 true（已完成）、hidden', () => {
  const raw = getSettingRaw('onboarding.done');
  assert.ok(raw, 'onboarding.done 应已注册');
  assert.strictEqual(raw.value, true);
  assert.strictEqual(raw.source, 'default');
});

test('首装种子：users 为空 → 写入待完成标记', () => {
  initStorage();
  seedOnboardingFlag();
  const raw = getSettingRaw('onboarding.done');
  assert.strictEqual(raw!.value, false);
  assert.strictEqual(raw!.source, 'db');
});

test('存量库：users 非空且无标记 → 不种子（视为已完成）', () => {
  // 模拟存量库：插入一个用户后清除标记，再次执行种子应保持无键
  getDb()
    .prepare("INSERT INTO users (username, salt, password_hash, role, created_at) VALUES ('legacy', 's', 'h', 'admin', 0)")
    .run();
  getDb().prepare('DELETE FROM setting WHERE key = ?').run('onboarding.done');
  seedOnboardingFlag();
  const raw = getSettingRaw('onboarding.done');
  assert.strictEqual(raw!.source, 'default');
  assert.strictEqual(raw!.value, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx cross-env TS_NODE_PROJECT=tsconfig.test.json TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register --test test/onboarding.test.ts`
Expected: FAIL（`seedOnboardingFlag` 未导出 / `onboarding.done` 未注册）

- [ ] **Step 3: 注册设置描述符**

`server/src/settings.ts` 中找到现有 `registerSettings([...])` 调用（模块尾部统一注册处），向数组追加：

```typescript
  {
    key: 'onboarding.done',
    label: '首次启动向导已完成',
    type: 'bool',
    def: true,
    group: 'general',
    hidden: true,
  },
```

- [ ] **Step 4: storage 种子函数**

`server/src/storage.ts`：在 `initStorage` 导出函数附近新增并导出：

```typescript
/**
 * 首装向导标记种子（1.88.0）：仅当 users 表为空（全新安装）且尚未有标记时，
 * 写入 onboarding.done='0'（待完成）；存量库无此键即视为已完成，不受打扰。
 * 由 initStorage() 在建表后调用一次；独立导出供单测。
 */
export function seedOnboardingFlag(): void {
  try {
    const d = getDb();
    const row = d.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    if (row.n > 0) return;
    const existed = d.prepare('SELECT key FROM setting WHERE key = ?').get('onboarding.done');
    if (existed) return;
    d.prepare('INSERT INTO setting (key, value) VALUES (?, ?)').run('onboarding.done', '0');
  } catch {
    // users/setting 表未就绪等异常时静默跳过，不影响启动
  }
}
```

并在 `initStorage()` 函数体末尾（`createTables();` 之后）追加：

```typescript
  seedOnboardingFlag();
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd server && npx cross-env TS_NODE_PROJECT=tsconfig.test.json TS_NODE_TRANSPILE_ONLY=1 node --require ts-node/register --test test/onboarding.test.ts`
Expected: 3 tests PASS

- [ ] **Step 6: 登记测试文件**

`server/package.json` 的 `test:unit` 行尾 `test/pwa.test.ts` 后追加 ` test/onboarding.test.ts`。

- [ ] **Step 7: 提交**

```bash
git add server/src/settings.ts server/src/storage.ts server/test/onboarding.test.ts server/package.json
git commit -m "feat(onboarding): onboarding.done 设置项与首装种子"
```

---

### Task 2: 前端——`/onboarding` 向导页与首登检测

**Files:**
- Create: `web/src/pages/onboarding.tsx`
- Create: `web/src/pages/onboarding.less`
- Modify: `web/src/App.tsx`（lazy import + 路由）
- Modify: `web/src/components/Layout.tsx`（管理员首登检测跳转）
- Modify: `web/src/i18n/en.ts`（新增键）

**Interfaces:**
- Consumes: Task 1 的 `onboarding.done`（GET/PUT `/api/settings`）；`web/src/api/client` 的 `get/put`；`isAdmin()`（`web/src/api/auth`）；`Empty`（action prop）
- Produces: 路由 `/onboarding`；settings 页 Task 3 依赖键 `onboarding.done` 与跳转函数 `resetOnboarding()`（Task 3 内实现，见其说明）

- [ ] **Step 1: 创建向导页**

新建 `web/src/pages/onboarding.tsx`（完整实现）：

```tsx
/**
 * 首次启动向导（1.88.0）：欢迎改密 → 环境扫描 → 可选配置 → 迁移对照
 * 仅管理员可见；每步独立调用 API 即时生效，可随时跳过。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../components/Button';
import { get, put } from '../api/client';
import { isAdmin } from '../api/auth';
import { translateNow as t } from '../i18n';
import './onboarding.less';

interface ScanResult { containers: number; images: number; compose: number }

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');

  useEffect(() => {
    document.title = t('欢迎使用 Docker Manager');
    // 默认账号判定：/api/auth/me 返回当前用户名（web/src/api/auth.ts 无 getUsername）
    get<{ username: string }>('/api/auth/me').then((r) => setUsername(r.username)).catch(() => {});
  }, []);

  /** 完成并写标记（bool 归一化由 settings 层处理） */
  const finish = async () => {
    await put('/api/settings/onboarding.done', { value: true });
    navigate('/');
  };

  /** 步骤②：并行扫描本机环境（失败降级为 0，不阻塞） */
  const runScan = async () => {
    setBusy(true);
    const [c, i, cp] = await Promise.all([
      get<any[]>('/api/containers', { all: true }).catch(() => []),
      get<any[]>('/api/images').catch(() => []),
      get<any[]>('/api/compose').catch(() => []),
    ]);
    setScan({
      containers: Array.isArray(c) ? c.length : 0,
      images: Array.isArray(i) ? i.length : 0,
      compose: Array.isArray(cp) ? cp.filter((x: any) => x.source === 'external').length : 0,
    });
    setBusy(false);
  };
  useEffect(() => { if (step === 2 && !scan) { setBusy(true); runScan(); } }, [step]);

  return (
    <div className="onboard">
      <div className="onboard__progress">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={`onboard__dot ${step >= n ? 'is-active' : ''}`} />
        ))}
      </div>
      {step === 1 && (
        <div>
          <h1>{t('欢迎使用 Docker Manager')}</h1>
          <p>{t('本向导将带你完成初始设置（约 1 分钟）。')}</p>
          {username === 'admin' && (
            <div className="onboard__warn">
              {t('当前使用默认管理员账号，建议立即修改密码。')}
              <Button size="sm" onClick={() => navigate('/settings')}>{t('立即改密')}</Button>
            </div>
          )}
          <Button variant="primary" onClick={() => setStep(2)}>{t('开始')}</Button>
        </div>
      )}
      {step === 2 && (
        <div>
          <h1>{t('检测本机环境')}</h1>
          {busy ? <p>{t('扫描中...')}</p> : (
            <p>{t('发现 {{c}} 个容器、{{i}} 个镜像、{{k}} 个外部 Compose 项目（已自动纳管）', { c: scan?.containers ?? 0, i: scan?.images ?? 0, k: scan?.compose ?? 0 })}</p>
          )}
          <Button onClick={() => setStep(3)}>{t('下一步')}</Button>
        </div>
      )}
      {step === 3 && (
        <div>
          <h1>{t('可选：常用配置直达')}</h1>
          <p>{t('镜像加速源（国内建议配置）与告警通知渠道可稍后在对应页面设置，均可跳过。')}</p>
          <div className="onboard__links">
            <Button onClick={() => navigate('/hub')}>{t('镜像源设置')}</Button>
            <Button onClick={() => navigate('/notifications')}>{t('告警通知渠道')}</Button>
          </div>
          <Button variant="primary" onClick={() => setStep(4)}>{t('下一步')}</Button>
        </div>
      )}
      {step === 4 && (
        <div>
          <h1>{t('从 1Panel / 宝塔迁移对照')}</h1>
          <table className="onboard__table">
            <tbody>
              <tr><td>{t('网站 / 反向代理')}</td><td>{t('站点反代 + SSL 证书')}</td></tr>
              <tr><td>{t('应用商店')}</td><td>{t('应用商店（AppStore）')}</td></tr>
              <tr><td>{t('计划任务')}</td><td>{t('计划任务')}</td></tr>
              <tr><td>{t('本产品独有')}</td><td>{t('Edge 多节点 / Git 自动部署 / 高危操作审批流')}</td></tr>
            </tbody>
          </table>
          <Button variant="primary" onClick={finish}>{t('完成，进入面板')}</Button>
        </div>
      )}
      <Button variant="ghost" onClick={finish}>{t('跳过向导')}</Button>
    </div>
  );
}
```

> 注：`Input` / `getUsername` 的实际导入路径以仓库现有组件为准；本计划已解析——当前用户名经 `GET /api/auth/me` 获取（`getUsername` 不存在）；`hub.source` 未在 settings 注册中心注册，故步骤③不做写操作、仅提供页面直达链接。

新建 `web/src/pages/onboarding.less`（居中卡片布局，复用全局 CSS 变量）：

```less
/* 首次启动向导（1.88.0） */
.onboard {
  max-width: 560px;
  margin: 8vh auto 0;
  padding: 32px 28px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  background: var(--bg-secondary, #fff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 12px;
}

.onboard__progress {
  display: flex;
  gap: 8px;
}

.onboard__dot {
  width: 32px;
  height: 4px;
  border-radius: 2px;
  background: var(--border-color, #e5e7eb);

  &.is-active {
    background: var(--primary, #6366f1);
  }
}

.onboard__warn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 13px;
  color: #b45309;
  background: rgba(245, 158, 11, 0.1);
}

.onboard__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-color, #e5e7eb);
  }
}

.onboard__links {
  display: flex;
  gap: 12px;
}
```

- [ ] **Step 2: 路由注册**

`web/src/App.tsx`：在 `const LoginPage = lazy(...)` 附近加：

```tsx
const OnboardingPage = lazy(() => import('./pages/onboarding'));
```

在 `<Route path="/login" .../>` 之后、`<Route element={<RequireAuth />}>` 内、`<Route element={<Layout />}>` **之前**（与 Layout 平级，全屏无侧栏）插入：

```tsx
          <Route
            path="/onboarding"
            element={
              <PageSuspense>
                <OnboardingPage />
              </PageSuspense>
            }
          />
```

- [ ] **Step 3: 首登检测（Layout）**

`web/src/components/Layout.tsx` 组件体内加入（与现有数据加载 useEffect 并列）：

```tsx
  // 首装向导检测（1.88.0）：管理员 + 待完成标记 → 跳转向导
  const navigate = useNavigate();
  useEffect(() => {
    if (!isAdmin()) return;
    get<{ items: Array<{ key: string; value: any }> }>('/api/settings')
      .then((r) => {
        const item = (r.items || []).find((x) => x.key === 'onboarding.done');
        if (item && item.value === false) navigate('/onboarding');
      })
      .catch(() => {});
  }, []);
```

（`isAdmin` 自 `../api/auth` 导入；若 Layout 已有 `useNavigate` 则复用现有实例。）

- [ ] **Step 4: i18n 键**

`web/src/i18n/en.ts` 锚点 `"CI 状态门禁"` 后追加：

```typescript
  "欢迎使用 Docker Manager": "Welcome to Docker Manager",
  "开始": "Start",
  "检测本机环境": "Detect local environment",
  "扫描中...": "Scanning...",
  "可选：常用配置直达": "Optional: quick configuration",
  "镜像加速源（国内建议配置）与告警通知渠道可稍后在对应页面设置，均可跳过。": "Registry mirrors (recommended for CN users) and alert channels can be configured later in their pages.",
  "镜像源设置": "Registry mirrors",
  "告警通知渠道": "Alert channels",
  "下一步": "Next",
  "完成，进入面板": "Finish and open the panel",
  "跳过向导": "Skip the wizard",
  "重看首装向导": "Replay the setup wizard",
```

（向导其余长句沿用中文回退，与 help.tsx 现状一致；后续版本再补翻。`useToast` 已从向导导入中移除——未使用。'立即改密' / '取消' 等键已存在 en.ts，无需重复添加。）

- [ ] **Step 5: 构建验证**

Run: `npm run build`
Expected: 无 TS 错误（含严格检查）。

- [ ] **Step 6: 提交**

```bash
git add web/src/pages/onboarding.tsx web/src/pages/onboarding.less web/src/App.tsx web/src/components/Layout.tsx web/src/i18n/en.ts
git commit -m "feat(onboarding): /onboarding 四步首装向导与管理员首登检测"
```

---

### Task 3: 设置页重看入口 + 列表页空状态 CTA

**Files:**
- Modify: `web/src/pages/settings.tsx`（关于卡片）
- Modify: `web/src/pages/containers.tsx`、`web/src/pages/images.tsx`、`web/src/pages/compose.tsx`（Empty action）

**Interfaces:**
- Consumes: `onboarding.done`（Task 1）；Empty 组件 `action?: React.ReactNode`；`isAdmin()`

- [ ] **Step 1: 设置页重看按钮**

`settings.tsx` 关于卡 `安装到桌面` 行后追加行：

```tsx
          <div className="settings-info__row">
            <span>{t('重看首装向导')}</span>
            <Button size="sm" variant="ghost" onClick={async () => {
              await put('/api/settings/onboarding.done', { value: '0' });
              navigate('/onboarding');
            }}>
              {t('打开')}
            </Button>
          </div>
```

（`put` 来自 `../api/client`——该页已导入 `put`；`navigate` 若未引入则 `const navigate = useNavigate()`。）

- [ ] **Step 2: 空状态 CTA**

三处 `<Empty ... />` 以各页现有调用为锚点，仅增加 `action` 属性（保持原 title 文案不变）：

```tsx
// containers.tsx 空态（setCreateOpen 换成该页实际的创建弹窗打开函数）
<Empty title={t('暂无容器')} action={<Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>{t('创建容器')}</Button>} />
```

```tsx
// images.tsx 空态（setPullOpen 换成该页拉取弹窗状态函数）
<Empty title={t('暂无镜像')} action={<Button size="sm" variant="primary" onClick={() => setPullOpen(true)}>{t('拉取镜像')}</Button>} />
```

```tsx
// compose.tsx 空态（跳转新建 / 纳管入口）
<Empty title={t('暂无编排项目')} action={<Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>{t('新建编排')}</Button>} />
```

（`setCreateOpen` / `setPullOpen` 等以各页实际弹窗状态变量名为准——实现者在对应文件内搜索既有 Modal 打开函数替换。）

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/settings.tsx web/src/pages/containers.tsx web/src/pages/images.tsx web/src/pages/compose.tsx
git commit -m "feat(onboarding): 设置页重看入口与列表页空状态引导"
```

---

### Task 4: 测试补全 + 文档 + 发版仪式

**Files:**
- Modify: `CHANGELOG.md`、`README.md`、`docs/DockerManager-操作手册.md`、`docs/DockerManager-User-Manual.md`、`web/src/pages/help.tsx`

**Interfaces:**
- Consumes: Task 1-3 全部交付物

- [ ] **Step 1: 全量验证**

```bash
npm run build          # 类型检查 + 构建
npm run test:server:unit   # 全量单测（含 onboarding.test.ts）
npm run docs:check     # 图片 + README 版本号
```

- [ ] **Step 2: 文档四件套**

- `CHANGELOG.md` 新增 `## [1.88.0]` 段：首装向导（四步）、空状态引导、存量库零打扰、重看入口
- `README.md` 功能列表加一行「**首次启动向导（1.88.0）**：欢迎改密提醒、一键检测纳管本机环境、镜像源预配置、竞品迁移概念对照」
- 双手册各加「首次启动向导」小节（中文 §使用说明头部，英文对应章节）
- `help.tsx` FAQ 加「首装向导会再次出现吗？」条目 + settings 速查 desc 追加

- [ ] **Step 3: 版本号与发布**

按既有仪式：3 个 package.json bump 1.88.0 → `npm run docs:sync-version` → commit/tag/push → Release 轮询 → 本机生产升级。

---

## Self-Review 结果

1. **Spec 覆盖**：触发与状态（Task 1 种子 + Task 2 检测/完成标记/重开入口）✓；四步流程（Task 2）✓；空状态 CTA（Task 3）✓；边界处理（Task 2 降级 + 存量零打扰 Task 1 测试覆盖）✓；测试/文档/i18n（Task 4）✓
2. **占位符**：Task 2 Step 1 内对组件导入路径与 hub.source 键给出了「以实际为准 + 不引用未注册键」的显式处置规则，非占位符；其余步骤均含完整代码。
3. **类型一致性**：`seedOnboardingFlag()`（Task 1 定义 → storage 内部调用与单测一致）；`onboarding.done` 键名三处任务统一；Empty `action` 与组件现有签名一致。
