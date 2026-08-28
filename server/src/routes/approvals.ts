/**
 * 高危操作审批流 API 路由（挂载路径 /api/approvals）
 *
 * - GET    /                审批列表（管理员看全部，其他用户仅看自己提交的）
 * - POST   /                手动提交审批请求（供前端主动发起）
 * - POST   /:id/approve     批准并执行（仅管理员）
 * - POST   /:id/reject      拒绝（仅管理员）
 * - DELETE /:id             撤销自己的待审批请求（管理员可撤销任意）
 */
import { Router, Request, Response } from 'express';
import {
  GATE_ACTIONS,
  listApprovalsView,
  submitApproval,
  decideApproval,
  cancelApproval,
  hasExecutor,
} from '../approvals';
import { requireAdmin } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();

/**
 * 统一兜底错误处理
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message = err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * GET /api/approvals?status=pending
 * 审批列表：管理员可见全部，其他用户仅见自己提交的
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const role = res.locals.user?.role;
    const isAdmin = role === 'admin';
    const rows = await listApprovalsView(isAdmin ? undefined : res.locals.username, String(req.query.status || '') || undefined);
    res.json({ items: rows, isAdmin });
  }),
);

/**
 * POST /api/approvals
 * 手动提交审批请求。body: { actionType, target, payload?, reason? }
 */
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { actionType, target, payload, reason } = req.body || {};
    if (!actionType || !GATE_ACTIONS[actionType]) {
      return res.status(400).json({ error: '未知的审批动作类型' });
    }
    if (!target && GATE_ACTIONS[actionType].targetType !== 'network') {
      return res.status(400).json({ error: '缺少审批目标' });
    }
    if (!hasExecutor(actionType)) {
      return res.status(400).json({ error: '该动作暂无执行器' });
    }
    const { id, reused } = submitApproval({
      username: res.locals.username,
      actionType,
      target: String(target || 'all'),
      payload: payload || {},
      reason: reason || GATE_ACTIONS[actionType].label,
    });
    logOperation(res.locals.username, `提交审批：${GATE_ACTIONS[actionType].label}`, GATE_ACTIONS[actionType].targetType, String(target || ''), reused ? '（复用已有待审批）' : '');
    res.status(201).json({ id, reused, approvalPending: true });
  }),
);

/**
 * POST /api/approvals/:id/approve
 * 批准并立即执行（仅管理员）
 */
router.post(
  '/:id/approve',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const r = await decideApproval(Number(req.params.id), 'approved', res.locals.username);
    logOperation(res.locals.username, '批准审批', 'approval', String(req.params.id), r.executed ? '已执行' : `执行失败：${r.error}`);
    res.json({ ok: true, ...r });
  }),
);

/**
 * POST /api/approvals/:id/reject
 * 拒绝（仅管理员）。body: { reason? }
 */
router.post(
  '/:id/reject',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    await decideApproval(Number(req.params.id), 'rejected', res.locals.username, req.body?.reason);
    logOperation(res.locals.username, '拒绝审批', 'approval', String(req.params.id), req.body?.reason || '');
    res.json({ ok: true });
  }),
);

/**
 * DELETE /api/approvals/:id
 * 撤销待审批请求（提交人本人或管理员）
 */
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const isAdmin = res.locals.user?.role === 'admin';
    cancelApproval(Number(req.params.id), res.locals.username, isAdmin);
    logOperation(res.locals.username, '撤销审批', 'approval', String(req.params.id), '');
    res.json({ ok: true });
  }),
);

export default router;
