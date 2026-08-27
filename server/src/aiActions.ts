/**
 * AI Action 审批模块（ai_actions 表）
 *
 * 管理 AI 建议的运维操作：待审批 → 已批准/已拒绝。
 * 支持的操作类型：restart_container, stop_container, start_container,
 *   remove_container, remove_image, system_prune
 */
import { getDb } from './storage';

export interface AiAction {
  id: number;
  username: string;
  actionType: string;
  params: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  aiMessage: string;
  result: string;
  createdAt: number;
  resolvedAt: number | null;
}

/** 支持的操作类型 → 中文描述 */
export const ACTION_TYPE_LABELS: Record<string, string> = {
  restart_container: '重启容器',
  stop_container: '停止容器',
  start_container: '启动容器',
  remove_container: '删除容器',
  remove_image: '删除镜像',
  system_prune: '系统清理',
  restart_network: '重启网络',
  prune_volumes: '清理数据卷',
  exec_command: '容器执行命令',
};

function mapRow(r: any): AiAction {
  return {
    id: r.id,
    username: r.username,
    actionType: r.action_type,
    params: JSON.parse(r.params || '{}'),
    status: r.status,
    aiMessage: r.ai_message,
    result: r.result,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/**
 * 创建待审批操作
 */
export function createAction(username: string, actionType: string, params: Record<string, unknown>, aiMessage: string): AiAction {
  const now = Date.now();
  const d = getDb();
  const info = d
    .prepare('INSERT INTO ai_actions (username, action_type, params, status, ai_message, result, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(username, actionType, JSON.stringify(params), 'pending', aiMessage, '', now, null);
  return mapRow(d.prepare('SELECT * FROM ai_actions WHERE id = ?').get(info.lastInsertRowid));
}

/**
 * 查询待审批操作列表
 */
export function listPendingActions(username?: string): AiAction[] {
  const d = getDb();
  let rows;
  if (username) {
    rows = d.prepare('SELECT * FROM ai_actions WHERE status = ? AND username = ? ORDER BY created_at DESC').all('pending', username);
  } else {
    rows = d.prepare('SELECT * FROM ai_actions WHERE status = ? ORDER BY created_at DESC').all('pending');
  }
  return (rows as any[]).map(mapRow);
}

/**
 * 查询指定操作详情
 */
export function getAction(id: number): AiAction | null {
  const row = getDb().prepare('SELECT * FROM ai_actions WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

/**
 * 批准操作
 */
export function approveAction(id: number): AiAction | null {
  const d = getDb();
  const now = Date.now();
  d.prepare('UPDATE ai_actions SET status = ?, resolved_at = ? WHERE id = ? AND status = ?').run('approved', now, id, 'pending');
  const row = d.prepare('SELECT * FROM ai_actions WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

/**
 * 拒绝操作
 */
export function rejectAction(id: number): AiAction | null {
  const d = getDb();
  const now = Date.now();
  d.prepare('UPDATE ai_actions SET status = ?, resolved_at = ? WHERE id = ? AND status = ?').run('rejected', now, id, 'pending');
  const row = d.prepare('SELECT * FROM ai_actions WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

/**
 * 标记执行结果
 */
export function markExecuted(id: number, result: string, success: boolean): void {
  const d = getDb();
  const now = Date.now();
  d.prepare('UPDATE ai_actions SET status = ?, result = ?, resolved_at = ? WHERE id = ?').run(success ? 'executed' : 'failed', result, now, id);
}

/**
 * 清理已处理的操作（超过指定天数）
 */
export function cleanupActions(olderThanDays: number = 30): void {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  getDb().prepare("DELETE FROM ai_actions WHERE status != 'pending' AND resolved_at < ?").run(cutoff);
}

/**
 * 获取操作统计
 */
export function getActionStats(): { pending: number; approved: number; rejected: number; executed: number; failed: number } {
  const d = getDb();
  const row = d.prepare(`
    SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN status='executed' THEN 1 ELSE 0 END) AS executed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
    FROM ai_actions
  `).get() as any;
  return {
    pending: row?.pending || 0,
    approved: row?.approved || 0,
    rejected: row?.rejected || 0,
    executed: row?.executed || 0,
    failed: row?.failed || 0,
  };
}
