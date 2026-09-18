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
import { reportTaskFailure } from './alerting';

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
  /** 步骤化输出（1.66.0）：每个节点的名称 / 状态 / 耗时 / 输出，Coze 风格节点流 */
  steps?: TaskStep[];
}

/** 单个执行节点（1.66.0） */
export interface TaskStep {
  name: string;
  status: 'ok' | 'fail' | 'skip';
  startedAt: number;
  durationMs: number;
  output: string;
}

/**
 * 步骤采集器：把一次任务执行拆成具名节点，逐步计时并记录输出（1.66.0）
 *
 * 用法：const sc = new StepCollector();
 *       await sc.run('拉取代码', () => gitPull(...));  // 抛错自动记失败并向上抛
 */
export class StepCollector {
  readonly steps: TaskStep[] = [];

  /** 执行一个节点：fn 返回输出文本；抛错记 fail 后向上抛出 */
  async run(name: string, fn: () => Promise<string>): Promise<string> {
    const startedAt = Date.now();
    try {
      const output = (await fn()) || '';
      this.steps.push({ name, status: 'ok', startedAt, durationMs: Date.now() - startedAt, output: String(output) });
      return output;
    } catch (e: any) {
      this.steps.push({
        name,
        status: 'fail',
        startedAt,
        durationMs: Date.now() - startedAt,
        output: String(e?.message || e),
      });
      throw e;
    }
  }

  /** 记录一个跳过节点 */
  skip(name: string, output: string): void {
    this.steps.push({ name, status: 'skip', startedAt: Date.now(), durationMs: 0, output });
  }
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
 * 尝试占用任务执行锁（1.44.0）：成功返回 true；任务已在执行中返回 false。
 * 供调度器 tick 与手动 / Webhook 触发（dispatchTask）共用，防止并发重入。
 */
export function tryAcquireTaskRun(id: string): boolean {
  if (runningIds.has(id)) return false;
  runningIds.add(id);
  return true;
}

/** 释放任务执行锁（与 tryAcquireTaskRun 配对使用） */
export function releaseTaskRun(id: string): void {
  runningIds.delete(id);
}

/**
 * 注册某任务类型的执行函数
 * @param type 任务类型（如 prune / backup / pull）
 * @param fn 执行函数
 */
export function registerTaskHandler(type: string, fn: TaskHandler): void {
  handlers.set(type, fn);
}

/**
 * 查询某任务类型的已注册 handler（供 routes/tasks.dispatchTask 手动执行时回退使用：
 * aiInspection / aiWeeklyReport / baselineScan 等由业务模块注册的类型不在 tasks 本地注册表内）
 * @param type 任务类型
 */
export function getRegisteredHandler(type: string): TaskHandler | undefined {
  return handlers.get(type);
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
 *
 * 支持五种写法（1.75.7 起新增区间 a-b 及带步进 a-b/n，步进跟在区间后）：
 * 星号、星号加步进、数字、区间、区间加步进，均可逗号组合。
 * @param field 字段文本
 */
function isValidField(field: string): boolean {
  return field.split(',').every((f) => {
    if (f === '*') return true;
    const m = f.match(/^(\*|(\d{1,4})(?:-(\d{1,4}))?)(\/(\d{1,4}))?$/);
    if (!m) return false;
    if (m[4] && Number(m[4]) <= 0) return false;
    if (m[2] !== undefined) {
      const a = Number(m[2]);
      const b = m[3] !== undefined ? Number(m[3]) : a;
      if (a > b) return false;
    }
    return true;
  });
}

/**
 * 判断给定值是否命中 cron 字段
 *
 * 支持星号、星号加步进、数字、区间、区间加步进（含逗号组合）；步进基于区间起点取余。
 * @param field 字段文本
 * @param value 当前值
 */
function matches(field: string, value: number): boolean {
  return field.split(',').some((f) => {
    if (f === '*') return true;
    const m = f.match(/^(\*|(\d{1,4})(?:-(\d{1,4}))?)(\/(\d+))?$/);
    if (!m) return false;
    const step = m[5] ? Number(m[5]) : 1;
    if (step <= 0) return false;
    let a = 0;
    let b = Number.MAX_SAFE_INTEGER;
    if (m[1] !== '*') {
      a = Number(m[2]);
      b = m[3] !== undefined ? Number(m[3]) : a;
      if (a > b) return false;
    }
    return value >= a && value <= b && (value - a) % step === 0;
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

  // 任务执行失败：推送告警（不阻塞任务执行，失败不影响状态更新）
  if (!result.ok) {
    try {
      await reportTaskFailure(row.name || row.id, result.detail || '未知错误', '定时触发');
    } catch {
      // 告警失败不影响任务本身
    }
  }

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
    if (!tryAcquireTaskRun(row.id)) continue; // 避免并发重入
    try {
      await executeTask(row);
    } catch {
      // task 内部已捕获错误，此处兜底
    } finally {
      releaseTaskRun(row.id);
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
