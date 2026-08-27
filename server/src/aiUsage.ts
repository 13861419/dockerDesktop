/**
 * AI 用量统计模块（ai_usage 表）
 *
 * 记录每次对话/流式调用的 token 用量，供 AI 配置中心用量面板聚合展示。
 * 零依赖，全部通过 getDb() 访问 SQLite，兼容存量数据库（表由 storage.initSchema 创建）。
 */
import { getDb } from './storage';

/** 单次用量记录入参 */
export interface AiUsageRecord {
  profileId?: number | null;
  provider?: string;
  model?: string;
  tool?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptChars?: number;
  completionChars?: number;
  success?: boolean;
  errorMessage?: string;
  username?: string;
}

/**
 * 估算字符串的 token 数（中文按 ~1 token/字，英文按 ~4 字符/token 的粗略近似）
 * 仅当上游未返回 usage 时用于兜底估算。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = text.length - cjk;
  // 中文每字约 1 token，其它按 ~4 字符/token，给出上取整近似
  return Math.max(1, cjk + Math.ceil(other / 4));
}

/**
 * 写入一条 AI 用量记录（幂等安全，失败静默不影响主体流程）
 */
export function recordAiUsage(rec: AiUsageRecord): void {
  try {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO ai_usage
         (profile_id, provider, model, tool, prompt_tokens, completion_tokens, total_tokens,
          prompt_chars, completion_chars, success, error_message, username, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rec.profileId ?? null,
        rec.provider || '',
        rec.model || '',
        rec.tool || 'chat',
        Math.max(0, rec.promptTokens ?? 0),
        Math.max(0, rec.completionTokens ?? 0),
        Math.max(0, rec.totalTokens ?? 0),
        Math.max(0, rec.promptChars ?? 0),
        Math.max(0, rec.completionChars ?? 0),
        rec.success === false ? 0 : 1,
        rec.errorMessage || '',
        rec.username || '',
        now,
      );
  } catch {
    // 用量写入失败不应阻断主流程，静默忽略
  }
}

/** 聚合统计结果 */
export interface AiUsageSummary {
  totalPrompt: number;
  totalCompletion: number;
  total: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
}

/** 按模型聚合的行 */
export interface AiUsageByModel {
  model: string;
  provider: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  successCalls: number;
}

/** 按天聚合的行（用于趋势图） */
export interface AiUsageByDay {
  day: string; // YYYY-MM-DD
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 汇总全部用量 */
export function summarizeAiUsage(): AiUsageSummary {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT
        COALESCE(SUM(prompt_tokens),0)     AS prompt,
        COALESCE(SUM(completion_tokens),0) AS completion,
        COALESCE(SUM(total_tokens),0)      AS total,
        COUNT(*)                           AS calls,
        COALESCE(SUM(success),0)           AS ok
       FROM ai_usage`,
    )
    .get() as { prompt: number; completion: number; total: number; calls: number; ok: number };
  return {
    totalPrompt: row.prompt,
    totalCompletion: row.completion,
    total: row.total,
    totalCalls: row.calls,
    successCalls: row.ok,
    failedCalls: row.calls - row.ok,
  };
}

/** 按模型聚合（按总 token 降序） */
export function listAiUsageByModel(): AiUsageByModel[] {
  return getDb()
    .prepare(
      `SELECT model, MAX(provider) AS provider,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0)     AS promptTokens,
              COALESCE(SUM(completion_tokens),0) AS completionTokens,
              COALESCE(SUM(total_tokens),0)      AS totalTokens,
              COALESCE(SUM(success),0)           AS successCalls
       FROM ai_usage
       WHERE model != ''
       GROUP BY model
       ORDER BY totalTokens DESC`,
    )
    .all() as unknown as AiUsageByModel[];
}

/** 按天聚合（最近 N 天，用于趋势） */
export function listAiUsageByDay(days: number): AiUsageByDay[] {
  const from = Date.now() - days * 24 * 3600 * 1000;
  return getDb()
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+8 hours') AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0)     AS promptTokens,
              COALESCE(SUM(completion_tokens),0) AS completionTokens,
              COALESCE(SUM(total_tokens),0)      AS totalTokens
       FROM ai_usage
       WHERE created_at >= ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(from) as unknown as AiUsageByDay[];
}

/** 按周聚合（最近 N 周） */
export function listAiUsageByWeek(weeks: number): Array<{ week: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number }> {
  const from = Date.now() - weeks * 7 * 24 * 3600 * 1000;
  return getDb()
    .prepare(
      `SELECT strftime('%Y-W%W', created_at / 1000, 'unixepoch', '+8 hours') AS week,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0)     AS promptTokens,
              COALESCE(SUM(completion_tokens),0) AS completionTokens,
              COALESCE(SUM(total_tokens),0)      AS totalTokens
       FROM ai_usage
       WHERE created_at >= ?
       GROUP BY week
       ORDER BY week ASC`,
    )
    .all(from) as any[];
}

/** 成本估算（按模型定价） */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5 / 1e6, output: 10 / 1e6 },
  'gpt-4o-mini': { input: 0.15 / 1e6, output: 0.6 / 1e6 },
  'gpt-4-turbo': { input: 10 / 1e6, output: 30 / 1e6 },
  'claude-3-5-sonnet': { input: 3 / 1e6, output: 15 / 1e6 },
  'claude-3-5-haiku': { input: 0.8 / 1e6, output: 4 / 1e6 },
  'deepseek-chat': { input: 0.14 / 1e6, output: 0.28 / 1e6 },
  'deepseek-reasoner': { input: 0.55 / 1e6, output: 2.19 / 1e6 },
};

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return promptTokens * pricing.input + completionTokens * pricing.output;
}

/** 按天聚合 + 成本估算（用于仪表盘） */
export function listAiUsageByDayWithCost(days: number): Array<{ day: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; cost: number }> {
  const from = Date.now() - days * 24 * 3600 * 1000;
  const rows = getDb()
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+8 hours') AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0)     AS promptTokens,
              COALESCE(SUM(completion_tokens),0) AS completionTokens,
              COALESCE(SUM(total_tokens),0)      AS totalTokens,
              COALESCE(SUM(CASE WHEN model='gpt-4o' THEN prompt_tokens * 0.0000025 + completion_tokens * 0.00001
                                WHEN model='gpt-4o-mini' THEN prompt_tokens * 0.00000015 + completion_tokens * 0.0000006
                                WHEN model='deepseek-chat' THEN prompt_tokens * 0.00000014 + completion_tokens * 0.00000028
                                WHEN model='deepseek-reasoner' THEN prompt_tokens * 0.00000055 + completion_tokens * 0.00000219
                                WHEN model LIKE '%claude-3-5-sonnet%' THEN prompt_tokens * 0.000003 + completion_tokens * 0.000015
                                WHEN model LIKE '%claude-3-5-haiku%' THEN prompt_tokens * 0.0000008 + completion_tokens * 0.000004
                                ELSE 0 END), 0) AS cost
       FROM ai_usage
       WHERE created_at >= ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(from) as any[];
  return rows;
}

/** 清空全部用量（管理员） */
export function clearAiUsage(): void {
  getDb().prepare('DELETE FROM ai_usage').run();
}

/** 获取指定 profile 当月 token 用量和费用（用于预算检查） */
export function getMonthlyUsage(profileId: number): { tokens: number; cost: number } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS tokens
       FROM ai_usage
       WHERE profile_id = ? AND created_at >= ? AND success = 1`,
    )
    .get(profileId, from) as { tokens: number } | undefined;
  return { tokens: row?.tokens || 0, cost: 0 };
}
