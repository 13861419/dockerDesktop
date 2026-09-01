/**
 * 实时监控 API 路由
 *
 * 提供 Docker 引擎（主机/WSL2 VM）的实时资源使用与历史曲线数据，
 * 供首页仪表盘展示。
 */
import { Router, Request, Response } from 'express';
import { getCurrentMonitor, getMonitorHistory, getMetricsRange, type MetricsRange } from '../docker/monitor';

const router = Router();

/**
 * 统一兜底错误处理
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

/**
 * GET /api/monitor/now
 * 获取最近一次实时监控点
 */
router.get(
  '/now',
  asyncHandler(async (_req: Request, res: Response) => {
    const point = getCurrentMonitor();
    if (!point) {
      return res.status(503).json({ error: '监控数据尚未采集完成，请稍后重试' });
    }
    res.json(point);
  }),
);

/**
 * GET /api/monitor/history?minutes=10
 * 获取指定分钟内的历史监控点
 */
router.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const minutes = Number(req.query.minutes) || 10;
    const points = getMonitorHistory(minutes);
    res.json({ points });
  }),
);

/** 合法的时间范围取值，用于校验 query 参数 */
const VALID_RANGES: MetricsRange[] = ['10m', '1h', '24h', '7d', '30d', '90d'];

/**
 * GET /api/monitor/history/range?range=1h
 * 获取指定时间范围的历史监控趋势（10m|1h|24h|7d，默认 1h）
 *
 * 10m 走内存缓冲；1h/24h/7d 走 host_metrics 持久化数据并降采样。
 */
router.get(
  '/history/range',
  asyncHandler(async (req: Request, res: Response) => {
    const raw = String(req.query.range || '1h');
    const range: MetricsRange = (VALID_RANGES as string[]).includes(raw) ? (raw as MetricsRange) : '1h';
    const points = getMetricsRange(range);
    res.json({ points });
  }),
);

export default router;
