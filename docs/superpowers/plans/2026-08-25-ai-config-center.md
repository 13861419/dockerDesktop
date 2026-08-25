# AI 模型配置中心（多套配置文件 + 本地/三方预设）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AI 助手单套配置升级为"多套配置文件(Profile) + 内置本地/三方预设，一键填充、随时切换"，并平滑迁移旧 `ai_settings` 数据。

**Architecture:** 新建 `ai_profiles` 表（`api_key_enc` 加密）持久化用户配置；新增 `aiProfiles.ts`（建表/迁移/CRUD 纯函数）与 `aiPresets.ts`（只读预设常量）；扩展 `routes/ai.ts` 提供 profiles/presets/test/default API；保留 `/api/ai/settings` 兼容（读当前默认）。`chatCompletion` 改为接收传入 profile 而非读全局单套。前端 AI 助手配置弹窗升级为「模型配置中心」双 Tab。

**Tech Stack:** Node ≥22 · Express · node:sqlite（DatabaseSync）· React 18 + TS + Vite · 零第三方 npm 运行时依赖（测试用 node:test + ts-node）。

## Global Constraints

- **零第三方 npm 运行时依赖**：后端只用 Node 内置模块（`node:sqlite`、`crypto`、`https`/`http`、`fetch`）+ Express + dockerode。不得引入新 npm 包。
- **SSRF 防护**：baseUrl 仅允许 `https://`、`http://localhost`、`http://127.0.0.1`、`http://[::1]`（复用 `aiClient.ts` 的 `isAllowedBaseUrl`）。所有 preset 与自定义输入都必须通过该校验。
- **密钥加密**：apiKey 一律经 `storage.ts` 的 `encryptSecret` 加密落库，前端只回显 `hasKey` 布尔。
- **兼容性**：保留 `GET/PUT /api/ai/settings`；`ai_settings` 旧表不清除，只读兼容；迁移幂等。
- **现有测试**：`server/test/aiClient.test.ts`（纯函数）不得破坏。
- 文件路径大小写/命名沿用项目惯例（`camelCase.ts`）。

---

## Task 1: 新建 `ai_profiles` 表 + 迁移 + CRUD 纯函数

**Files:**
- Modify: `server/src/storage.ts`（在 `ai_settings` 建表后追加 `ai_profiles` 建表）
- Create: `server/src/aiProfiles.ts`
- Test: `server/test/aiProfiles.test.ts`

**Interfaces:**
- Consumes: `storage.ts` 的 `getDb`/`encryptSecret`/`decryptSecret`
- Produces:
  - `interface AiProfileRow { id:number; name:string; kind:'local'|'cloud'; provider:string; base_url:string; model:string; api_key_enc:string; system_prompt:string; timeout_ms:number; is_default:number; created_at:number; updated_at:number }`
  - `export interface AiProfilePublic { id:number; name:string; kind:'local'|'cloud'; provider:string; baseUrl:string; model:string; hasKey:boolean; isDefault:boolean; timeoutMs:number; systemPrompt:string }`
  - `export function ensureAiProfiles(): void` — 建迁移：若 `ai_settings` 有数据且尚未迁移，迁成首条 profile 并设默认
  - `export function listProfiles(): AiProfilePublic[]`
  - `export function getDefaultProfile(): AiProfilePublic | null`
  - `export function getProfileById(id:number): AiProfilePublic | null`
  - `export function createProfile(input: {...}): AiProfilePublic`
  - `export function updateProfile(id:number, patch: {...}): AiProfilePublic`
  - `export function deleteProfile(id:number): void`
  - `export function setDefaultProfile(id:number): AiProfilePublic`

- [ ] **Step 1: 在 storage.ts 追加 `ai_profiles` 建表**

在 `ai_settings` 建表（约 479-488 行）之后追加：

```sql
CREATE TABLE IF NOT EXISTS ai_profiles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'local',
  provider      TEXT NOT NULL DEFAULT 'custom',
  base_url      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  api_key_enc   TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  timeout_ms    INTEGER NOT NULL DEFAULT 60000,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

- [ ] **Step 2: 写失败测试（迁移部分）**

Create `server/test/aiProfiles.test.ts`. **重要**：本项目数据目录由 `process.env.DOCKERMANAGER_DATA` 决定，且 `resolveDataDir()` 仅在 storage 模块 import 时解析一次。因此必须**在 import storage 之前**设置该环境变量，参照 `webhook-git.test.ts` 的隔离模式：

```ts
/**
 * AI 配置文件（aiProfiles）单元测试
 * 运行：先设 DOCKERMANAGER_DATA 到临时目录再 import storage，避免污染真实 data/。
 * 覆盖：迁移 / CRUD / 默认切换 / 删除保护 / SSRF / getProfileApiKey
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 必须先于 storage import 设置临时数据目录（DATA_DIR 随模块加载解析一次）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-aiprofiles-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { DatabaseSync } from 'node:sqlite';
import { initStorage, closeDb, getDb } from '../src/storage';
import {
  ensureAiProfiles,
  listProfiles,
  getDefaultProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  setDefaultProfile,
  getProfileApiKey,
} from '../src/aiProfiles';

before(() => {
  initStorage();
});
after(() => {
  closeDb();
});

/** 每测前清空 ai_profiles（同文件共享一个临时 DB，靠清表隔离；复用 storage 连接避免二次连库锁冲突） */
function resetProfiles() {
  getDb().exec('DELETE FROM ai_profiles');
}

