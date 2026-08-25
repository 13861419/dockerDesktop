/**
 * AI 助手客户端与配置（零依赖，OpenAI 兼容协议）
 *
 * 通过 OpenAI 兼容的 Chat Completions 接口提供智能能力。配置存于 SQLite 的
 * ai_settings 单行表，apiKey 经 storage.encryptSecret 对称加密落库。
 *
 * 遵循项目"可选工具 + 优雅降级"风格（同 trivyCli.ts / gitCli.ts）：
 *  - 未配置时 isAiConfigured()/getAiConfig() 返回 enabled:false，不发起任何外部请求
 *  - assertAiEnabled() 在未配置时抛带 statusCode=503 的错误，供前端识别
 *  - 纯函数（buildSystemPrompt / parseChatResponse / chatCompletion 的请求构造）便于单测
 *
 * SSRF 防护：baseUrl 仅允许 https:// 或 http://localhost / http://127.0.0.1。
 * 本文件不依赖任何第三方 npm 包（Node >= 18 内置 fetch / AbortController）。
 */
import { getDb, encryptSecret, decryptSecret } from './storage';
import type { AiProfilePublic } from './aiProfiles';

/** AI 配置（解密后的运行时视图） */
export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  timeoutMs: number;
}

/** 聊天消息 */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** ai_settings 表行 */
interface AiSettingsRow {
  enabled: number;
  base_url: string;
  model: string;
  api_key_enc: string;
  system_prompt: string;
  timeout_ms: number;
  updated_at: number;
}

/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 60000;

/** 允许的 baseUrl 前缀白名单（SSRF 防护） */
function isAllowedBaseUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('https://')) return true;
  if (url.startsWith('http://localhost')) return true;
  if (url.startsWith('http://127.0.0.1')) return true;
  if (url.startsWith('http://[::1]')) return true;
  return false;
}

/** 读取配置行（不存在则返回默认关闭态，不落库） */
function getRow(): AiSettingsRow {
  const d = getDb();
  const row = d.prepare('SELECT enabled, base_url, model, api_key_enc, system_prompt, timeout_ms FROM ai_settings WHERE id = 1').get() as
    | AiSettingsRow
    | undefined;
  if (!row) {
    return { enabled: 0, base_url: '', model: '', api_key_enc: '', system_prompt: '', timeout_ms: DEFAULT_TIMEOUT_MS, updated_at: 0 };
  }
  return row;
}

/**
 * 读取配置（解密 apiKey）；未配置返回 { enabled:false }
 */
export function getAiConfig(): AiConfig {
  const row = getRow();
  return {
    enabled: !!row.enabled,
    baseUrl: row.base_url || '',
    model: row.model || '',
    apiKey: decryptSecret(row.api_key_enc || ''),
    systemPrompt: row.system_prompt || '',
    timeoutMs: row.timeout_ms > 0 ? row.timeout_ms : DEFAULT_TIMEOUT_MS,
  };
}

/** 是否已配置可用（enabled && baseUrl && model && baseUrl 合法） */
export function isAiConfigured(): boolean {
  const cfg = getAiConfig();
  return !!(
    cfg.enabled &&
    cfg.baseUrl &&
    cfg.model &&
    isAllowedBaseUrl(cfg.baseUrl)
  );
}

/** 未启用时抛 statusCode=503，供前端识别「未配置 AI」 */
export function assertAiEnabled(): AiConfig {
  if (!isAiConfigured()) {
    const e: any = new Error('AI 助手未配置或未启用，请先在设置中完成配置');
    e.statusCode = 503;
    throw e;
  }
  return getAiConfig();
}

/**
 * 校验 baseUrl 是否合法（SSRF 防护），供 PUT settings 时使用
 * @throws 非法时抛带 statusCode=400 的错误
 */
export function assertValidBaseUrl(url: string): void {
  if (!isAllowedBaseUrl(url)) {
    const e: any = new Error('baseUrl 仅允许 https:// 或本机 http://localhost');
    e.statusCode = 400;
    throw e;
  }
}

/** 判断给定值为"非空配置块"的最小单元（内部用） */
function hasConfigured(cfg: AiConfig): boolean {
  return !!(cfg.baseUrl && cfg.model && cfg.apiKey);
}

/**
 * 更新 AI 配置（部分更新：只覆盖传入字段，apiKey 空串=不修改）
 * @param input 待更新字段
 * @returns 更新后的配置
 */
