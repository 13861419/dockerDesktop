/**
 * Edge 节点注册表（1.63.0）
 *
 * Edge 节点 = 部署在远程主机上的轻量 agent（agent/agent.js，零依赖），
 * 主动反向连接面板（适合 NAT / 防火墙后无法暴露 2375 端口的场景）。
 *
 * node token 仅在创建时返回一次，库中仅存 sha256 哈希。
 */
import crypto from 'crypto';
import { getDb } from '../storage';

export interface EdgeNodeRow {
  id: string;
  name: string;
  token_hash: string;
  agent_version: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export interface EdgeNode {
  id: string;
  name: string;
  agentVersion: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
}

/** token 哈希（校验用） */
export function hashEdgeToken(token: string): string {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** 生成 edge token */
export function generateEdgeToken(): string {
  return 'edge_' + crypto.randomBytes(24).toString('hex');
}

/** 新建节点，返回明文 token（仅此一次） */
export function createEdgeNode(name: string): { node: EdgeNode; token: string } {
  const clean = String(name || '').trim();
  if (!clean) {
    const err: any = new Error('节点名称不能为空');
    err.statusCode = 400;
    throw err;
  }
  const id = 'edge-' + crypto.randomBytes(4).toString('hex');
  const token = generateEdgeToken();
  getDb()
    .prepare(
      'INSERT INTO edge_nodes (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(id, clean, hashEdgeToken(token), Date.now());
  const node = getEdgeNode(id)!;
  return { node, token };
}

/** 按 id 取节点 */
export function getEdgeNode(id: string): EdgeNode | null {
  const row = getDb().prepare('SELECT * FROM edge_nodes WHERE id = ?').get(id) as unknown as EdgeNodeRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    agentVersion: row.agent_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    online: false,
  };
}

/** 全部节点（附在线状态，online 由隧道层注入） */
export function listEdgeNodes(isOnline: (id: string) => boolean): EdgeNode[] {
  const rows = getDb().prepare('SELECT * FROM edge_nodes ORDER BY created_at ASC').all() as unknown as EdgeNodeRow[];
  return (rows || []).map((r) => ({
    id: r.id,
    name: r.name,
    agentVersion: r.agent_version,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    online: isOnline(r.id),
  }));
}

/** 更新心跳（agent 连接建立时） */
export function touchEdgeNode(id: string, agentVersion: string): void {
  getDb()
    .prepare('UPDATE edge_nodes SET last_seen_at = ?, agent_version = ? WHERE id = ?')
    .run(Date.now(), String(agentVersion || ''), id);
}

/** 删除节点 */
export function deleteEdgeNode(id: string): boolean {
  return getDb().prepare('DELETE FROM edge_nodes WHERE id = ?').run(id).changes > 0;
}

/** 按 token 哈希查节点（agent 认证用） */
export function findNodeByTokenHash(tokenHash: string): EdgeNodeRow | null {
  const row = getDb()
    .prepare('SELECT * FROM edge_nodes WHERE token_hash = ?')
    .get(tokenHash) as unknown as EdgeNodeRow | undefined;
  return row || null;
}
