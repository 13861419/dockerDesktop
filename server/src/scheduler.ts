/**
 * 通用定时调度器（计划任务）
 *
 * 为「计划任务」提供基于 cron 表达式的轻量调度能力：
 *  - 读取 SQLite cron_tasks 表中「已启用」且「到达下次执行时间」的任务
 *  - 通过「任务类型 → handler」注册表分发执行（handler 由各业务模块注册，避免循环依赖）
 *  - 执行后更新 last_run_at / last_status / last_detail / next_run_at，并通过 onRun 回调记录执行历史
 *
 * 采用 setInterval（默认 10s tick）+ timer.unref + started 标志的控制方式（与 monitor.ts 同风格）。
 */
import { getDb } from './storage';

/** 单个任务的数据库行（snake_case 列映射） */
export interface CronTaskRow {
  id: string;
  name: string;
  type: string;
  cron: string;
  enabled: number;
  config: string;
  last_run_at: number | null;
  last_status: number | null;
  last_detail: string | null;
  next_run_at: number;
  created_at: number;
  updated_at: number;
}

/** 任务执行结果（handler 返回，用于落库与历史记录） */
export interface TaskRunResult {
  ok: boolean;
  detail?: string;
}

/** 任务类型执行函数签名 */
export type TaskHandler = (
  task: CronTaskRow,
  config: Record<string, any>,
) => Promise<TaskRunResult>;

/** 类型 → handler 注册表 */
const handlers = new Map<string, TaskHandler>();

/** 执行历史回调（由 tasks.ts 注册，用于写入 cron_task_logs 表） */
let onRunCb: ((task: CronTaskRow, result: TaskRunResult) => void) | null = null;

/** 调度 tick 间隔（毫秒） */
const TICK_MS = 10000;

/** 是否已启动 */
let started = false;
/** 调度定时器 */
let timer: NodeJS.Timeout | null = null;

/** 防止任务并发重入时重复调度的简单运行中集合 */
const runningIds = new Set<string>();

/**
 * 注册某任务类型的执行函数
 * @param type 任务类型（如 prune / backup / pull）
 * @param fn 执行函数
 */
export function registerTaskHandler(type: string, fn: TaskHandler): void {
  handlers.set(type, fn);
}

/**
 * 注册执行历史回调（供 tasks.ts 在每次执行后写 cron_task_logs）
 * @param cb 回调
 */
export function setTaskRunCallback(cb: (task: CronTaskRow, result: TaskRunResult) => void): void {
  onRunCb = cb;
}

/**
 * 计算给定 cron 表达式下一次执行的时间戳（毫秒）
 *
 * 支持标准 5 段 cron：分 时 日 月 周，允许通配符星号、星号加步进、数字、数字逗号数字。
 * @param cron cron 表达式
 * @param from 从该时间起算（默认当前时间）
 * @returns 下一次执行时间戳（毫秒）；表达式无法解析时返回 null
 */
export function nextRunTime(cron: string, from: number = Date.now()): number | null {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, dayF, monthF, dowF] = parts;
  if (![minF, hourF, dayF, monthF, dowF].every(isValidField)) return null;

  // 从 from 之后的下一个整分钟开始扫描（避免同一分钟重复触发）
  let t = new Date(Math.floor(from / 60000) * 60000 + 60000);
  // 最多向后扫描 2 年，防止无解表达式死循环
  const limit = from + 2 * 366 * 24 * 3600 * 1000;
  for (; t.getTime() < limit; t = new Date(t.getTime() + 60000)) {
    if (
      matches(minF, t.getMinutes()) &&
      matches(hourF, t.getHours()) &&
      matches(monthF, t.getMonth() + 1) &&
      matches(dayF, t.getDate()) &&
      matches(dowF, (t.getDay() + 6) % 7) // cron 周日=0(7)，这里归一为 0..6 周一=0
    ) {
      return t.getTime();
    }
  }
  return null;
}

/**
 * 校验 cron 字段是否合法
 * @param field 字段文本
 */
function isValidField(field: string): boolean {
  return field.split(',').every((f) => {
    if (f === '*') return true;
    const m = f.match(/^(\d+|\*)(\/(\d+))?$/);
    if (!m) return false;
    if (m[3] && Number(m[3]) <= 0) return false;
    if (m[1] !== '*') {
      const v = Number(m[1]);
      if (Number.isNaN(v)) return false;
    }
    return true;
  });
}

/**
 * 判断给定值是否命中 cron 字段（支持通配符星号、星号加步进、数字、数字逗号数字）
 * @param field 字段文本
 * @param value 当前值
 */
function matches(field: string, value: number): boolean {
  return field.split(',').some((f) => {
    if (f === '*') return true;
    if (f.startsWith('*/')) {
      const step = Number(f.slice(2));
      return step > 0 && value % step === 0;
    }
    return Number(f) === value;
  });
}

/**
 * 执行单个任务（更新状态并回调历史）
 * @param row 任务行
 */
async function executeTask(row: CronTaskRow): Promise<void> {
  const d = getDb();
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch {
    config = {};
  }
  const handler = handlers.get(row.type);
  let result: TaskRunResult;
  if (!handler) {
    result = { ok: false, detail: `任务类型 ${row.type} 未注册处理器` };
  } else {
    try {
      result = await handler(row, config);
    } catch (err: any) {
      result = { ok: false, detail: String(err?.message || err) };
    }
  }

  const now = Date.now();
  const nextRun = nextRunTime(row.cron, now);
  d.prepare(
    `UPDATE cron_tasks
     SET last_run_at = ?, last_status = ?, last_detail = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    now,
    result.ok ? 0 : 1,
    result.detail || null,
    nextRun ?? now,
    now,
    row.id,
  );
  if (onRunCb) {
    try {
      onRunCb({ ...row, last_run_at: now, last_status: result.ok ? 0 : 1, last_detail: result.detail ?? null, next_run_at: nextRun ?? now }, result);
    } catch {
      // 历史记录失败不影响任务执行
    }
  }
}

/**
 * 扫描并执行所有「已启用且已到期」的任务
 */
async function tick(): Promise<void> {
  const d = getDb();
  const now = Date.now();
  const rows = d
    .prepare(
      'SELECT id, name, type, cron, enabled, config, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at FROM cron_tasks WHERE enabled = 1 AND next_run_at <= ?',
    )
    .all(now) as unknown as CronTaskRow[];
  for (const row of rows) {
    if (runningIds.has(row.id)) continue; // 避免并发重入
    runningIds.add(row.id);
    try {
      await executeTask(row);
    } catch {
      // task 内部已捕获错误，此处兜底
    } finally {
      runningIds.delete(row.id);
    }
  }
}

/**
 * 启动调度器（幂等）
 */
export function startScheduler(): void {
  if (started) return;
  started = true;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[scheduler] 调度执行失败:', err));
  }, TICK_MS);
  timer.unref(); // 不阻止进程退出
  console.log('[scheduler] 计划任务调度器已启动 (间隔 ' + TICK_MS + 'ms)');
}

/**
 * 停止调度器
 */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