test('ai_settings 有数据时迁移为首条默认 profile', () => {
  resetProfiles();
  // 预置 ai_settings 数据（复用 storage 连接）
  getDb().exec('DELETE FROM ai_settings');
  getDb().prepare('INSERT INTO ai_settings (id, enabled, base_url, model, api_key_enc, system_prompt, timeout_ms, updated_at) VALUES (1,1,?,?,?,?,?,?)')
    .run('http://127.0.0.1:9119/v1', 'm', 'ENCKEY', '', 60000, Date.now());

  ensureAiProfiles();
  const list = listProfiles();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].baseUrl, 'http://127.0.0.1:9119/v1');
  assert.strictEqual(list[0].model, 'm');
  assert.ok(list[0].isDefault);
});

test('ensureAiProfiles 幂等：迁移后再次调用不重复', () => {
  resetProfiles();
  ensureAiProfiles();
  const first = listProfiles().length;
  ensureAiProfiles();
  assert.strictEqual(listProfiles().length, first);
});
```

> 该测试在当前实现下**会失败**（`aiProfiles.ts` 尚不存在）。运行确认失败。

Run: `cd server; npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test test/aiProfiles.test.ts`
Expected: FAIL（`Cannot find module '../src/aiProfiles'`）

- [ ] **Step 3: 实现 `aiProfiles.ts`（建表 + 迁移 + CRUD）**

创建 `server/src/aiProfiles.ts`。`aiProfiles.ts` 复用 `getDb()`（DB 文件由 storage 决定）；测试通过 `DOCKERMANAGER_DATA` 环境变量在 import 前指向临时目录（见 Step 2），无需在模块内注入路径。

```ts
/**
 * AI 配置文件（ai_profiles）模块
 *
 * 多套 OpenAI 兼容配置，支持本地(Local)与云端(Cloud)并存、一键切换默认。
 * apiKey 经 encryptSecret 加密落库；前端只回显 hasKey 布尔。
 */
import { getDb, encryptSecret, decryptSecret } from './storage';

export type AiProfileKind = 'local' | 'cloud';

export interface AiProfileRow {
  id: number;
  name: string;
  kind: AiProfileKind;
  provider: string;
  base_url: string;
  model: string;
  api_key_enc: string;
  system_prompt: string;
  timeout_ms: number;
  is_default: number;
  created_at: number;
  updated_at: number;
}

export interface AiProfilePublic {
  id: number;
  name: string;
  kind: AiProfileKind;
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  isDefault: boolean;
  timeoutMs: number;
  systemPrompt: string;
}

export interface AiProfileInput {
  name?: string;
  kind?: AiProfileKind;
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

function mapRow(r: AiProfileRow): AiProfilePublic {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    provider: r.provider,
    baseUrl: r.base_url,
    model: r.model,
    hasKey: !!r.api_key_enc,
    isDefault: !!r.is_default,
    timeoutMs: r.timeout_ms,
    systemPrompt: r.system_prompt,
  };
}

/**
 * 幂等迁移：若 ai_settings 存在有效配置且 ai_profiles 为空，则迁成首条默认 profile。
 * 每个 data 环境只跑一次（依据 ai_profiles 表是否存在数据）。
 */
