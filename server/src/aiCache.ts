/**
 * AI 语义缓存模块（ai_cache 表）
 *
 * 基于 prompt hash 的缓存，减少重复 API 调用。
 * 缓存命中条件：相同的 prompt 文本 + 未过期 + 同模型。
 * 默认 TTL 24 小时，可通过环境变量调整。
 */
import crypto from 'crypto';
import { getDb } from './storage';

/** 缓存有效期（毫秒），默认 24 小时 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** 最大缓存条目数（超出后自动清理最旧的） */
const MAX_CACHE_ENTRIES = 1000;

/**
 * 生成 prompt 的归一化 hash
 * 归一化：小写 + 去除多余空白
 */
function hashPrompt(prompt: string, model: string): string {
  const normalized = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${model}::${normalized}`).digest('hex');
}

/**
 * 查询缓存：命中返回 response，未命中返回 null
 */
export function getCache(prompt: string, model: string): string | null {
  const hash = hashPrompt(prompt, model);
  const now = Date.now();
  const row = getDb()
    .prepare('SELECT response FROM ai_cache WHERE prompt_hash = ? AND model = ? AND expires_at > ?')
    .get(hash, model, now) as { response: string } | undefined;
  if (row) {
    // 命中：更新 hit_count
    getDb().prepare('UPDATE ai_cache SET hit_count = hit_count + 1 WHERE prompt_hash = ? AND model = ?').run(hash, model);
    return row.response;
  }
  return null;
}

/**
 * 写入缓存（幂等：已存在则更新）
 */
export function setCache(prompt: string, model: string, response: string): void {
  if (!response || !prompt) return;
  const hash = hashPrompt(prompt, model);
  const now = Date.now();
  const expiresAt = now + DEFAULT_TTL_MS;
  const d = getDb();
  d.prepare(
    `INSERT INTO ai_cache (prompt_hash, prompt, response, model, hit_count, created_at, expires_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(prompt_hash) DO UPDATE SET response = ?, model = ?, expires_at = ?, hit_count = hit_count + 1`,
  ).run(hash, prompt, response, model, now, expiresAt, response, model, expiresAt);
  // 清理过期条目 + 超出上限的旧条目
  d.prepare('DELETE FROM ai_cache WHERE expires_at < ?').run(now);
  const count = (d.prepare('SELECT COUNT(*) AS c FROM ai_cache').get() as { c: number }).c;
  if (count > MAX_CACHE_ENTRIES) {
    d.prepare('DELETE FROM ai_cache WHERE id IN (SELECT id FROM ai_cache ORDER BY hit_count ASC, created_at ASC LIMIT ?)').run(count - MAX_CACHE_ENTRIES);
  }
}

/**
 * 清空全部缓存
 */
export function clearCache(): void {
  getDb().prepare('DELETE FROM ai_cache').run();
}

/**
 * 获取缓存统计
 */
export function getCacheStats(): { total: number; totalHits: number } {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(hit_count), 0) AS totalHits FROM ai_cache').get() as { total: number; totalHits: number };
  return { total: row.total || 0, totalHits: row.totalHits || 0 };
}
