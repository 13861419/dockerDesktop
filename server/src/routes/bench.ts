/**
 * Docker Bench 安全基线 API 路由（挂载路径 /api/bench）
 *
 * - POST /run      立即执行一次扫描并持久化（管理员）
 * - GET  /latest   最近一次扫描完整报告
 * - GET  /history  扫描历史（仅摘要，默认 20 条）
 * - GET  /:id      按记录 ID 取完整报告
 */
import { Router, Request, Response } from 'express';
import { runSecurityBench, type BenchReport } from '../bench';
import { getDb } from '../storage';
import { requireAdmin } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      res.status(status).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/** 保存报告并返回记录 ID */
function saveReport(report: BenchReport): number {
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO bench_runs (started_at, duration_ms, pass, warn, fail, info, skip, results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      report.startedAt,
      report.durationMs,
      report.summary.pass,
      report.summary.warn,
      report.summary.fail,
      report.summary.info,
      report.summary.skip,
      JSON.stringify({ checks: report.checks, escapeRisk: report.escapeRisk || null }),
    );
  return Number(r.lastInsertRowid);
}

/** 行 → 报告映射 */
function rowToReport(row: {
  id: number;
  started_at: number;
  duration_ms: number;
  pass: number;
  warn: number;
  fail: number;
  info: number;
  skip: number;
  results_json: string;
}): BenchReport & { id: number } {
  let parsed: { checks?: BenchReport['checks']; escapeRisk?: BenchReport['escapeRisk'] } = {};
  try {
    parsed = JSON.parse(row.results_json || '[]');
  } catch {
    parsed = {};
  }
  // 兼容 1.33.0：results_json 直接存 checks 数组
  const checks = Array.isArray(parsed) ? (parsed as unknown as BenchReport['checks']) : parsed.checks || [];
  return {
    id: row.id,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    summary: { pass: row.pass, warn: row.warn, fail: row.fail, info: row.info, skip: row.skip },
    checks: checks || [],
    escapeRisk: parsed.escapeRisk || undefined,
  };
}

/**
 * POST /api/bench/run
 * 执行一次安全基线扫描（管理员）
 */
router.post(
  '/run',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const report = await runSecurityBench();
    const id = saveReport(report);
    logOperation(
      res.locals.username,
      '安全基线扫描',
      'system',
      'Docker Bench',
      `通过 ${report.summary.pass} / 提示 ${report.summary.info} / 警告 ${report.summary.warn} / 高危 ${report.summary.fail}`,
      true,
    );
    void req;
    res.json({ ...report, id });
  }),
);

/**
 * GET /api/bench/latest
 * 最近一次扫描完整报告；无记录时返回 { empty: true }
 */
router.get(
  '/latest',
  asyncHandler(async (_req: Request, res: Response) => {
    const row = getDb()
      .prepare('SELECT * FROM bench_runs ORDER BY id DESC LIMIT 1')
      .get() as any;
    if (!row) return res.json({ empty: true });
    res.json(rowToReport(row));
  }),
);

/**
 * GET /api/bench/history?limit=20
 * 扫描历史摘要（不含明细）
 */
router.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const rows = getDb()
      .prepare(
        `SELECT id, started_at, duration_ms, pass, warn, fail, info, skip
         FROM bench_runs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<Record<string, number>>;
    res.json({ items: rows });
  }),
);

/**
 * GET /api/bench/trend
 * 逃逸风险与检查结果趋势（最近 30 次，供基线扫描页趋势图）
 */
router.get(
  '/trend',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = getDb()
      .prepare('SELECT id, started_at, pass, warn, fail, results_json FROM bench_runs ORDER BY id DESC LIMIT 30')
      .all() as unknown as Array<{ id: number; started_at: number; pass: number; warn: number; fail: number; results_json: string }>;
    const items = rows.reverse().map((r) => {
      let maxRisk = 0;
      try {
        const parsed = JSON.parse(r.results_json || '{}');
        const er = Array.isArray(parsed) ? null : parsed?.escapeRisk;
        maxRisk = er?.maxScore || 0;
      } catch {
        // 旧格式无风险分
      }
      return { id: r.id, startedAt: r.started_at, pass: r.pass, warn: r.warn, fail: r.fail, maxRisk };
    });
    res.json({ items });
  }),
);

/**
 * GET /api/bench/:id
 * 按记录 ID 取完整报告
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const row = getDb()
      .prepare('SELECT * FROM bench_runs WHERE id = ?')
      .get(Number(req.params.id)) as any;
    if (!row) return res.status(404).json({ error: '记录不存在' });
    res.json(rowToReport(row));
  }),
);

export default router;
