/**
 * 操作审计日志 API 路由
 *
 * - GET /api/operation-logs?page=&pageSize=&username=&targetType=&startTime=&endTime=&success=：分页查询（最新在前）
 * - GET /api/operation-logs/export?format=&username=&targetType=&startTime=&endTime=&success=：按过滤条件导出 CSV / JSON
 * - GET /api/operation-logs/stats?username=&targetType=&startTime=&endTime=&success=：按过滤条件统计
 * - DELETE /api/operation-logs：清空全部操作日志
 */
import { Router } from 'express';
import {
  listOperationLogs,
  clearOperationLogs,
  exportOperationLogsCsv,
  exportOperationLogsJson,
  summarizeOperationLogs,
  summarizeOperationLogsByUser,
  summarizeOperationLogsTrend,
  exportStatsCsv,
  logOperation,
} from '../operationLog';
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
 * 按过滤条件导出操作日志（不受分页限制）
 * 支持 format 参数：默认 csv；format=json 时导出 JSON 数组
 */
router.get('/export', requireAdmin, (req: any, res: any) => {
  try {
    const username = req.query.username ? String(req.query.username) : undefined;
    const targetType = req.query.targetType ? String(req.query.targetType) : undefined;
    const startTime = numOrUndefined(req.query.startTime);
    const endTime = numOrUndefined(req.query.endTime);
    const success = boolOrUndefined(req.query.success);
    const format = req.query.format ? String(req.query.format).toLowerCase() : 'csv';

    const filter = { username, targetType, startTime, endTime, success };

    // JSON 导出：返回 application/json，文件名以 .json 结尾
    if (format === 'json') {
      const json = exportOperationLogsJson(filter);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="operation-logs-${Date.now()}.json"`,
      );
      res.send(json);
      return;
    }

    // 默认 CSV 导出
    const csv = exportOperationLogsCsv(filter);
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
 * GET /api/operation-logs/stats
 * 按过滤条件统计操作日志（目标类型 / 结果 / 操作动作分布），供前端统计卡片展示
 */
router.get('/stats', requireAdmin, (req: any, res: any) => {
  try {
    const username = req.query.username ? String(req.query.username) : undefined;
    const targetType = req.query.targetType ? String(req.query.targetType) : undefined;
    const startTime = numOrUndefined(req.query.startTime);
    const endTime = numOrUndefined(req.query.endTime);
    const success = boolOrUndefined(req.query.success);
    const stats = summarizeOperationLogs({ username, targetType, startTime, endTime, success });
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '统计操作日志失败' });
  }
});

/**
 * GET /api/operation-logs/stats/by-user?from=&to=
 * 按操作者分组统计（审计报表"操作者排行"）
 * 与现有 /stats 兼容，返回按操作者（总数/成功/失败）降序数组
 */
router.get('/stats/by-user', requireAdmin, (req: any, res: any) => {
  try {
    const username = req.query.username ? String(req.query.username) : undefined;
    const targetType = req.query.targetType ? String(req.query.targetType) : undefined;
    const startTime = numOrUndefined(req.query.startTime);
    const endTime = numOrUndefined(req.query.endTime);
    const success = boolOrUndefined(req.query.success);
    const rows = summarizeOperationLogsByUser({ username, targetType, startTime, endTime, success });
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '统计操作者失败' });
  }
});

/**
 * GET /api/operation-logs/stats/trend?from=&to=
 * 按天聚合操作日志（审计报表"按天趋势"），返回按日期升序的 (day,count,success,fail) 数组
 */
router.get('/stats/trend', requireAdmin, (req: any, res: any) => {
  try {
    const username = req.query.username ? String(req.query.username) : undefined;
    const targetType = req.query.targetType ? String(req.query.targetType) : undefined;
    const startTime = numOrUndefined(req.query.startTime);
    const endTime = numOrUndefined(req.query.endTime);
    const success = boolOrUndefined(req.query.success);
    const rows = summarizeOperationLogsTrend({ username, targetType, startTime, endTime, success });
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '统计操作趋势失败' });
  }
});

/**
 * GET /api/operation-logs/export/stats?groupBy=user|day&from=&to=
 * 导出审计统计报表为 CSV（维度：user 按操作者 / day 按天）
 */
router.get('/export/stats', requireAdmin, (req: any, res: any) => {
  try {
    const username = req.query.username ? String(req.query.username) : undefined;
    const targetType = req.query.targetType ? String(req.query.targetType) : undefined;
    const startTime = numOrUndefined(req.query.startTime);
    const endTime = numOrUndefined(req.query.endTime);
    const success = boolOrUndefined(req.query.success);
    const groupBy = req.query.groupBy === 'day' ? 'day' : 'user';
    const csv = exportStatsCsv(groupBy, { username, targetType, startTime, endTime, success });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="operation-stats-${groupBy}-${Date.now()}.csv"`,
    );
    res.send(csv);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '导出统计报表失败' });
  }
});

/**
 * GET /api/operation-logs
 * 分页查询操作日志
 */
router.get('/', requireAdmin, (req: any, res: any) => {
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
