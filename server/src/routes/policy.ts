/**
 * 安全基线策略 API 路由（挂载路径 /api/policy）
 *
 * 一期只读：扫描存量容器并返回违规清单，供前端策略报告页展示。
 * 二期规划：approvals 审批流（危险操作需 admin 审批后执行）。
 */
import { Router, Request, Response } from 'express';
import { scanPolicy } from '../policy';
import { requireAdmin } from '../auth';

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

export default router;
