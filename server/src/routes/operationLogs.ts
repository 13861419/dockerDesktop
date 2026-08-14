/**
 * 操作审计日志 API 路由
 *
 * - GET /api/operation-logs?page=&pageSize=&username=&targetType=&startTime=&endTime=&success=：分页查询（最新在前）
 * - GET /api/operation-logs/export?username=&targetType=&startTime=&endTime=&success=：按过滤条件导出 CSV
 * - DELETE /api/operation-logs：清空全部操作日志
 */
import { Router } from 'express';
import { listOperationLogs, clearOperationLogs, exportOperationLogsCsv, logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/** 从 query 中解析可选数值参数（毫秒时间戳） */
function numOrUndefined(v: any): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 从 query 中解析可选布尔参数（true/1/false/0） */
function boolOrUndefined(v: any): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'true' || v === '1';
}

/**
 * GET /api/operation-logs/export
 * 按过滤条件导出操作日志为 CSV（不受分页限制）
 */
router.get('/export', (req: any, res: any) => {
  try {
    const username = req.query.username ? String(req.query.username) : undefined;
    const targetType = req.query.targetType ? String(req.query.targetType) : undefined;
    const startTime = numOrUndefined(req.query.startTime);
    const endTime = numOrUndefined(req.query.endTime);
    const success = boolOrUndefined(req.query.success);
    const csv = exportOperationLogsCsv({ username, targetType, startTime, endTime, success });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="operation-logs-${Date.now()}.csv"`,
    );
    res.send(csv);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '导出操作日志失败' });
  }
});

/**
 * GET /api/operation-logs
 * 分页查询操作日志
 */
router.get('/', (req: any, res: any) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const username = req.query.username ? String(req.query.username) : undefined;
    const targetType = req.query.targetType ? String(req.query.targetType) : undefined;
    const startTime = numOrUndefined(req.query.startTime);
    const endTime = numOrUndefined(req.query.endTime);
    const success = boolOrUndefined(req.query.success);
    const result = listOperationLogs({ page, pageSize, username, targetType, startTime, endTime, success });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '查询操作日志失败' });
  }
});

/**
 * DELETE /api/operation-logs
 * 清空全部操作日志
 */
router.delete('/', requireAdmin, (_req: any, res: any) => {
  try {
    clearOperationLogs();
    logOperation(res.locals.username, '清空操作日志', 'operationLog');
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '清空操作日志失败' });
  }
});

export default router;