export function ensureAiProfiles(): void {
  const d = getDb();
  const profileCount = (d.prepare('SELECT COUNT(*) AS c FROM ai_profiles').get() as { c: number }).c;
  if (profileCount > 0) return;
  const legacy = d
    .prepare('SELECT enabled, base_url, model, api_key_enc, system_prompt, timeout_ms FROM ai_settings WHERE id = 1')
    .get() as any;
  if (legacy && (legacy.base_url || legacy.model)) {
    const now = Date.now();
    d.prepare(
      `INSERT INTO ai_profiles (name, kind, provider, base_url, model, api_key_enc, system_prompt, timeout_ms, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      legacy.model ? `AI-${legacy.model}` : 'AI 助手',
      legacy.base_url.startsWith('http://localhost') || legacy.base_url.startsWith('http://127.0.0.1') || legacy.base_url.startsWith('http://[::1]') ? 'local' : 'cloud',
      'custom',
      legacy.base_url,
      legacy.model,
      legacy.api_key_enc || '',
      legacy.system_prompt || '',
      legacy.timeout_ms > 0 ? legacy.timeout_ms : 60000,
      now,
      now,
    );
  }
}

/** 唯一默认：把其它行 is_default 清 0，指定行置 1（就地保证单默认） */
function soleDefault(d: any, id: number): void {
  d.prepare('UPDATE ai_profiles SET is_default = 0').run();
  d.prepare('UPDATE ai_profiles SET is_default = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function listProfiles(): AiProfilePublic[] {
  const rows = getDb().prepare('SELECT * FROM ai_profiles ORDER BY is_default DESC, id ASC').all() as AiProfileRow[];
  return rows.map(mapRow);
}

export function getDefaultProfile(): AiProfilePublic | null {
  const row = getDb().prepare('SELECT * FROM ai_profiles WHERE is_default = 1 LIMIT 1').get() as AiProfileRow | undefined;
  return row ? mapRow(row) : null;
}

export function getProfileById(id: number): AiProfilePublic | null {
  const row = getDb().prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as AiProfileRow | undefined;
  return row ? mapRow(row) : null;
}

function hasChangedBaseUrl(prev: string, next: string | undefined): boolean {
  return next !== undefined && next !== prev;
}

/**
 * 校验 baseUrl 合法（SSRF 防护）。本地回环或 https 均可。
 */
export function assertValidBaseUrl(url: string): void {
  if (!url) return;
  const ok =
    url.startsWith('https://') ||
    url.startsWith('http://localhost') ||
    url.startsWith('http://127.0.0.1') ||
    url.startsWith('http://[::1]');
  if (!ok) {
    const e: any = new Error('baseUrl 仅允许 https:// 或本机 http://localhost');
    e.statusCode = 400;
    throw e;
  }
}

export function createProfile(input: AiProfileInput = {}): AiProfilePublic {
  const d = getDb();
  const baseUrl = (input.baseUrl || '').trim();
  if (baseUrl) assertValidBaseUrl(baseUrl);
  const now = Date.now();
  const hasAny = (d.prepare('SELECT COUNT(*) AS c FROM ai_profiles').get() as { c: number }).c > 0;
  const isDefault = !hasAny ? 1 : 0;
  const res = d.prepare(
    `INSERT INTO ai_profiles (name, kind, provider, base_url, model, api_key_enc, system_prompt, timeout_ms, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    (input.name || '').trim() || 'AI 助手',
    input.kind === 'cloud' ? 'cloud' : 'local',
    (input.provider || 'custom').trim(),
    baseUrl,
    (input.model || '').trim(),
    input.apiKey && String(input.apiKey).trim() ? encryptSecret(String(input.apiKey).trim()) : '',
    (input.systemPrompt || '').trim(),
    input.timeoutMs && Number(input.timeoutMs) > 0 ? Math.min(Number(input.timeoutMs), 300000) : 60000,
    isDefault,
    now,
    now,
  );
  return mapRow(d.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(res.lastInsertRowid) as AiProfileRow);
}

export function updateProfile(id: number, patch: AiProfileInput = {}): AiProfilePublic {
  const d = getDb();
  const row = d.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as AiProfileRow | undefined;
  if (!row) {
    const e: any = new Error('配置不存在');
    e.statusCode = 404;
    throw e;
  }
  const baseUrl = patch.baseUrl !== undefined ? String(patch.baseUrl).trim() : row.base_url;
  if (patch.baseUrl !== undefined && baseUrl) assertValidBaseUrl(baseUrl);
  const next: AiProfileRow = {
    ...row,
    name: patch.name !== undefined ? String(patch.name).trim() || row.name : row.name,
    kind: patch.kind === 'cloud' ? 'cloud' : patch.kind === 'local' ? 'local' : row.kind,
    provider: patch.provider !== undefined ? String(patch.provider).trim() || row.provider : row.provider,
    base_url: baseUrl,
    model: patch.model !== undefined ? String(patch.model).trim() : row.model,
    api_key_enc: patch.apiKey !== undefined && String(patch.apiKey).trim() !== '' ? encryptSecret(String(patch.apiKey).trim()) : row.api_key_enc,
    system_prompt: patch.systemPrompt !== undefined ? String(patch.systemPrompt).trim() : row.system_prompt,
    timeout_ms: patch.timeoutMs !== undefined && Number(patch.timeoutMs) > 0 ? Math.min(Number(patch.timeoutMs), 300000) : row.timeout_ms,
    updated_at: Date.now(),
  };
  d.prepare(
    `UPDATE ai_profiles SET name=?, kind=?, provider=?, base_url=?, model=?, api_key_enc=?, system_prompt=?, timeout_ms=?, updated_at=? WHERE id=?`,
  ).run(next.name, next.kind, next.provider, next.base_url, next.model, next.api_key_enc, next.system_prompt, next.timeout_ms, next.updated_at, id);
  return mapRow(next);
}

export function deleteProfile(id: number): void {
  const d = getDb();
  const row = d.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as AiProfileRow | undefined;
  if (!row) {
    const e: any = new Error('配置不存在');
    e.statusCode = 404;
    throw e;
  }
  const count = (d.prepare('SELECT COUNT(*) AS c FROM ai_profiles').get() as { c: number }).c;
  if (count <= 1) {
    const e: any = new Error('至少保留一个配置');
    e.statusCode = 400;
    throw e;
  }
  d.prepare('DELETE FROM ai_profiles WHERE id = ?').run(id);
  if (row.is_default) {
    // 删除的是默认：改选最早的一条为默认
    const first = d.prepare('SELECT * FROM ai_profiles ORDER BY id ASC LIMIT 1').get() as AiProfileRow | undefined;
    if (first) soleDefault(d, first.id);
  }
}

export function setDefaultProfile(id: number): AiProfilePublic {
  const d = getDb();
  const row = d.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as AiProfileRow | undefined;
  if (!row) {
    const e: any = new Error('配置不存在');
    e.statusCode = 404;
    throw e;
  }
  soleDefault(d, id);
  return mapRow(d.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as AiProfileRow);
}
```

- [ ] **Step 4: 让测试可用（已由 Step 2 的隔离模式覆盖）**

Step 2 已通过 `DOCKERMANAGER_DATA`（import 前设临时目录）+ `initStorage()` 建立隔离。此步无需额外改动——直接把 Step 2 的测试跑通即可进入 Step 5。

- [ ] **Step 5: 写剩余测试（CRUD / 默认切换 / 删除保护）**

在 `server/test/aiProfiles.test.ts` 末尾追加（沿用 Step 2 的 `resetProfiles()` 清表隔离；`getProfileApiKey` 断言 key 能解密还原）：

```ts
test('createProfile 首条自动设默认', () => {
  resetProfiles();
  const first = createProfile({ name: 'A-本地', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' });
  assert.ok(first.isDefault);
  assert.strictEqual(listProfiles().length, 1);
});

test('createProfile 校验 baseUrl（SSRF）', () => {
  resetProfiles();
  assert.throws(() => createProfile({ baseUrl: 'http://192.168.1.5/v1' }), /仅允许/);
  assert.throws(() => createProfile({ baseUrl: 'http://example.com/v1' }), /仅允许/);
  // 合法值不抛
  assert.doesNotThrow(() => createProfile({ baseUrl: 'https://api.openai.com/v1' }));
  assert.doesNotThrow(() => createProfile({ baseUrl: 'http://127.0.0.1:9119/v1' }));
});

test('setDefaultProfile 仅有一条默认', () => {
  resetProfiles();
  const a = createProfile({ name: 'A' });
  const b = createProfile({ name: 'B' });
  setDefaultProfile(b.id);
  const list = listProfiles();
  const defaults = list.filter((p) => p.isDefault);
  assert.strictEqual(defaults.length, 1);
  assert.strictEqual(defaults[0].id, b.id);
});

test('deleteProfile 禁止删除最后一条', () => {
  resetProfiles();
  const a = createProfile({ name: 'A' });
  const count = listProfiles().length;
  if (count === 1) {
    assert.throws(() => deleteProfile(a.id), /至少保留/);
  }
});

test('deleteProfile 删除默认后自动改选', () => {
  resetProfiles();
  const a = createProfile({ name: 'A' });
  const b = createProfile({ name: 'B' });
  // 默认应为首条 A；删除 A
  deleteProfile(a.id);
  const rest = listProfiles();
  assert.strictEqual(rest.length, 1);
  assert.ok(rest[0].isDefault);
});

test('getProfileApiKey 解密还原明文 key', () => {
  resetProfiles();
  const p = createProfile({ name: 'K', apiKey: 'sk-very-secret' });
  assert.strictEqual(getProfileApiKey(p.id), 'sk-very-secret');
});
```

- [ ] **Step 6: 运行全部 aiProfiles 测试，确认通过**

Run: `cd server; npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test test/aiProfiles.test.ts`
Expected: PASS（迁移 + CRUD 全部绿）

- [ ] **Step 7: 提交**

```bash
git add server/src/storage.ts server/src/aiProfiles.ts server/test/aiProfiles.test.ts
git commit -m "feat(ai): 多套配置文件 ai_profiles 表 + 迁移 + CRUD"
```

---

## Task 2: 内置预设常量 `aiPresets.ts`

**Files:**
- Create: `server/src/aiPresets.ts`
- Test: `server/test/aiPresets.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface AiPreset { id:string; name:string; kind:'local'|'cloud'; baseUrl:string; models:string[]; keyHint?:string }`
  - `export const AI_PRESETS: AiPreset[]` — 9 项（8 预设 + 1 custom 入口）
  - `export function getPresetById(id:string): AiPreset | undefined`

- [ ] **Step 1: 写失败测试**

Create `server/test/aiPresets.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { AI_PRESETS, getPresetById } from '../src/aiPresets';

test('预设清单完整：本地 3 + 三方 5', () => {
  const ids = AI_PRESETS.map((p) => p.id);
  assert.deepStrictEqual(ids.sort(), [
    'custom', 'dashscope', 'deepseek', 'gateway', 'lmstudio', 'moonshot', 'ollama', 'openai', 'zhipu',
  ].sort());
});

test('预设 baseUrl 全部通过 SSRF 白名单', () => {
  const ok = (u: string) => u.startsWith('https://') || u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1') || u.startsWith('http://[::1]');
  for (const p of AI_PRESETS) {
    if (p.id === 'custom') continue;
    assert.ok(ok(p.baseUrl), `${p.id} 的 baseUrl 非法: ${p.baseUrl}`);
  }
});

test('local/cloud 分组正确', () => {
  const local = AI_PRESETS.filter((p) => p.kind === 'local');
  assert.deepStrictEqual(local.map((p) => p.id).sort(), ['gateway', 'lmstudio', 'ollama']);
});

test('getPresetById 命中与未命中', () => {
  assert.strictEqual(getPresetById('openai')?.name, 'OpenAI');
  assert.strictEqual(getPresetById('nope'), undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server; npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test test/aiPresets.test.ts`
Expected: FAIL（`Cannot find module '../src/aiPresets'`）

- [ ] **Step 3: 实现 `aiPresets.ts`**

```ts
/** 内置 AI 提供商预设（只读常量） */
export interface AiPreset {
  id: string;
  name: string;
  kind: 'local' | 'cloud';
  baseUrl: string;
  models: string[];
  keyHint?: string;
}

export const AI_PRESETS: AiPreset[] = [
  { id: 'ollama', name: 'Ollama', kind: 'local', baseUrl: 'http://localhost:11434/v1', models: ['llama3.1', 'qwen2.5', 'mistral'] },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', baseUrl: 'http://localhost:1234/v1', models: [] },
  { id: 'gateway', name: '本地网关', kind: 'local', baseUrl: 'http://127.0.0.1:8000/v1', models: [] },
  { id: 'openai', name: 'OpenAI', kind: 'cloud', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], keyHint: 'sk-...' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'cloud', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], keyHint: 'sk-...' },
  { id: 'moonshot', name: 'Kimi (Moonshot)', kind: 'cloud', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], keyHint: 'sk-...' },
  { id: 'dashscope', name: '通义千问', kind: 'cloud', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], keyHint: 'sk-...' },
  { id: 'zhipu', name: '智谱 GLM', kind: 'cloud', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash'], keyHint: 'api key' },
  { id: 'custom', name: '自定义', kind: 'cloud', baseUrl: '', models: [] },
];

export function getPresetById(id: string): AiPreset | undefined {
  return AI_PRESETS.find((p) => p.id === id);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd server; npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test test/aiPresets.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/aiPresets.ts server/test/aiPresets.test.ts
git commit -m "feat(ai): 内置本地/三方模型预设常量"
```

---

## Task 3: 改造 `chatCompletion` 接收 profile + 保留旧配置兼容读取

**Files:**
- Modify: `server/src/aiClient.ts`（`chatCompletion`、`testAiConnection` 已接收 cfg 对象——核实签名；新增 `assertProfileEnabled` 可选）
- Test: `server/test/aiClient.test.ts`（补充一条）

**Interfaces:**
- Consumes: `aiClient.ts` 现有 `AiConfig`、`chatCompletion(cfg, messages)`
- Produces:
  - 确认 `chatCompletion(cfg: AiConfig, messages): Promise<string>` 已是接收 cfg 而非读全局 → 无需大改；`routes/ai.ts` 调用时传默认 profile 映射出的 `AiConfig`
  - `export function profileToAiConfig(p: AiProfilePublic): AiConfig`（放在 `aiClient.ts` 或 `aiProfiles.ts`，推荐 aiClient.ts）

- [ ] **Step 1: 读代码确认现有签名**

已在浏览中确认：`chatCompletion(cfg, messages)` 接收 cfg（line 258），`testAiConnection` 接收可选 cfg（line 310）。因此**无需改动这两个函数本身**——只要路由层把 profile 映射成 `AiConfig` 传入即可。

- [ ] **Step 2: 新增 `profileToAiConfig` 纯函数（写测试）**

在 `server/test/aiClient.test.ts` 追加：

```ts
import { profileToAiConfig } from '../src/aiClient';
// 合成一个 profilePublic 对象（不依赖 DB）
const prof = {
  id: 1, name: 'P', kind: 'local' as const, provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', hasKey: true,
  isDefault: true, timeoutMs: 60000, systemPrompt: '',
};

test('profileToAiConfig 正确映射', () => {
  const c = profileToAiConfig(prof as any);
  assert.strictEqual(c.baseUrl, 'http://localhost:11434/v1');
  assert.strictEqual(c.model, 'llama3.1');
  assert.strictEqual(c.enabled, true);
});
```

- [ ] **Step 3: 实现 `profileToAiConfig`**

在 `server/src/aiClient.ts` 末尾追加：

```ts
import type { AiProfilePublic } from './aiProfiles';

/** 把配置文件(profile)映射为 chatCompletion 所需 AiConfig */
export function profileToAiConfig(p: AiProfilePublic): AiConfig {
  return {
    enabled: true,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '', // 由调用方注入已解密的 key（见下）
    systemPrompt: p.systemPrompt,
    timeoutMs: p.timeoutMs,
  };
}
```

> 注：`apiKey` 从 `AiProfilePublic` 拿不到明文（只有 `hasKey`）。因此路由层需要另一个取解密 key 的入口。请在 `aiProfiles.ts` 增加 `export function getProfileApiKey(id:number): string`（返回 `decryptSecret(row.api_key_enc)`）。任务 4 的路由用它补全 `AiConfig.apiKey`。这一步先让 `profileToAiConfig` 存在，apiKey 字段留待路由注入。

- [ ] **Step 4: 运行确认通过**

Run: `cd server; npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test test/aiClient.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/aiClient.ts server/test/aiClient.test.ts
git commit -m "feat(ai): profileToAiConfig 映射"
```

---

## Task 4: 扩展 `routes/ai.ts` 提供 profiles/presets/test/default API

**Files:**
- Modify: `server/src/routes/ai.ts`
- Modify: `server/src/aiProfiles.ts`（新增 `getProfileApiKey`）
- Test: `server/test/aiProfiles.test.ts`（补 `getProfileApiKey` 用例）

**Interfaces:**
- Consumes: Task 1 的 `listProfiles/getDefaultProfile/getProfileById/createProfile/updateProfile/deleteProfile/setDefaultProfile/ensureAiProfiles`；Task 3 的 `profileToAiConfig`；`aiClient.ts` 的 `testAiConnection`
- Produces:
  - `GET /api/ai/presets` → `{ presets: AiPreset[] }`
  - `GET /api/ai/profiles` → `{ profiles: AiProfilePublic[] }`
  - `POST /api/ai/profiles` body → `AiProfilePublic`
  - `PUT /api/ai/profiles/:id` body → `AiProfilePublic`
  - `DELETE /api/ai/profiles/:id` → `{ ok: true }`
  - `POST /api/ai/profiles/:id/test` → `{ ok: boolean; message: string }`
  - `PUT /api/ai/profiles/:id/default` → `AiProfilePublic`
  - `GET /api/ai/settings`（改造）→ `{ enabled, available, defaultProfile: AiProfilePublic | null }`
  - `PUT /api/ai/settings`（改造）→ 更新全局开关 + 可选设置默认

- [ ] **Step 1: `aiProfiles.ts` 补 `getProfileApiKey` + 测试**

在 `aiProfiles.ts` 追加：

```ts
export function getProfileApiKey(id: number): string {
  const row = getDb().prepare('SELECT api_key_enc FROM ai_profiles WHERE id = ?').get(id) as { api_key_enc: string } | undefined;
  return row ? decryptSecret(row.api_key_enc || '') : '';
}
```

在 `aiProfiles.test.ts` 补测试：建一条带 key 的 profile → `getProfileApiKey(id)` 返回原文。

- [ ] **Step 2: 改 `routes/ai.ts`**

在文件顶部 import 补全：

```ts
import {
  ensureAiProfiles,
  listProfiles,
  getDefaultProfile,
  getProfileById,
  getProfileApiKey,
  createProfile,
  updateProfile,
  deleteProfile,
  setDefaultProfile,
} from '../aiProfiles';
import { AI_PRESETS } from '../aiPresets';
import { profileToAiConfig } from '../aiClient';
```

在 `publicConfig()` 下方新增辅助：

```ts
/** 取默认 profile 对应的 AiConfig（含解密 key） */
function defaultAiConfig() {
  const prof = getDefaultProfile();
  if (!prof) return null;
  const cfg = profileToAiConfig(prof);
  cfg.apiKey = getProfileApiKey(prof.id);
  return cfg;
}
```

改写现有 handler：

`GET /settings` → 返回 `{ enabled: isEnabled(), available: isAiConfigured(), defaultProfile: getDefaultProfile() }`，其中 `isEnabled()`/`isAiConfigured()` 需改为基于默认 profile 判断（见 Step 3）。

保持 `/chat` 使用默认 profile：把 `router.post('/chat')` 里的 `assertAiEnabled()` 替换为对默认 profile 的断言与配置获取（无默认则 503）。

补全新路由（全部 `requireAuth`，写操作 `requireAdmin`）：

```ts
router.get('/presets', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ presets: AI_PRESETS });
}));

router.get('/profiles', requireAuth, asyncHandler(async (_req, res) => {
  ensureAiProfiles();
  res.json({ profiles: listProfiles() });
}));

router.post('/profiles', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const p = createProfile(req.body || {});
  logOperation(res.locals.username, '新增 AI 配置', 'ai', null, p.name);
  res.json(p);
}));

