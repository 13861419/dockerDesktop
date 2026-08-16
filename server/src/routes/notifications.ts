/**
 * 告警通知 API 路由（挂载路径 /api/notifications）
 *
 * 提供告警中心所需的接口：
 *  - 通知渠道管理：列表 / 新增 / 更新 / 删除 / 测试推送
 *  - 告警规则：查询 / 更新
 *  - 告警记录：查询 / 清空
 *  - 立即检测：手动触发一次资源告警检测
 *
 * 写操作（新增/更新/删除/测试/清空/改规则）均需管理员权限；
 * 读操作（列表/查询）登录即可。
 */
import { Router, Request, Response } from 'express';
import {
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  sendAlert,
  type ChannelType,
} from '../notify';
import {
  getAlertRules,
  updateAlertRule,
  getAlertRecords,
  clearAlertRecords,
  runAlertCheckNow,
  buildSnapshotText,
} from '../alerting';
import { requireAdmin } from '../auth';
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

/** 渠道类型白名单 */
const CHANNEL_TYPES: ChannelType[] = ['webhook', 'email', 'dingtalk', 'feishu'];

/**
 * 校验并归一化渠道输入
 * @param body 请求体
 */
function parseChannelInput(body: any): { name: string; type: ChannelType; config: Record<string, any> } {
  const type = String(body?.type || '');
  if (!CHANNEL_TYPES.includes(type as ChannelType)) {
    throw Object.assign(new Error('不支持的渠道类型'), { statusCode: 400 });
  }
  const config = body?.config && typeof body.config === 'object' ? body.config : {};
  return { name: String(body?.name || ''), type: type as ChannelType, config };
}

/**
 * GET /api/notifications/channels
 * 列出所有通知渠道
 */
router.get(
  '/channels',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ channels: listChannels() });
  }),
);

/**
 * POST /api/notifications/channels
 * 新增通知渠道
 */
router.post(
  '/channels',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const input = parseChannelInput(req.body);
    const { id } = createChannel(input);
    logOperation(res.locals.username, '新增通知渠道', '通知', input.name, input.type);
    res.status(201).json({ ok: true, id });
  }),
);

/**
 * PUT /api/notifications/channels/:id
 * 更新通知渠道
 */
router.put(
  '/channels/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const body = req.body || {};
    const patch: { name?: string; enabled?: boolean; config?: Record<string, any> } = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.config && typeof body.config === 'object') patch.config = body.config;
    updateChannel(id, patch);
    logOperation(res.locals.username, '更新通知渠道', '通知', String(body.name || id), '');
    res.json({ ok: true });
  }),
);

/**
 * DELETE /api/notifications/channels/:id
 * 删除通知渠道
 */
router.delete(
  '/channels/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    deleteChannel(id);
    logOperation(res.locals.username, '删除通知渠道', '通知', id, '');
    res.json({ ok: true });
  }),
);

/**
 * POST /api/notifications/channels/:id/test
 * 测试推送一条消息到指定渠道
 */
router.post(
  '/channels/:id/test',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const snapshot = buildSnapshotText();
    const text = snapshot
      ? `${snapshot}\n（这是一条测试推送，用于验证渠道配置是否可用）`
      : 'Docker 管理面板 测试消息（监控未就绪，仅验证通道连通性）';
    const result = await sendAlert(id, text);
    logOperation(res.locals.username, '测试推送告警', '通知', id, result.ok ? '成功' : `失败: ${result.detail}`);
    if (!result.ok) {
      return res.status(502).json({ error: `推送失败: ${result.detail}`, detail: result.detail });
    }
    res.json({ ok: true, detail: result.detail });
  }),
);

/**
 * GET /api/notifications/rules
 * 获取告警规则
 */
router.get(
  '/rules',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ rules: getAlertRules() });
  }),
);

/**
 * PUT /api/notifications/rules/:type
 * 更新告警规则
 */
router.put(
  '/rules/:type',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const type = String(req.params.type);
    const body = req.body || {};
    updateAlertRule(type, {
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
      warnThreshold: body.warnThreshold !== undefined ? Number(body.warnThreshold) : undefined,
      dangerThreshold: body.dangerThreshold !== undefined ? Number(body.dangerThreshold) : undefined,
    });
    logOperation(res.locals.username, '更新告警规则', '通知', type, '');
    res.json({ ok: true });
  }),
);

/**
 * GET /api/notifications/records?limit=50
 * 获取告警记录
 */
router.get(
  '/records',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 50;
    res.json({ records: getAlertRecords(limit) });
  }),
);

/**
 * DELETE /api/notifications/records
 * 清空全部告警记录
 */
router.delete(
  '/records',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    clearAlertRecords();
    logOperation(res.locals.username, '清空告警记录', '通知', '', '');
    res.json({ ok: true });
  }),
);

/**
 * POST /api/notifications/check
 * 立即触发一次告警检测
 */
router.post(
  '/check',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await runAlertCheckNow();
    res.json({ ok: true, ...result });
  }),
);

export default router;
