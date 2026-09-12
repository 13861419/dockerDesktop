/**
 * 容器自愈 API 路由（挂载路径 /api/selfheal）
 *
 *  - GET    /rules          列出全部自愈规则（登录即可）
 *  - POST   /rules          新增规则（selfheal.manage 权限）
 *  - PUT    /rules/:id      更新规则（selfheal.manage 权限）
 *  - DELETE /rules/:id      删除规则（selfheal.manage 权限）
 *  - POST   /run            立即执行一轮巡检（selfheal.manage 权限）
 */
import { Router, Request, Response } from 'express';
import {
  listSelfHealRules,
  createSelfHealRule,
  updateSelfHealRule,
  deleteSelfHealRule,
  runSelfHealCheck,
  listSelfHealEvents,
} from '../selfheal';
import { requirePermission } from '../rbac';
import { logOperation } from '../operationLog';

const router = Router();

/** 统一兜底错误处理 */
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
 * GET /api/selfheal/rules
 * 列出全部自愈规则
 */
router.get(
  '/rules',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ rules: listSelfHealRules() });
  }),
);

/**
 * POST /api/selfheal/rules
 * 新增自愈规则
 */
router.post(
  '/rules',
  requirePermission('selfheal.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const rule = createSelfHealRule(req.body || {});
    logOperation(res.locals.username, '新增自愈规则', '自愈', rule.containerName, `${rule.watchType} → ${rule.action}`);
    res.status(201).json({ ok: true, rule });
  }),
);

/**
 * PUT /api/selfheal/rules/:id
 * 更新自愈规则
 */
router.put(
  '/rules/:id',
  requirePermission('selfheal.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的规则 id' });
    const rule = updateSelfHealRule(id, req.body || {});
    logOperation(res.locals.username, '更新自愈规则', '自愈', rule.containerName, `${rule.watchType} → ${rule.action}`);
    res.json({ ok: true, rule });
  }),
);

/**
 * DELETE /api/selfheal/rules/:id
 * 删除自愈规则
 */
router.delete(
  '/rules/:id',
  requirePermission('selfheal.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的规则 id' });
    deleteSelfHealRule(id);
    logOperation(res.locals.username, '删除自愈规则', '自愈', String(id), '');
    res.json({ ok: true });
  }),
);

/**
 * 解析 /events 与 /events/export 共用的筛选参数
 */
function parseEventFilters(req: Request): {
  container?: string;
  success?: boolean | null;
  since?: number | null;
} {
  const container = req.query.container ? String(req.query.container).trim() : '';
  const successRaw = req.query.success;
  let success: boolean | null = null;
  if (successRaw === 'true' || successRaw === '1') success = true;
  else if (successRaw === 'false' || successRaw === '0') success = false;
  const since = Number(req.query.since) > 0 ? Number(req.query.since) : null;
  return { container: container || undefined, success, since };
}

/** CSV 字段转义（防公式注入：前缀 + - = @ 的值前加单引号） */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'` + s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * GET /api/selfheal/events
 * 查询最近的自愈执行记录（默认 50 条，最新在前；1.42.0 支持 container/success/since 筛选）
 */
router.get(
  '/events',
  asyncHandler(async (req: Request, res: Response) => {
    const events = listSelfHealEvents(Number(req.query.limit) || 50, parseEventFilters(req));
    res.json({ events });
  }),
);

/**
 * GET /api/selfheal/events/export
 * 导出自愈执行记录 CSV（1.42.0），与 /events 支持相同筛选参数
 */
router.get(
  '/events/export',
  asyncHandler(async (req: Request, res: Response) => {
    const events = listSelfHealEvents(500, parseEventFilters(req));
    const header = ['ID', '容器', '监控类型', '动作', '结果', '详情', '时间'];
    const lines = [header.join(',')];
    for (const e of events) {
      lines.push(
        [
          e.id,
          e.containerName,
          e.watchType,
          e.action,
          e.success ? '成功' : '失败',
          e.detail || '',
          new Date(e.createdAt).toISOString(),
        ]
          .map(csvCell)
          .join(','),
      );
    }
    // BOM 便于 Excel 正确识别 UTF-8
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="selfheal-events-${Date.now()}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  }),
);

/**
 * POST /api/selfheal/run
 * 立即执行一轮自愈巡检
 */
router.post(
  '/run',
  requirePermission('selfheal.manage'),
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await runSelfHealCheck();
    logOperation(res.locals.username, '手动自愈巡检', '自愈', '', `触发 ${result.triggered} 条`);
    res.json({ ok: true, ...result });
  }),
);

export default router;
