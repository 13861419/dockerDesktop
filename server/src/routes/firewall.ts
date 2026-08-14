/**
 * Windows 防火墙端口放行路由（挂载路径 /api/firewall，仅 Windows 平台有效）
 *
 * 基于系统内置 `netsh advfirewall firewall` 命令管理入站端口放行规则（零第三方依赖），
 * 规则由本面板统一以前缀命名并持久化到 SQLite，便于可靠枚举与删除。
 *
 * 平台说明：本功能仅适用于 Windows（Docker Desktop 宿主）。其它平台返回不支持。
 * 权限说明：netsh 修改防火墙需管理员权限；命令失败时返回清晰错误（如权限不足）。
 */
import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { getDb } from '../storage';
import { requireAdmin } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();
const execAsync = promisify(exec);

/** 当前是否 Windows 平台 */
const IS_WINDOWS = process.platform === 'win32';

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
 * 执行一条 netsh 命令（返回 stdout），失败时抛解析后的错误
 * @param args netsh 子命令参数
 */
async function runNetSh(args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`netsh advfirewall firewall ${args}`, {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout || '';
  } catch (err: any) {
    const stderr = err?.stderr || err?.message || '';
    const msg = /requires elevation|拒绝访问|管理员|Run as administrator|0x5/i.test(stderr)
      ? '需要管理员权限操作防火墙（请以管理员身份运行面板服务）'
      : stderr.trim() || 'netssh 命令执行失败';
    throw Object.assign(new Error(msg), { statusCode: 500 });
  }
}

/**
 * GET /api/firewall/ports
 * 列出本面板管理的端口放行规则
 */
router.get(
  '/ports',
  asyncHandler(async (_req: Request, res: Response) => {
    if (!IS_WINDOWS) {
      return res.json({ supported: false, ports: [], message: '该功能仅支持 Windows 平台' });
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
 * 检测当前平台是否支持以及执行 netsh 的权限
 */
router.get(
  '/check',
  asyncHandler(async (_req: Request, res: Response) => {
    if (!IS_WINDOWS) {
      return res.json({ supported: false, writable: false, message: '非 Windows 平台' });
    }
    let writable = false;
    try {
      // 仅查询不修改，用于探测 netsh 可用性
      await execAsync('netsh advfirewall show currentprofile', { windowsHide: true, maxBuffer: 1024 * 1024 });
      writable = true;
    } catch (err: any) {
      const stderr = err?.stderr || err?.message || '';
      if (/requires elevation|拒绝访问|管理员/i.test(stderr)) {
        writable = false;
      }
    }
    res.json({ supported: true, writable });
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
    if (!IS_WINDOWS) throw Object.assign(new Error('该功能仅支持 Windows 平台'), { statusCode: 400 });

    const name = ruleNameOf(port, proto);
    // 添加到 Windows 防火墙
    await runNetSh(`add rule name="${name}" dir=in action=allow protocol=${proto.toUpperCase()} localport=${port}`);

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
    if (!IS_WINDOWS) throw Object.assign(new Error('该功能仅支持 Windows 平台'), { statusCode: 400 });

    // 从 Windows 防火墙删除规则
    await runNetSh(`delete rule name="${row.name}"`);
    d.prepare('DELETE FROM firewall_ports WHERE id = ?').run(id);
    logOperation(res.locals.username, '关闭防火墙端口', '防火墙', `${row.port}/${row.proto}`, row.name);
    res.json({ ok: true });
  }),
);

export default router;
