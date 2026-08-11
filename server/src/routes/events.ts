/**
 * Docker 事件流 REST API 路由
 *
 * 提供最近事件的查询接口（Docker 事件不持久化，来自内存环形缓冲）。
 */
import { Router, Request, Response } from 'express';
import { getRecentEvents, DockerEvent } from '../docker/events';

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
 * 获取最近事件，可选按类型 / 动作过滤
 * @query type  事件类型（container/image/volume/network 等）
 * @query action 动作（start/stop/destroy 等）
 * @query limit 数量（默认 100，最大 200）
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const type = req.query.type ? String(req.query.type) : undefined;
    const action = req.query.action ? String(req.query.action) : undefined;
    const limit = Number(req.query.limit) || 100;

    let events: DockerEvent[] = getRecentEvents(limit);
    if (type) {
      events = events.filter((e) => e.type === type);
    }
    if (action) {
      events = events.filter((e) => e.action === action);
    }
    // 从可用类型中提取出现过的类型，供前端筛选下拉
    const allTypes = Array.from(
      new Set<string>(getRecentEvents(200).map((e) => e.type)),
    ).sort();
    // 常见动作集合
    const allActions = Array.from(
      new Set<string>(getRecentEvents(200).map((e) => e.action)),
    ).sort();

    res.json({ events, types: allTypes, actions: allActions });
  }),
);

export { VALID_TYPES };
export default router;