export function updateAiConfig(input: {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  timeoutMs?: number;
}): AiConfig {
  const d = getDb();
  const existing = getRow();
  const now = Date.now();

  const baseUrl = input.baseUrl !== undefined ? String(input.baseUrl).trim() : existing.base_url;
  if (baseUrl && existing.base_url !== baseUrl) {
    // 校验新 baseUrl 合法性
    assertValidBaseUrl(baseUrl);
  }

  const next: AiSettingsRow = {
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    base_url: baseUrl,
    model: input.model !== undefined ? String(input.model).trim() : existing.model,
    api_key_enc:
      input.apiKey !== undefined && String(input.apiKey).trim() !== ''
        ? encryptSecret(String(input.apiKey).trim())
        : existing.api_key_enc,
    system_prompt:
      input.systemPrompt !== undefined ? String(input.systemPrompt).trim() : existing.system_prompt,
    timeout_ms:
      input.timeoutMs !== undefined && Number(input.timeoutMs) > 0
        ? Math.min(Number(input.timeoutMs), 300000)
        : existing.timeout_ms,
    updated_at: now,
  };

  const existingRow = d.prepare('SELECT id FROM ai_settings WHERE id = 1').get();
  if (existingRow) {
    d.prepare(
      `UPDATE ai_settings SET enabled=?, base_url=?, model=?, api_key_enc=?, system_prompt=?, timeout_ms=?, updated_at=? WHERE id=1`,
    ).run(
      next.enabled,
      next.base_url,
      next.model,
      next.api_key_enc,
      next.system_prompt,
      next.timeout_ms,
      now,
    );
  } else {
    d.prepare(
      `INSERT INTO ai_settings (id, enabled, base_url, model, api_key_enc, system_prompt, timeout_ms, updated_at) VALUES (1,?,?,?,?,?,?,?)`,
    ).run(
      next.enabled,
      next.base_url,
      next.model,
      next.api_key_enc,
      next.system_prompt,
      next.timeout_ms,
      now,
    );
  }

  return {
    enabled: !!next.enabled,
    baseUrl: next.base_url,
    model: next.model,
    apiKey: decryptSecret(next.api_key_enc || ''),
    systemPrompt: next.system_prompt,
    timeoutMs: next.timeout_ms,
  };
}

/**
 * 构造发送给模型的 system prompt + 用户消息列表（纯函数，便于单测）
 * @param cfg 配置
 * @param context 环境上下文文本（容器列表 / 日志等）
 * @param userText 用户输入
 */
export function buildSystemPrompt(cfg: AiConfig, context: string, userText: string): AiMessage[] {
  const base =
    cfg.systemPrompt ||
    '你是 Docker 管理面板的内置 AI 运维助手。回答要简洁、准确、可操作；' +
      '只提供建议与生成内容，绝不直接执行任何破坏性 Docker 操作。涉及需执行的操作，请让用户在面板中确认后执行。';
  const messages: AiMessage[] = [{ role: 'system', content: base }];
  if (context) {
    messages.push({ role: 'system', content: `以下是当前环境上下文（供参考，勿泄露给用户无关逻辑）：\n${context}` });
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

/**
 * 构造 OpenAI 兼容 /chat/completions 的请求体（纯函数，便于单测）
 * @param model 模型名
 * @param messages 消息
 */
export function buildChatBody(
  model: string,
  messages: AiMessage[],
): {
  model: string;
  messages: AiMessage[];
  stream: boolean;
} {
  return { model, messages, stream: false };
}

/**
 * 从 /chat/completions 响应体提取 assistant 文本（纯函数）
 * @param body 响应 JSON
 * @returns assistant 内容；无内容返回空串
 */
export function parseChatResponse(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as any;
  const choices = Array.isArray(b.choices) ? b.choices : [];
  const first = choices[0];
  if (first && typeof first.message === 'object' && first.message != null) {
    const c = first.message.content;
    if (typeof c === 'string') return c;
  }
  return '';
}

/**
 * 调用 OpenAI 兼容 /chat/completions（手写 fetch + AbortController 超时）
 * @param cfg 配置（须已 enabled）
 * @param messages 消息
 * @returns assistant 文本
 * @throws 网络/HTTP 错误时抛带 statusCode 的错误
 */
export async function chatCompletion(cfg: AiConfig, messages: AiMessage[]): Promise<string> {
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || DEFAULT_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(buildChatBody(cfg.model, messages)),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      const e: any = new Error(`AI 请求超时（${(cfg.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000}s）`);
      e.statusCode = 504;
      throw e;
    }
    const e: any = new Error(`AI 连接失败: ${err?.message || err}`);
    e.statusCode = 502;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const j: any = await resp.json();
      detail = j?.error?.message || JSON.stringify(j);
    } catch {
      detail = await resp.text().catch(() => '');
    }
    const e: any = new Error(`AI 接口返回 ${resp.status}: ${detail || '无错误详情'}`);
    e.statusCode = 502;
    throw e;
  }

  const body = await resp.json().catch(() => null);
  const text = parseChatResponse(body);
  if (!text) {
    const e: any = new Error('AI 响应为空或格式异常');
    e.statusCode = 502;
    throw e;
  }
  return text;
}

/** 供 settings 页 HTTP 测试调用（仅发最小请求验证连通性） */
export async function testAiConnection(cfg?: AiConfig): Promise<{ ok: boolean; message: string }> {
  const target = cfg || getAiConfig();
  if (!target.baseUrl || !target.model) {
    return { ok: false, message: '请先配置 baseUrl 与模型' };
  }
  if (!isAllowedBaseUrl(target.baseUrl)) {
    return { ok: false, message: 'baseUrl 需为 https:// 或本机 http://localhost' };
  }
  try {
    const reply = await chatCompletion(target, [
      { role: 'user', content: '请回复"ok"（无需其它内容）' },
    ]);
    return { ok: true, message: `连通成功：${reply.slice(0, 200)}` };
  } catch (err: any) {
    return { ok: false, message: err?.message || '连接失败' };
  }
}

/** 是否至少已配置基础项（baseUrl+model+apiKey，但 enabled 可为 false），供前端「配置卡」判断 */
export function hasConfiguredCredentials(): boolean {
  return hasConfigured(getAiConfig());
}

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
