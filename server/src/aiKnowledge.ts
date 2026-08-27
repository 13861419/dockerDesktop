/**
 * AI 运维知识库模块（ai_knowledge 表）
 *
 * 双模式检索：
 *  - 优先：Ollama embedding 向量 + 余弦相似度（需配置本地 Ollama）
 *  - 回退：TF-IDF 关键词匹配（零依赖）
 */
import { getDb } from './storage';
import { ollamaEmbeddings } from './ollamaClient';

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

/** Ollama embedding 模型名（轻量通用模型） */
const EMBEDDING_MODEL = 'nomic-embed-text';

/** 将 Float32Array 编码为 Buffer 存入 SQLite */
function embeddingToBuffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** 将 SQLite BLOB 解码为 Float32Array */
function bufferToEmbedding(buf: Buffer | null): number[] | null {
  if (!buf || buf.length === 0) return null;
  const vec: number[] = [];
  for (let i = 0; i + 3 < buf.length; i += 4) vec.push(buf.readFloatLE(i));
  return vec;
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

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
 * 尝试计算 Ollama embedding，失败返回 null（静默回退 TF-IDF）
 */
async function tryEmbedding(text: string): Promise<number[] | null> {
  try {
    const r = await ollamaEmbeddings(EMBEDDING_MODEL, text);
    return r.ok && r.embedding ? r.embedding : null;
  } catch {
    return null;
  }
}

/**
 * 新增知识条目（异步计算 embedding）
 */
export async function createKnowledge(title: string, category: string, content: string, tags: string[] = []): Promise<KnowledgeEntry> {
  const now = Date.now();
  const cat = VALID_CATEGORIES.includes(category) ? category : 'general';
  const d = getDb();
  // 异步计算 embedding（不阻塞主流程）
  const embedding = await tryEmbedding(`${title}\n${content}`);
  const embBuf = embedding ? embeddingToBuffer(embedding) : null;
  const info = d
    .prepare('INSERT INTO ai_knowledge (title, category, content, tags, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(title, cat, content, JSON.stringify(tags), embBuf, now, now);
  return mapRow(d.prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(info.lastInsertRowid));
}

/**
 * 更新知识条目（重新计算 embedding）
 */
export async function updateKnowledge(id: number, fields: { title?: string; category?: string; content?: string; tags?: string[] }): Promise<KnowledgeEntry | null> {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(id) as any;
  if (!existing) return null;
  const title = fields.title ?? existing.title;
  const category = fields.category ? (VALID_CATEGORIES.includes(fields.category) ? fields.category : existing.category) : existing.category;
  const content = fields.content ?? existing.content;
  const tags = fields.tags ? JSON.stringify(fields.tags) : existing.tags;
  const now = Date.now();
  // 内容变更时重新计算 embedding
  const needReEmbed = fields.content || fields.title;
  let embBuf: Buffer | null = null;
  if (needReEmbed) {
    const embedding = await tryEmbedding(`${title}\n${content}`);
    embBuf = embedding ? embeddingToBuffer(embedding) : null;
  }
  if (embBuf) {
    d.prepare('UPDATE ai_knowledge SET title = ?, category = ?, content = ?, tags = ?, embedding = ?, updated_at = ? WHERE id = ?').run(title, category, content, tags, embBuf, now, id);
  } else {
    d.prepare('UPDATE ai_knowledge SET title = ?, category = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?').run(title, category, content, tags, now, id);
  }
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
 * 搜索知识（优先 embedding 余弦相似度，回退 TF-IDF）
 */
export async function searchKnowledge(query: string, limit: number = 5): Promise<KnowledgeEntry[]> {
  const d = getDb();
  const allRows = d.prepare('SELECT * FROM ai_knowledge').all() as any[];
  if (!allRows.length) return [];

  // 1. 尝试 embedding 余弦相似度搜索
  const queryEmbedding = await tryEmbedding(query);
  if (queryEmbedding) {
    const scored = allRows.map((r) => {
      const emb = bufferToEmbedding(r.embedding);
      const score = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
      return { row: r, score };
    });
    const results = scored.filter((s) => s.score > 0.1).sort((a, b) => b.score - a.score).slice(0, limit);
    if (results.length > 0) return results.map((s) => mapRow(s.row));
    // embedding 搜索无结果时回退 TF-IDF
  }

  // 2. TF-IDF 回退
  return tfidfSearch(query, limit, allRows);
}

/**
 * TF-IDF 搜索（同步，作为 embedding 的回退）
 */
function tfidfSearch(query: string, limit: number, allRows: any[]): KnowledgeEntry[] {
  const tokenize = (text: string): string[] =>
    text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').split(/\s+/).filter(Boolean);

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const totalDocs = allRows.length;
  const docFreq = new Map<string, number>();
  const rowTokens = allRows.map((r) => {
    const tokens = tokenize(`${r.title} ${r.content} ${r.tags}`);
    const freq = new Map<string, number>();
    for (const t of tokens) { freq.set(t, (freq.get(t) || 0) + 1); }
    for (const t of new Set(tokens)) { docFreq.set(t, (docFreq.get(t) || 0) + 1); }
    return { row: r, freq };
  });

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

  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => mapRow(s.row));
}
