/**
 * Docker 引擎管理 API 路由（挂载路径 /api/engines）
 *
 * 提供多 Docker 引擎的 CRUD 与切换能力。引擎配置持久化于 SQLite（docker_engines 表）。
 * 引擎变更（新增/修改/删除/切换）后统一调用 client.resetDockerCache() 使客户端缓存失效，
 * 并在切换/删除当前引擎时调用 events.restartEventMonitor() 让事件流对准新引擎。
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../storage';
import { resetDockerCache, testEngineEndpoint } from '../docker/client';
import { restartEventMonitor } from '../docker/events';
import { logOperation } from '../operationLog';

const router = Router();

/** 引擎行结构 */
interface EngineRow {
  id: string;
  name: string;
  endpoint: string;
  is_current: number;
  created_at: number;
  updated_at: number;
}

/**
 * 统一兜底错误处理
 * @param fn 异步处理函数
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 归一化端点输入：统一为 npipe:// / tcp:// / unix:// 形式
 * @param endpoint 原始输入
 * @returns 规整后的端点
 */
function normalizeEndpoint(endpoint: string): string {
  const e = String(endpoint || '').trim();
  if (!e) throw Object.assign(new Error('端点不能为空'), { statusCode: 400 });
  if (
    e.startsWith('npipe://') ||
    e.startsWith('unix://') ||
    e.startsWith('tcp://')
  ) {
    return e;
  }
  // 兼容老写法：直接给 socket 路径或无前缀
  if (/^[a-zA-Z]:[\\/]/.test(e) || e.startsWith('/')) {
    return 'npipe://' + e.replace(/\\/g, '/');
  }
  return e;
}

/**
 * 校验名称合法性
 * @param name 引擎名称
 */
function assertName(name: string): string {
  const n = String(name || '').trim();
  if (!n) throw Object.assign(new Error('引擎名称不能为空'), { statusCode: 400 });
  return n;
}

/**
 * GET /api/engines
 * 列出全部引擎，并标注当前引擎
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const d = getDb();
    const rows = d.prepare('SELECT id, name, endpoint, is_current, created_at, updated_at FROM docker_engines ORDER BY created_at ASC').all() as unknown as EngineRow[];
    res.json({
      engines: rows.map((r) => ({ id: r.id, name: r.name, endpoint: r.endpoint, isCurrent: !!r.is_current })),
    });
  }),
);

/**
 * POST /api/engines
 * 新增引擎（校验端点连通性）；若为第一个引擎则自动设为当前
 * @body name     引擎名称
 * @body endpoint 引擎端点
 */
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const name = assertName(req.body?.name);
    const endpoint = normalizeEndpoint(req.body?.endpoint);

    const d = getDb();
    const count = (d.prepare('SELECT count(*) AS c FROM docker_engines').get() as { c: number }).c;

    const ok = await testEngineEndpoint(endpoint);
    if (!ok) {
      return res.status(400).json({ error: '无法连接该 Docker 端点，请检查地址与协议' });
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const isCurrent = count === 0 ? 1 : 0;
    d.prepare(
      'INSERT INTO docker_engines (id, name, endpoint, is_current, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, name, endpoint, isCurrent, now, now);

    if (isCurrent) resetDockerCache();
    logOperation(res.locals.username, '新增Docker引擎', '引擎', name, isCurrent ? '(设为当前)' : undefined);
    res.json({ ok: true, id, isCurrent: !!isCurrent });
  }),
);

/**
 * PUT /api/engines/:id
 * 更新引擎（名称/端点；端点变更时验证连通性）
 * @body name     引擎名称（可选）
 * @body endpoint 引擎端点（可选，变更时校验）
 */
router.put(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT id, name, endpoint, is_current FROM docker_engines WHERE id = ?').get(id) as EngineRow | undefined;
    if (!row) return res.status(404).json({ error: '引擎不存在' });

    const name = req.body?.name !== undefined ? assertName(req.body.name) : row.name;
    let endpoint = row.endpoint;
    if (req.body?.endpoint !== undefined && String(req.body.endpoint).trim() !== row.endpoint) {
      endpoint = normalizeEndpoint(req.body.endpoint);
      const ok = await testEngineEndpoint(endpoint);
      if (!ok) return res.status(400).json({ error: '无法连接该 Docker 端点，请检查地址与协议' });
    }

    d.prepare('UPDATE docker_engines SET name = ?, endpoint = ?, updated_at = ? WHERE id = ?').run(
      name,
      endpoint,
      Date.now(),
      id,
    );

    // 若更新的是当前引擎，需清缓存使新端点生效
    if (row.is_current) {
      resetDockerCache();
      restartEventMonitor();
    }
    logOperation(res.locals.username, '更新Docker引擎', '引擎', name);
    res.json({ ok: true });
  }),
);

/**
 * DELETE /api/engines/:id
 * 删除引擎；若为当前引擎则拒绝（需先切换），避免留下无引擎状态
 */
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT id, name, is_current FROM docker_engines WHERE id = ?').get(id) as EngineRow | undefined;
    if (!row) return res.status(404).json({ error: '引擎不存在' });
    if (row.is_current) {
      return res.status(400).json({ error: '不能删除当前使用的引擎，请先切换到其他引擎' });
    }
    d.prepare('DELETE FROM docker_engines WHERE id = ?').run(id);
    logOperation(res.locals.username, '删除Docker引擎', '引擎', row.name);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/engines/:id/switch
 * 将指定引擎设为当前引擎
 */
router.post(
  '/:id/switch',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT id, name FROM docker_engines WHERE id = ?').get(id) as EngineRow | undefined;
    if (!row) return res.status(404).json({ error: '引擎不存在' });

    // 验证引擎可连
    const full = d.prepare('SELECT endpoint FROM docker_engines WHERE id = ?').get(id) as { endpoint: string };
    const ok = await testEngineEndpoint(full.endpoint);
    if (!ok) return res.status(400).json({ error: '该引擎当前不可达，无法切换' });

    const now = Date.now();
    d.prepare('UPDATE docker_engines SET is_current = 0, updated_at = ? WHERE is_current = 1').run(now);
    d.prepare('UPDATE docker_engines SET is_current = 1, updated_at = ? WHERE id = ?').run(now, id);

    // 引擎变化：清客户端缓存 + 重启事件流
    resetDockerCache();
    restartEventMonitor();

    logOperation(res.locals.username, '切换Docker引擎', '引擎', row.name);
    res.json({ ok: true });
  }),
);

export default router;
