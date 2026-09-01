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
  getApprovalStats,
  listAllApprovals,
  renderApprovalsCsv,
} from '../approvals';
import { requireOperator } from '../auth';
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
 * GET /api/approvals/stats?days=30
 * 审批统计：近 N 天按状态汇总、按动作类型与提交人分布、执行质量
 */
router.get(
  '/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const days = Number(req.query.days) || 30;
    res.json(getApprovalStats(days));
  }),
);

/**
 * GET /api/approvals/export?status=
 * 导出审批记录为 CSV（管理员导出全部，其他用户仅导出自己提交的）
 */
router.get(
  '/export',
  asyncHandler(async (req: Request, res: Response) => {
    const role = res.locals.user?.role;
    const isAdmin = role === 'admin';
    const status = String(req.query.status || '') || undefined;
    const rows = listAllApprovals(isAdmin ? undefined : res.locals.username, status);
    const csv = renderApprovalsCsv(rows);
    logOperation(res.locals.username, '导出审批记录', '审批', '', `共 ${rows.length} 条`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="approvals-${Date.now()}.csv"`);
    res.send(csv);
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
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const r = await decideApproval(Number(req.params.id), 'approved', res.locals.username, undefined, res.locals.user?.role);
    logOperation(res.locals.username, '批准审批', 'approval', String(req.params.id), r.executed ? '已执行' : r.advanced ? '多级审批推进一级' : `执行失败：${r.error}`);
    res.json({ ok: true, ...r });
  }),
);

/**
 * POST /api/approvals/:id/reject
 * 拒绝（运维可拒中间级；末级拒绝需管理员，decideApproval 内校验）。body: { reason } —— 理由必填，随审批留痕并通知提交人
 */
router.post(
  '/:id/reject',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '拒绝时必须填写理由' });
    await decideApproval(Number(req.params.id), 'rejected', res.locals.username, reason, res.locals.user?.role);
    logOperation(res.locals.username, '拒绝审批', 'approval', String(req.params.id), reason);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/approvals/batch
 * 批量批准/拒绝（仅管理员）。body: { ids: number[], decision: 'approved'|'rejected', reason? }
 * 逐条顺序处理（避免并发执行多个 Docker 操作），单条失败不影响其余条目。
 */
router.post(
  '/batch',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const rawIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = rawIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) return res.status(400).json({ error: '缺少审批 ID 列表' });
    if (ids.length > 50) return res.status(400).json({ error: '单批最多处理 50 条审批' });
    const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
    const reason = String(req.body?.reason || '').trim();
    if (decision === 'rejected' && !reason) return res.status(400).json({ error: '拒绝时必须填写理由' });

    const results: Array<{ id: number; ok: boolean; executed?: boolean; error?: string }> = [];
    for (const id of ids) {
      try {
        const r = await decideApproval(id, decision, res.locals.username, reason || undefined, res.locals.user?.role);
        logOperation(
          res.locals.username,
          decision === 'approved' ? '批准审批' : '拒绝审批',
          'approval',
          String(id),
          r.executed ? '已执行' : r.error ? `执行失败：${r.error}` : reason,
        );
        results.push({ id, ok: true, executed: r.executed, error: r.error });
      } catch (err: any) {
        results.push({ id, ok: false, error: err?.message || '处理失败' });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    res.json({ ok, fail: results.length - ok, results });
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
