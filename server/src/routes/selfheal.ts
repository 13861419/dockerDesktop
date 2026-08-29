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
