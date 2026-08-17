/**
 * Docker 事件流 REST API 路由
 *
 * 提供两类事件查询：
 *  1. 实时内存事件（默认，来自内存环形缓冲，服务重启丢失）
 *  2. 持久化历史事件（history=1，来自 SQLite docker_events 表，服务重启保留）
 * 另提供历史导出（CSV）与清空历史接口。
 */
import { Router, Request, Response } from 'express';
import {
  getRecentEvents,
  DockerEvent,
  queryPersistedEvents,
  persistedEventTypes,
  persistedEventActions,
  clearPersistedEvents,
  countPersistedEventsByType,
  countPersistedEventsByAction,
  countEventsTimeline,
} from '../docker/events';
import { requireAuth, requireAdmin } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();

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

/** 支持过滤的事件类型集合（用于校验入参） */
const VALID_TYPES = new Set(['container', 'image', 'volume', 'network', 'plugin', 'daemon']);

/**
 * GET /api/events
 * 获取事件。默认返回内存最近事件；history=1 时从持久化历史分页查询。
 * @query type    事件类型（container/image/volume/network 等）
 * @query action  动作（start/stop/destroy 等）
 * @query limit   数量（默认 100，最大 500）
 * @query offset  分页偏移（history 模式）
 * @query history 传 1 表示查询持久化历史
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const type = req.query.type ? String(req.query.type) : undefined;
    const action = req.query.action ? String(req.query.action) : undefined;
    const limit = Number(req.query.limit) || 100;
    const isHistory = String(req.query.history) === '1';

    let events: Array<DockerEvent | Omit<DockerEvent, 'raw'>>;
    let types: string[];
    let actions: string[];

    if (isHistory) {
      const offset = Number(req.query.offset) || 0;
      events = queryPersistedEvents({ type, action, limit: Math.min(limit, 500), offset });
      types = persistedEventTypes();
      actions = persistedEventActions();
    } else {
      events = getRecentEvents(Math.min(limit, 200));
      if (type) events = events.filter((e) => e.type === type);
      if (action) events = events.filter((e) => e.action === action);
      // 从可用类型中提取出现过的类型，供前端筛选下拉
      types = Array.from(new Set<string>(getRecentEvents(200).map((e) => e.type))).sort();
      // 常见动作集合
      actions = Array.from(new Set<string>(getRecentEvents(200).map((e) => e.action))).sort();
    }

    res.json({ events, types, actions, history: isHistory });
  }),
);

/**
 * GET /api/events/history/export
 * 导出持久化事件历史为 CSV（可选按类型/动作过滤）
 * @query type    事件类型过滤
 * @query action  动作过滤
 */
router.get(
  '/history/export',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const type = req.query.type ? String(req.query.type) : undefined;
    const action = req.query.action ? String(req.query.action) : undefined;
    const events = queryPersistedEvents({ type, action, limit: 10000, offset: 0 });
    const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['time,type,action,entity_id,scope'];
    for (const e of events) {
      lines.push([e.time, e.type, e.action, e.id, e.scope].map(esc).join(','));
    }
    const csv = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="docker-events.csv"');
    // 添加 UTF-8 BOM，便于 Excel 正确识别中文
    res.send('\uFEFF' + csv);
  }),
);

/**
 * DELETE /api/events/history
 * 清空持久化事件历史（仅管理员）
 */
router.delete(
  '/history',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    clearPersistedEvents();
    logOperation(res.locals.username, '清空事件历史', '事件', '-');
    res.json({ ok: true });
  }),
);

/**
 * GET /api/events/stats
 * 获取持久化事件统计（按类型/动作分组 + 时间线聚合），供前端统计图表展示。
 * @query bucket  聚合粒度：hour=1小时(3600000ms)、day=1天(86400000ms)，默认 hour
 * @query from    起始毫秒时间戳（可选，默认 24 小时前）
 * @query to      结束毫秒时间戳（可选，默认当前时间）
 * @query type    事件类型过滤（可选）
 * @query action  动作过滤（可选）
 * @returns { byType: {type,count}[], byAction: {action,count}[], timeline: {bucket,count}[] }
 */
router.get(
  '/stats',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    // bucket 粒度映射
    const bucketMs = String(req.query.bucket) === 'day' ? DAY : HOUR;
    const now = Date.now();
    // 时间范围：未传 from/to 时默认近 24 小时
    const from = Number(req.query.from) || now - 24 * HOUR;
    const to = Number(req.query.to) || now;
    // 可选过滤
    const type = req.query.type ? String(req.query.type) : undefined;
    const action = req.query.action ? String(req.query.action) : undefined;

    const byType = countPersistedEventsByType(from, to, type, action);
    const byAction = countPersistedEventsByAction(from, to, type, action);
    const timeline = countEventsTimeline(bucketMs, from, to, type, action);

    res.json({ byType, byAction, timeline });
  }),
);

export { VALID_TYPES };
export default router;
