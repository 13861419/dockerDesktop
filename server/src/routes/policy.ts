/**
 * 安全基线策略 API 路由（挂载路径 /api/policy）
 *
 * - GET  /scan  扫描存量容器并返回违规清单
 * - POST /fix   在线修复单条可修复违规（mem-limit / cpu-limit / restart-policy）；
 *               审批流开启时非管理员自动转审批单（container.fix）
 */
import { Router, Request, Response } from 'express';
import { scanPolicy, applyPolicyFix, isFixableRule, POLICY_FIX_DEFAULTS } from '../policy';
import { requireAdmin, requireOperator } from '../auth';
import { maybeGate } from '../approvals';
import { logOperation } from '../operationLog';

const router = Router();

/**
 * 统一兜底错误处理（与其它路由一致的 asyncHandler 模式）
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
 * GET /api/policy/scan
 * 执行安全基线扫描，返回违规报告（仅管理员）
 */
router.get(
  '/scan',
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const report = await scanPolicy();
    res.json(report);
  }),
);

/**
 * POST /api/policy/fix
 * 在线修复单条违规。body: { containerId, ruleId, params? }
 * - 规则须为可自动修复（fixable）；params 缺省用各规则默认值
 * - 审批流开启且非管理员：转审批单（202），批准后自动执行
 */
router.post(
  '/fix',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const containerId = String(req.body?.containerId || '').trim();
    const ruleId = String(req.body?.ruleId || '').trim();
    if (!containerId) return res.status(400).json({ error: '缺少容器 ID' });
    if (!ruleId) return res.status(400).json({ error: '缺少规则 ID' });
    if (!isFixableRule(ruleId)) {
      return res.status(400).json({ error: `规则 ${ruleId} 不支持自动修复（需重建容器）` });
    }
    const params = { ...POLICY_FIX_DEFAULTS[ruleId], ...(req.body?.params || {}) };

    // 审批门禁：开启且非管理员 → 转审批单（批准后由执行器执行同一修复）
    if (maybeGate(req, res, 'container.fix', containerId, { containerId, ruleId, params })) return;

    const result = await applyPolicyFix(containerId, ruleId, params);
    logOperation(res.locals.username, '修复安全基线违规', 'container', containerId, `${ruleId}: ${result.message}`);
    res.json(result);
  }),
);

export default router;
