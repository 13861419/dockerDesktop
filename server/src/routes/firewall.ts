/**
 * 防火墙端口放行路由（挂载路径 /api/firewall）
 *
 * 通过 platform/firewall.ts 适配器自动选择系统防火墙工具：
 * - Windows：netsh advfirewall
 * - Linux：firewalld → ufw → iptables
 *
 * 规则由本面板统一以前缀命名并持久化到 SQLite，便于可靠枚举与删除。
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../storage';
import { requireAdmin } from '../auth';
import { logOperation } from '../operationLog';
import { getFirewallAdapter } from '../platform/firewall';

const router = Router();

/** 面板管理的防火墙规则名前缀 */
const RULE_PREFIX = 'DM-Port-';

/** 端口合法范围 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** 路由行结构 */
interface FirewallPortRow {
  id: string;
  port: number;
  proto: string;
  name: string;
  remark: string | null;
  created_at: number;
}

/** 统一兜底错误处理 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      res.status(status).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/**
 * 生成面板命名的防火墙规则名
 * @param port 端口号
 * @param proto 协议
 * @returns 规则名，形如 DM-Port-8080-TCP
 */
function ruleNameOf(port: number, proto: string): string {
  return `${RULE_PREFIX}${port}-${proto.toUpperCase()}`;
}

/**
 * 校验端口号与协议
 * @param port 端口
 * @param proto 协议
 * @throws 非法时抛 400
 */
function validatePortProto(port: number, proto: string): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw Object.assign(new Error('端口号需为 1-65535 的整数'), { statusCode: 400 });
  }
  const p = String(proto || 'tcp').toLowerCase();
  if (p !== 'tcp' && p !== 'udp') {
    throw Object.assign(new Error('协议仅支持 tcp 或 udp'), { statusCode: 400 });
  }
}

/**
 * 执行防火墙命令（返回 stdout），失败时抛解析后的错误
 */

/**
 * GET /api/firewall/ports
 * 列出本面板管理的端口放行规则
 */
router.get(
  '/ports',
  asyncHandler(async (_req: Request, res: Response) => {
    const adapter = await getFirewallAdapter();
    if (!adapter) {
      return res.json({ supported: false, ports: [], message: '当前平台无可用防火墙工具' });
    }
    const rows = getDb()
      .prepare('SELECT id, port, proto, name, remark, created_at FROM firewall_ports ORDER BY port ASC')
      .all() as unknown as FirewallPortRow[];
    res.json({
      supported: true,
      ports: rows.map((r) => ({
        id: r.id,
        port: r.port,
        proto: r.proto,
        name: r.name,
        remark: r.remark || '',
        createdAt: r.created_at,
      })),
    });
  }),
);

/**
 * GET /api/firewall/check
 * 检测当前平台防火墙工具是否可用以及是否有写权限
 */
router.get(
  '/check',
  asyncHandler(async (_req: Request, res: Response) => {
    const adapter = await getFirewallAdapter();
    if (!adapter) {
      return res.json({ supported: false, writable: false, message: '当前平台无可用防火墙工具' });
    }
    const result = await adapter.check();
    res.json(result);
  }),
);

/**
 * POST /api/firewall/ports
 * 新增一条入站端口放行规则
 * @body port   端口号
 * @body proto  协议（tcp/udp）
 * @body remark 备注（可选）
 */
router.post(
  '/ports',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const port = Number(body.port);
    const proto = String(body.proto || 'tcp').toLowerCase();
    validatePortProto(port, proto);
    const remark = String(body.remark || '').trim();
    const d = getDb();
    const dup = d.prepare('SELECT id FROM firewall_ports WHERE port = ? AND proto = ?').get(port, proto);
    if (dup) throw Object.assign(new Error(`端口 ${port}/${proto} 已存在放行规则`), { statusCode: 400 });

    const adapter = await getFirewallAdapter();
    if (!adapter) throw Object.assign(new Error('当前平台无可用防火墙工具'), { statusCode: 400 });

    const name = ruleNameOf(port, proto);
    await adapter.addRule(port, proto);

    const id = crypto.randomUUID();
    d.prepare(
      'INSERT INTO firewall_ports (id, port, proto, name, remark, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, port, proto, name, remark || null, Date.now());
    logOperation(res.locals.username, '开放防火墙端口', '防火墙', `${port}/${proto}`, name);
    res.status(201).json({ ok: true, id });
  }),
);

/**
 * DELETE /api/firewall/ports/:id
 * 删除指定端口放行规则
 * @param id 规则记录 id
 */
router.delete(
  '/ports/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT name, port, proto FROM firewall_ports WHERE id = ?').get(id) as
      | { name: string; port: number; proto: string }
      | undefined;
    if (!row) throw Object.assign(new Error('规则不存在'), { statusCode: 404 });

    const adapter = await getFirewallAdapter();
    if (!adapter) throw Object.assign(new Error('当前平台无可用防火墙工具'), { statusCode: 400 });

    await adapter.deleteRule(row.port, row.proto);
    d.prepare('DELETE FROM firewall_ports WHERE id = ?').run(id);
    logOperation(res.locals.username, '关闭防火墙端口', '防火墙', `${row.port}/${row.proto}`, row.name);
    res.json({ ok: true });
  }),
);

export default router;
