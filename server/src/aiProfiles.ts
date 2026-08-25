/**
 * AI 配置文件（ai_profiles）模块
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
  const rows = getDb().prepare('SELECT * FROM ai_profiles ORDER BY is_default DESC, id ASC').all() as unknown as AiProfileRow[];
  return rows.map(mapRow);
}

export function getDefaultProfile(): AiProfilePublic | null {
  const row = getDb().prepare('SELECT * FROM ai_profiles WHERE is_default = 1 LIMIT 1').get() as unknown as AiProfileRow | undefined;
  return row ? mapRow(row) : null;
}

export function getProfileById(id: number): AiProfilePublic | null {
  const row = getDb().prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as unknown as AiProfileRow | undefined;
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
  return mapRow(d.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(res.lastInsertRowid) as unknown as AiProfileRow);
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
    const first = d.prepare('SELECT * FROM ai_profiles ORDER BY id ASC LIMIT 1').get() as unknown as AiProfileRow | undefined;
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
  return mapRow(d.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as unknown as AiProfileRow);
}

/** 解密还原明文 apiKey（供调用方使用）；配置存在但 key 为空时返回空串 */
export function getProfileApiKey(id: number): string {
  const d = getDb();
  const row = d.prepare('SELECT api_key_enc FROM ai_profiles WHERE id = ?').get(id) as { api_key_enc: string } | undefined;
  if (!row) {
    const e: any = new Error('配置不存在');
    e.statusCode = 404;
    throw e;
  }
  return row.api_key_enc ? decryptSecret(row.api_key_enc) : '';
}
