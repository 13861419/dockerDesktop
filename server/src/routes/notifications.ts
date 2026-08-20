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
  listAllAlertRecords,
  renderAlertRecordsCsv,
  archiveAlertRecords,
  runAlertCheckNow,
  buildSnapshotText,
  getContainerAlertRules,
  createContainerAlertRule,
  updateContainerAlertRule,
  deleteContainerAlertRule,
} from '../alerting';
import { requireAdmin } from '../auth';
import { logOperation } from '../operationLog';
import { getCurrentMonitor } from '../docker/monitor';

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
 * 从请求 query 中提取告警记录过滤条件
 * @param req 请求
 * @returns 过滤条件（type / level / pushStatus）
 */
function parseRecordFilter(req: Request): { type?: string; level?: string; pushStatus?: string } {
  const filter: { type?: string; level?: string; pushStatus?: string } = {};
  const type = String(req.query.type || '').trim();
  const level = String(req.query.level || '').trim();
  const pushStatus = String(req.query.pushStatus || '').trim();
  if (type) filter.type = type;
  if (level) filter.level = level;
  if (pushStatus) filter.pushStatus = pushStatus;
  return filter;
}

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
 * 获取告警规则（附带各资源的实时使用率，供前端"当前使用率"列展示）
 */
router.get(
  '/rules',
  asyncHandler(async (_req: Request, res: Response) => {
    const rules = getAlertRules();
    // 读取实时监控点，为 cpu / mem / disk 规则补充当前使用率
    const point = getCurrentMonitor();
    const curGpu = point && point.gpu && point.gpu.length > 0 ? Math.max(...point.gpu.map((g) => g.utilization || 0)) : null;
    const curNet = point && point.netRate ? Math.max(point.netRate.rxMbps, point.netRate.txMbps) : null;
    const current = point
      ? { cpu: point.cpu.percent, mem: point.mem.percent, disk: point.disk.percent, gpu: curGpu, net: curNet }
      : { cpu: null, mem: null, disk: null, gpu: null, net: null };
    res.json({
      rules: rules.map((r) => ({
        ...r,
        currentPercent: r.type in current ? (current as any)[r.type] : null,
      })),
      current,
    });
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
      silentStart: body.silentStart !== undefined ? body.silentStart : undefined,
      silentEnd: body.silentEnd !== undefined ? body.silentEnd : undefined,
      workdaysOnly: body.workdaysOnly !== undefined ? Boolean(body.workdaysOnly) : undefined,
      workStart: body.workStart !== undefined ? body.workStart : undefined,
      workEnd: body.workEnd !== undefined ? body.workEnd : undefined,
    });
    logOperation(res.locals.username, '更新告警规则', '通知', type, '');
    res.json({ ok: true });
  }),
);

/**
 * GET /api/notifications/records?page=1&pageSize=20&type=&level=&pushStatus=
 * 获取告警记录（分页 + 过滤）
 */
router.get(
  '/records',
  asyncHandler(async (req: Request, res: Response) => {
    const page = req.query.page !== undefined ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize !== undefined ? Number(req.query.pageSize) : 20;
    const type = String(req.query.type || '').trim() || undefined;
    const level = String(req.query.level || '').trim() || undefined;
    const pushStatus = String(req.query.pushStatus || '').trim() || undefined;
    const result = getAlertRecords({ page, pageSize, type, level, pushStatus });
    res.json(result);
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
 * GET /api/notifications/records/export?type=&level=&pushStatus=
 * 按当前过滤条件导出全部告警记录为 CSV 文件（下载）
 * 读操作，登录即可。
 */
router.get(
  '/records/export',
  asyncHandler(async (req: Request, res: Response) => {
    const filter = parseRecordFilter(req);
    const rows = listAllAlertRecords(filter);
    const csv = renderAlertRecordsCsv(rows);
    const filename = `alert-records-${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    logOperation(res.locals.username, '导出告警记录', '通知', '', `共 ${rows.length} 条`);
    res.send(csv);
  }),
);

/**
 * POST /api/notifications/records/archive?type=&level=&pushStatus=
 * 将当前告警记录归档为服务端 CSV 文件（data/alert-archive/），随后清空记录表
 * 用于在 800 条保留上限覆盖前持久化历史告警，避免数据永久丢失。
 */
router.post(
  '/records/archive',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const filter = parseRecordFilter(req);
    const result = archiveAlertRecords(filter);
    logOperation(res.locals.username, '归档告警记录', '通知', '', `归档 ${result.count} 条 → ${result.file}`);
    res.json({ ok: true, file: result.file, count: result.count });
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

/**
 * GET /api/notifications/container-rules
 * 获取容器级告警规则（含容器显示名）
 */
router.get(
  '/container-rules',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ rules: await getContainerAlertRules() });
  }),
);

/**
 * POST /api/notifications/container-rules
 * 新增容器级告警规则
 */
router.post(
  '/container-rules',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const rule = createContainerAlertRule(req.body || {});
    logOperation(res.locals.username, '新增容器告警规则', '通知', String(rule.containerName || rule.containerId), rule.watchType);
    res.status(201).json({ ok: true, rule });
  }),
);

/**
 * PUT /api/notifications/container-rules/:id
 * 更新容器级告警规则
 */
router.put(
  '/container-rules/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的规则 id' });
    const rule = updateContainerAlertRule(id, req.body || {});
    logOperation(res.locals.username, '更新容器告警规则', '通知', String(rule.containerName || rule.containerId), rule.watchType);
    res.json({ ok: true, rule });
  }),
);

/**
 * DELETE /api/notifications/container-rules/:id
 * 删除容器级告警规则
 */
router.delete(
  '/container-rules/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的规则 id' });
    deleteContainerAlertRule(id);
    logOperation(res.locals.username, '删除容器告警规则', '通知', String(id), '');
    res.json({ ok: true });
  }),
);

export default router;
