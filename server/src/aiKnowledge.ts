/**
 * AI 运维知识库模块（ai_knowledge 表）
 *
 * 支持运维知识的增删改查，提供 TF-IDF 全文检索用于 RAG 增强回答。
 * 零第三方依赖：基于 SQLite LIKE + 简易 TF-IDF 算法。
 */
import { getDb } from './storage';

export interface KnowledgeEntry {
  id: number;
  title: string;
  category: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

const VALID_CATEGORIES = ['general', 'docker', 'compose', 'network', 'security', 'performance', 'troubleshoot', 'monitoring'];

function mapRow(r: any): KnowledgeEntry {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    content: r.content,
    tags: JSON.parse(r.tags || '[]'),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 新增知识条目
 */
export function createKnowledge(title: string, category: string, content: string, tags: string[] = []): KnowledgeEntry {
  const now = Date.now();
  const cat = VALID_CATEGORIES.includes(category) ? category : 'general';
  const d = getDb();
  const info = d
    .prepare('INSERT INTO ai_knowledge (title, category, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, cat, content, JSON.stringify(tags), now, now);
  return mapRow(d.prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(info.lastInsertRowid));
}

/**
 * 更新知识条目
 */
export function updateKnowledge(id: number, fields: { title?: string; category?: string; content?: string; tags?: string[] }): KnowledgeEntry | null {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(id) as any;
  if (!existing) return null;
  const title = fields.title ?? existing.title;
  const category = fields.category ? (VALID_CATEGORIES.includes(fields.category) ? fields.category : existing.category) : existing.category;
  const content = fields.content ?? existing.content;
  const tags = fields.tags ? JSON.stringify(fields.tags) : existing.tags;
  const now = Date.now();
  d.prepare('UPDATE ai_knowledge SET title = ?, category = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?').run(title, category, content, tags, now, id);
  return mapRow(d.prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(id));
}

/**
 * 删除知识条目
 */
export function deleteKnowledge(id: number): boolean {
  const info = getDb().prepare('DELETE FROM ai_knowledge WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * 获取单条知识
 */
export function getKnowledge(id: number): KnowledgeEntry | null {
  const row = getDb().prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

/**
 * 列表查询（支持分类过滤 + 关键词搜索）
 */
export function listKnowledge(opts: { category?: string; keyword?: string; limit?: number; offset?: number } = {}): { items: KnowledgeEntry[]; total: number } {
  const d = getDb();
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.category) { conditions.push('category = ?'); params.push(opts.category); }
  if (opts.keyword) { conditions.push('(title LIKE ? OR content LIKE ?)'); params.push(`%${opts.keyword}%`, `%${opts.keyword}%`); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = (d.prepare(`SELECT COUNT(*) as c FROM ai_knowledge${where}`).get(...params) as any).c;
  const limit = opts.limit || 20;
  const offset = opts.offset || 0;
  const rows = d.prepare(`SELECT * FROM ai_knowledge${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
  return { items: rows.map(mapRow), total };
}

/**
 * 获取分类统计
 */
export function getKnowledgeStats(): Array<{ category: string; count: number }> {
  const rows = getDb().prepare('SELECT category, COUNT(*) as count FROM ai_knowledge GROUP BY category ORDER BY count DESC').all() as any[];
  return rows.map((r) => ({ category: r.category, count: r.count }));
}

/**
 * TF-IDF 搜索（用于 RAG 检索）
 *
 * 简易实现：基于词频统计 + IDF 加权，返回最相关的知识条目。
 * 不依赖外部库，适合中小规模知识库（< 1000 条）。
 */
export function searchKnowledge(query: string, limit: number = 5): KnowledgeEntry[] {
  const d = getDb();
  const allRows = d.prepare('SELECT * FROM ai_knowledge').all() as any[];
  if (!allRows.length) return [];

  // 分词（简易：按空格 + 标点分割，转小写）
  const tokenize = (text: string): string[] =>
    text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').split(/\s+/).filter(Boolean);

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  // 计算 IDF
  const totalDocs = allRows.length;
  const docFreq = new Map<string, number>();
  const rowTokens = allRows.map((r) => {
    const tokens = tokenize(`${r.title} ${r.content} ${r.tags}`);
    const freq = new Map<string, number>();
    for (const t of tokens) { freq.set(t, (freq.get(t) || 0) + 1); }
    const uniqueTokens = new Set(tokens);
    for (const t of uniqueTokens) { docFreq.set(t, (docFreq.get(t) || 0) + 1); }
    return { row: r, freq, tokens };
  });

  // 计算 TF-IDF 得分
  const scored = rowTokens.map(({ row, freq }) => {
    let score = 0;
    for (const qt of queryTokens) {
      const tf = (freq.get(qt) || 0) / (freq.size || 1);
      const df = docFreq.get(qt) || 0;
      const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
      score += tf * idf;
    }
    return { row, score };
  });

  // 返回得分最高的 N 条
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => mapRow(s.row));
}