router.put('/profiles/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const p = updateProfile(id, req.body || {});
  logOperation(res.locals.username, '编辑 AI 配置', 'ai', null, p.name);
  res.json(p);
}));

router.delete('/profiles/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  deleteProfile(Number(req.params.id));
  logOperation(res.locals.username, '删除 AI 配置', 'ai', null, String(req.params.id));
  res.json({ ok: true });
}));

router.post('/profiles/:id/test', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const prof = getProfileById(id);
  if (!prof) return res.status(404).json({ error: '配置不存在' });
  const cfg = profileToAiConfig(prof);
  cfg.apiKey = getProfileApiKey(id);
  const result = await testAiConnection(cfg);
  logOperation(res.locals.username, 'AI 配置测试', 'ai', null, result.ok ? '成功' : `失败: ${result.message}`);
  res.json({ ok: result.ok, message: result.message });
}));

router.put('/profiles/:id/default', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const p = setDefaultProfile(Number(req.params.id));
  logOperation(res.locals.username, '切换默认 AI 配置', 'ai', null, p.name);
  res.json(p);
}));
```

`PUT /settings`（改造）→ 仅更新全局开关键（持久化到 `ai_settings.enabled`，保留逻辑）与可选 `defaultProfileId`（调用 `setDefaultProfile`）。

> **重要**：现有的 `updateAiConfig`/`getAiConfig`/`isAiConfigured`/`assertAiEnabled` 仍在 `aiClient.ts` 中读写 `ai_settings`。为最小改动并保留兼容：`/chat` 优先用**默认 profile**；若无默认 profile 则回退旧 `getAiConfig()` 逻辑。请在实现时确保 `/chat`、`/test`（保留旧端点做兼容也行）不再强制依赖旧单套。
>
> **务必在每个读取 profile 的 handler 入口先调用 `ensureAiProfiles()`**（幂等且廉价），保证没 root 到 `ensureAiProfiles` 的旧路径也能先把旧 `ai_settings` 迁移成一份默认 profile。涉及：`GET /settings`、`GET /profiles`、`GET /capabilities`、`POST /chat`、`POST /test`。

- [ ] **Step 3: 同步 `isAiConfigured` 语义**

因配置主存已移到 profiles，建议在 `aiClient.ts` 保持旧函数不删（兼容旧 `/test`），但在 `routes/ai.ts` 层的 `/settings`、`/capabilities`、`/chat` 改为基于默认 profile。实现时以"默认 profile 是否存在且 baseUrl+model 合法"作为 `available` 判据。

- [ ] **Step 4: 编译检查**

Run: `cd server; npx tsc --noEmit -p server`
Expected: 无输出（通过）

- [ ] **Step 5: 运行 aiProfiles + aiClient 测试**

Run: `cd server; npx cross-env TS_NODE_PROJECT=tsconfig.test.json node --require ts-node/register --test test/aiProfiles.test.ts test/aiClient.test.ts test/aiPresets.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/routes/ai.ts server/src/aiClient.ts server/src/aiProfiles.ts server/test/
git commit -m "feat(ai): profiles/presets 路由 + 兼容 settings"
```

---

## Task 5: 前端类型 `web/src/types/index.ts`

**Files:**
- Modify: `web/src/types/index.ts`

**Interfaces:**
- Produces:
  - `interface AiProfile { id:number; name:string; kind:'local'|'cloud'; provider:string; baseUrl:string; model:string; hasKey:boolean; isDefault:boolean; timeoutMs:number; systemPrompt:string }`
  - `interface AiPreset { id:string; name:string; kind:'local'|'cloud'; baseUrl:string; models:string[]; keyHint?:string }`

- [ ] **Step 1: 追加类型**

在 `web/src/types/index.ts` 现有 `Ai*` 类型区追加：

```ts
export interface AiProfile {
  id: number;
  name: string;
  kind: 'local' | 'cloud';
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  isDefault: boolean;
  timeoutMs: number;
  systemPrompt: string;
}

