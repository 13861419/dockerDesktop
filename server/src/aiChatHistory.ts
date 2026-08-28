/**
 * AI 对话历史模块（ai_chat_sessions 表）
 *
 * 每个会话一条记录，消息以 JSON 文本存于 messages 列。按用户名隔离，
 * 每个用户只能读写自己的会话。零依赖，通过 getDb() 访问 SQLite。
 */
import { getDb } from './storage';

/** 会话简表（列表用） */
export interface AiChatSessionLite {
  id: number;
  title: string;
  messageCount: number;
  tool: string;
  target: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 会话完整记录（详情用） */
export interface AiChatSessionFull extends AiChatSessionLite {
  messages: ChatHistoryMessage[];
}

/** 历史消息结构（与前端 ChatMsg 一致） */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  feedback?: 'good' | 'bad';
}

interface SessionRow {
  id: number;
  title: string;
  messages: string;
  tool: string;
  target: string;
  username: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

function parseMessages(raw: string): ChatHistoryMessage[] {
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({
          role: m.role,
          content: m.content,
          error: m.error ? true : undefined,
          feedback: m.feedback === 'good' || m.feedback === 'bad' ? m.feedback : undefined,
        }));
    }
  } catch {
    // 忽略坏数据
  }
  return [];
}

function toLite(row: SessionRow, count: number): AiChatSessionLite {
  return {
    id: row.id,
    title: row.title,
    messageCount: count,
    tool: row.tool,
    target: row.target,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 列出某用户的会话（置顶优先，再按更新时间倒序） */
export function listChatSessions(username: string, limit = 100): AiChatSessionLite[] {
  const rows = (getDb()
    .prepare(
      `SELECT id, title, messages, tool, target, username, pinned, created_at, updated_at
       FROM ai_chat_sessions WHERE username = ?
       ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
    )
    .all(username, limit) as unknown as SessionRow[]);
  return rows.map((r) => toLite(r, parseMessages(r.messages).length));
}

/** 获取单个会话（含消息）；不属于自己的返回 null */
export function getChatSession(id: number, username: string): AiChatSessionFull | null {
  const row = getDb()
    .prepare(
      `SELECT id, title, messages, tool, target, username, pinned, created_at, updated_at
       FROM ai_chat_sessions WHERE id = ?`,
    )
    .get(id) as unknown as SessionRow | undefined;
  if (!row || row.username !== username) return null;
  const msgs = parseMessages(row.messages);
  return { ...toLite(row, msgs.length), messages: msgs };
}

/** 创建会话，返回新会话完整记录 */
export function createChatSession(username: string, opts?: { title?: string; tool?: string; target?: string }): AiChatSessionFull {
  const now = Date.now();
  const title = opts?.title?.trim() || '新对话';
  const tool = opts?.tool || '';
  const target = opts?.target || '';
  const res = getDb()
    .prepare(
      `INSERT INTO ai_chat_sessions (title, messages, tool, target, username, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(title, '[]', tool, target, username, now, now);
  const id = Number(res.lastInsertRowid);
  return { id, title, messageCount: 0, tool, target, pinned: false, createdAt: now, updatedAt: now, messages: [] };
}

/** 切换会话收藏/置顶状态 */
export function togglePinChatSession(id: number, username: string): boolean | null {
  const d = getDb();
  const row = d
    .prepare('SELECT pinned, username FROM ai_chat_sessions WHERE id = ?')
    .get(id) as { pinned: number; username: string } | undefined;
  if (!row) return null;
  if (row.username !== username) return null;
  const newVal = row.pinned === 1 ? 0 : 1;
  d.prepare('UPDATE ai_chat_sessions SET pinned = ?, updated_at = ? WHERE id = ? AND username = ?').run(newVal, Date.now(), id, username);
  return newVal === 1;
}

/** 覆盖会话标题 */
export function updateChatSessionTitle(id: number, username: string, title: string): boolean {
  const res = getDb()
    .prepare('UPDATE ai_chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND username = ?')
    .run(title.trim() || '新对话', Date.now(), id, username);
  return res.changes > 0;
}

/** 覆盖会话消息（用于整个对话保存） */
export function updateChatSessionMessages(id: number, username: string, messages: ChatHistoryMessage[]): boolean {
  const res = getDb()
    .prepare('UPDATE ai_chat_sessions SET messages = ?, updated_at = ? WHERE id = ? AND username = ?')
    .run(JSON.stringify(messages), Date.now(), id, username);
  return res.changes > 0;
}

/** 更新会话绑定的工具与目标（如 tool='container' + target=容器名）；tool 为 null 表示解绑 */
export function updateChatSessionBinding(id: number, username: string, tool: string | null, target: string | null): boolean {
  const res = getDb()
    .prepare('UPDATE ai_chat_sessions SET tool = ?, target = ?, updated_at = ? WHERE id = ? AND username = ?')
    .run(tool, target, Date.now(), id, username);
  return res.changes > 0;
}

/** 更新单条消息的反馈（good/bad） */
export function updateMessageFeedback(id: number, username: string, messageIndex: number, feedback: 'good' | 'bad'): boolean {
  const session = getChatSession(id, username);
  if (!session || messageIndex < 0 || messageIndex >= session.messages.length) return false;
  const msg = session.messages[messageIndex];
  if (msg.role !== 'assistant') return false;
  msg.feedback = feedback;
  return updateChatSessionMessages(id, username, session.messages);
}

/** 删除会话；返回是否删除成功 */
export function deleteChatSession(id: number, username: string): boolean {
  const res = getDb().prepare('DELETE FROM ai_chat_sessions WHERE id = ? AND username = ?').run(id, username);
  return res.changes > 0;
}

/** 批量删除会话（仅删除属于自己的）；返回删除数量 */
export function deleteChatSessions(ids: number[], username: string): number {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const res = getDb()
    .prepare(`DELETE FROM ai_chat_sessions WHERE username = ? AND id IN (${placeholders})`)
    .run(username, ...ids);
  return Number(res.changes);
}

/** 清空某用户的全部会话；返回删除数量 */
export function clearAllChatSessions(username: string): number {
  const res = getDb().prepare('DELETE FROM ai_chat_sessions WHERE username = ?').run(username);
  return Number(res.changes);
}

/** 搜索会话（按标题或消息内容关键词） */
export function searchChatSessions(username: string, keyword: string, limit = 20): AiChatSessionLite[] {
  if (!keyword.trim()) return [];
  const kw = `%${keyword}%`;
  const rows = getDb()
    .prepare(
      `SELECT id, title, messages, tool, target, username, pinned, created_at, updated_at
       FROM ai_chat_sessions
       WHERE username = ? AND (title LIKE ? OR messages LIKE ?)
       ORDER BY pinned DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(username, kw, kw, limit) as unknown as SessionRow[];
  return rows.map((r) => toLite(r, parseMessages(r.messages).length));
}
