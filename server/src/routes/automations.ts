/**
 * 事件自动化 API 路由（挂载路径 /api/automations，1.61.0）
 *
 *  - GET    /          规则列表
 *  - POST   /          新建规则（管理员）
 *  - PUT    /:id       更新规则（管理员）
 *  - PUT    /:id/enabled 启用 / 禁用（管理员）
 *  - DELETE /:id       删除规则（管理员）
 *  - GET    /events    触发历史（最近 N 条）
 */
import { Router, Request, Response } from 'express';
import { requireAdmin, requireAuth } from '../auth';
import {
  AutomationRule,
  createAutomation,
  deleteAutomation,
  listAutomationEvents,
  listAutomations,
  setAutomationEnabled,
  updateAutomation,
} from '../automation';
import { logOperation } from '../operationLog';

const router = Router();

/** 行 → 响应体（隐藏 webhook secret） */
function serialize(rule: AutomationRule) {
  const params = { ...(rule.actionParams || {}) };
  if (typeof params.secret === 'string' && params.secret) {
    params.secret = '******';
  }
  return { ...rule, actionParams: params };
}

/**
 * GET /api/automations
 * 规则列表（登录即可查看，webhook 凭证脱敏）。
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ rules: listAutomations().map(serialize) });
  }),
);

/**
 * GET /api/automations/events
 * 触发历史。
 */
router.get(
  '/events',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ events: listAutomationEvents(Number(req.query.limit) || 100) });
  }),
);

/**
 * POST /api/automations
 * 新建规则。
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const rule = createAutomation(req.body);
    logOperation(res.locals.username, '创建自动化规则', 'automation', String(rule.id), `${rule.name} ${rule.eventType} → ${rule.action}`);
    res.status(201).json({ ok: true, rule });
  }),
);

/**
 * PUT /api/automations/:id
 * 更新规则。
 */
router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const rule = updateAutomation(Number(req.params.id), req.body);
    if (!rule) {
      res.status(404).json({ error: '规则不存在' });
      return;
    }
    logOperation(res.locals.username, '更新自动化规则', 'automation', String(rule.id), rule.name);
    res.json({ ok: true, rule });
  }),
);

/**
 * PUT /api/automations/:id/enabled
 * 启用 / 禁用。
 */
router.put(
  '/:id/enabled',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const enabled = req.body?.enabled === true;
    const rule = setAutomationEnabled(Number(req.params.id), enabled);
    if (!rule) {
      res.status(404).json({ error: '规则不存在' });
      return;
    }
    logOperation(res.locals.username, enabled ? '启用自动化规则' : '禁用自动化规则', 'automation', String(rule.id), rule.name);
    res.json({ ok: true, rule });
  }),
);

/**
 * DELETE /api/automations/:id
 * 删除规则。
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const ok = deleteAutomation(Number(req.params.id));
    if (!ok) {
      res.status(404).json({ error: '规则不存在' });
      return;
    }
    logOperation(res.locals.username, '删除自动化规则', 'automation', req.params.id, '');
    res.json({ ok: true });
  }),
);

/** asyncHandler：包装 async 路由，异常交给 Express 错误中间件 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      const status = err?.statusCode || 500;
      if (!res.headersSent) {
        res.status(status).json({ error: err?.message || '内部错误' });
      }
    });
  };
}

export default router;