export interface AiPreset {
  id: string;
  name: string;
  kind: 'local' | 'cloud';
  baseUrl: string;
  models: string[];
  keyHint?: string;
}
```

- [ ] **Step 2: 编译检查**

Run: `cd web; npx tsc --noEmit`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add web/src/types/index.ts
git commit -m "feat(web): AiProfile/AiPreset 类型"
```

---

## Task 6: AI 助手页升级为「模型配置中心」

**Files:**
- Modify: `web/src/pages/aiAssistant.tsx`
- Modify: `web/src/pages/aiAssistant.less`

**Interfaces:**
- Consumes: Task 5 类型；`api/client.ts` 的 `get`/`post`/`put`/`del`
- Produces: 配置弹窗双 Tab（预设 Tab + 我的配置 Tab）+ 页顶「当前模型」下拉

- [ ] **Step 1: 状态与数据**

新增 state：`profiles: AiProfile[]`、`presets: AiPreset[]`、`activeTab: 'preset'|'mine'`、`editing: AiProfile | null`、`currentModelId: number | null`。

新增加载：进入页面拉 `/api/ai/presets` 与 `/api/ai/profiles`；由 `defaultProfile` 得 `currentModelId`。

表单字段：`name/kind/provider/baseUrl/model/apiKey/systemPrompt/timeoutMs`。

- [ ] **Step 2: 预设 Tab**

- 按 `kind` 分「本地 / 云端」两组渲染卡片。
- 点卡片 → 自动填 `baseUrl` + `model` 下拉（用 `preset.models`）+ 设 `provider`/`kind`。
- 本地 type 显示"无 key 也可"；云端显示 key 输入。
- 「保存」→ `POST /api/ai/profiles` → 刷新列表。

- [ ] **Step 3: 我的配置 Tab**

- 表格列出 `profiles`：名称 / 类型徽标 / provider / 模型 / 是否默认 / key 状态。
- 操作：编辑（预填回表单）、删除（`DEL`）、设默认（`PUT :id/default`）、测试（`POST :id/test`，toast 结果）。
- 首条自动默认，删除最后一条前端直接禁点并提示。

- [ ] **Step 4: 页顶「当前模型」下拉**

- 渲染 `profiles` 为下拉，value=`currentModelId`。
- 变更 → `PUT /api/ai/profiles/:id/default` → 更新 `currentModelId`。
- 无 profile 时给出「立即配置」入口。

- [ ] **Step 5: 编译检查**

Run: `cd web; npx tsc --noEmit` 与 `cd web; npx vite build`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add web/src/pages/aiAssistant.tsx web/src/pages/aiAssistant.less
git commit -m "feat(web): AI 模型配置中心（预设+我的配置+切换默认）"
```

---

## Task 7: 回归 + 全量验证

- [ ] **Step 1: 跑后端单测**

Run: `cd server; npm run test:unit`
Expected: 全部通过（含新增 aiProfiles/aiPresets 与既有 120 项）

- [ ] **Step 2: 前后端 tsc**

Run: `cd server; npx tsc --noEmit -p server` 与 `cd web; npx tsc --noEmit`
Expected: 均无输出

- [ ] **Step 3: 前端构建**

Run: `cd web; npx vite build`
Expected: 成功

- [ ] **Step 4: 手测（可选）**

- 启动 `npm run dev:server` + `npm run dev:web`，登录 admin。
- AI 助手页 → 配置中心 → 预设 Tab 选 Ollama → 保存 → 我的配置出现该 profile → 页顶下拉切换 → 测试连接。
- 若无本地 AI，配一个云端预设（如不测真实调用，只看列表/切换/默认逻辑）。
- 确认旧 `/api/ai/settings` 仍可用。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore: AI 模型配置中心回归验证"
```
