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
import { reportTaskFailure, reportTaskSuccess } from './alerting';

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
  /** 任务超时秒数（1.81.0，null/0 = 无限制；超时按失败处理并告警） */
  timeout_sec?: number | null;
  /** 失败自动重试次数（1.81.0，默认 0 = 不重试） */
  max_retries?: number | null;
  /** 重试间隔秒（1.81.0，默认 300，最小 60） */
  retry_interval_sec?: number | null;
  /** 通知策略（1.81.0）：failure=仅失败告警（默认）| always=成功也通知 | never=不通知 */
  notify_mode?: string | null;
  /** 成功后触发的下游任务 id（1.84.0 线性链，null = 不链式） */
  next_task_id?: string | null;
  /** 默认运行参数 JSON（1.84.0，替换 config 字符串中的 {{占位符}}） */
  default_params?: string | null;
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

/** 任务重试计数（内存态，1.81.0）：id → 已重试次数；成功或达到上限后清除 */
const retryAttempts = new Map<string, number>();

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

/** 超时竞速：sec 秒后 reject；到点后 reject（后台进程可能仍在运行，detail 中说明） */
export function withTimeout<T>(p: Promise<T>, sec: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`任务执行超过 ${sec} 秒未完成，已标记失败（后台进程可能仍在运行）`)), sec * 1000);
    t.unref?.();
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/**
 * 执行单个任务（更新状态并回调历史）
 *
 * 1.81.0 起支持：超时控制（timeout_sec）、失败自动重试（max_retries × retry_interval_sec，
 * 重试期间不推最终告警、不推进常规调度）、通知分级（notify_mode）。
 * 1.84.0 起支持：链式触发——成功后自动调度 next_task_id 指向的下游任务（最多 CHAIN_MAX_DEPTH 层）。
 * @param row 任务行
 * @param chainDepth 链式触发深度（0 = 顶层触发）
 */
async function executeTask(row: CronTaskRow, chainDepth = 0): Promise<void> {
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
    const timeoutSec = Number(row.timeout_sec) || 0;
    try {
      result = timeoutSec > 0 ? await withTimeout(handler(row, config), timeoutSec) : await handler(row, config);
    } catch (err: any) {
      result = { ok: false, detail: String(err?.message || err) };
    }
  }

  const now = Date.now();
  const nextRun = nextRunTime(row.cron, now);

  // 失败重试（1.81.0）：还有剩余次数时把 next_run_at 推迟到重试时间，不推最终告警
  if (!result.ok) {
    const maxRetries = Math.max(0, Number(row.max_retries) || 0);
    const attempt = retryAttempts.get(row.id) || 0;
    if (attempt < maxRetries) {
      retryAttempts.set(row.id, attempt + 1);
      const delaySec = Math.max(60, Number(row.retry_interval_sec) || 300);
      const retryAt = now + delaySec * 1000;
      const detail = `第 ${attempt + 1}/${maxRetries} 次失败，将于 ${new Date(retryAt).toLocaleString()} 自动重试：${result.detail || '未知错误'}`.slice(0, 2000);
      d.prepare(
        `UPDATE cron_tasks SET last_run_at = ?, last_status = ?, last_detail = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      ).run(now, 1, detail, retryAt, now, row.id);
      if (onRunCb) {
        try {
          onRunCb({ ...row, last_run_at: now, last_status: 1, last_detail: detail, next_run_at: retryAt }, result);
        } catch {
          // 历史记录失败不影响任务执行
        }
      }
      return;
    }
    retryAttempts.delete(row.id);
  } else {
    retryAttempts.delete(row.id);
  }

  // 通知分级（1.81.0）：failure=仅失败（默认）| always=成功也通知 | never=静默
  const notifyMode = row.notify_mode === 'always' || row.notify_mode === 'never' ? row.notify_mode : 'failure';
  if (!result.ok && notifyMode !== 'never') {
    try {
      await reportTaskFailure(row.name || row.id, result.detail || '未知错误', '定时触发');
    } catch {
      // 告警失败不影响任务本身
    }
  }
  if (result.ok && notifyMode === 'always') {
    try {
      await reportTaskSuccess(row.name || row.id, result.detail || '');
    } catch {
      // 成功通知失败不影响任务本身
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

  // 链式触发（1.84.0）：成功后调度下游任务（fire-and-forget，锁由 dispatchChain 自管）
  dispatchChain(row, result, chainDepth);
}

/** 链式触发最大深度（1.84.0）：防御写入侧漏网的环，避免无限级联 */
export const CHAIN_MAX_DEPTH = 10;

/**
 * 链式触发：任务成功后调度 next_task_id 指向的下游任务（1.84.0）
 *
 * 调度器与手动执行共用：下游任务按调度器路径执行（更新 next_run_at、写执行历史）。
 * 下游未启用 / 不存在 / 执行锁被占用时静默跳过，不影响上游结果。
 * @param row 上游任务行（读取 next_task_id）
 * @param result 上游执行结果（仅成功触发）
 * @param depth 当前链深度（≥ CHAIN_MAX_DEPTH 时停止）
 */
export function dispatchChain(row: CronTaskRow, result: TaskRunResult, depth = 0): void {
  if (!result.ok || depth >= CHAIN_MAX_DEPTH) return;
  const nextId = (row as CronTaskRow).next_task_id;
  if (!nextId) return;
  let next: CronTaskRow | undefined;
  try {
    next = getDb()
      .prepare('SELECT id, name, type, cron, enabled, config, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at, timeout_sec, max_retries, retry_interval_sec, notify_mode, next_task_id, default_params FROM cron_tasks WHERE id = ? AND enabled = 1')
      .get(nextId) as unknown as CronTaskRow | undefined;
  } catch {
    return;
  }
  if (!next || !tryAcquireTaskRun(next.id)) return;
  executeTask(next, depth + 1)
    .catch(() => {
      // 下游执行错误不影响上游任务
    })
    .finally(() => releaseTaskRun(next!.id));
}

/**
 * 判断「from → to」这条链边是否会成环（1.84.0）
 *
 * 从 to 出发沿 next 指针向后走，若能回到 from 则成环。
 * @param map 全量任务的 { id → next_task_id } 映射
 * @param from 要写入链边的任务 id
 * @param to 计划指向的下游任务 id（null/空 直接放行）
 * @returns true = 会成环（应拒绝写入）
 */
export function wouldCreateCycle(map: Record<string, string | null>, from: string, to: string | null | undefined): boolean {
  if (!to) return false;
  let cur: string | null | undefined = to;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === from) return true;
    seen.add(cur);
    cur = map[cur] || null;
  }
  return false;
}

/** {{占位符}} 匹配：{{name}} / {{ name }}，键名为合法标识符 */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * 提取文本中出现的全部 {{占位符}} 键名（去重，1.84.0）
 * @param text 任意文本（通常为 JSON.stringify 后的任务配置）
 * @returns 去重后的键名数组
 */
export function extractPlaceholders(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 把运行参数深替换进配置（1.84.0）：遍历对象/数组，所有字符串值中的 {{key}}
 * 替换为 params[key]（键名需为合法标识符）。未知占位符保持原样。
 * @param cfg 原配置（不修改原对象）
 * @param params 运行参数
 * @returns { config: 替换后的深拷贝, applied: 实际使用的键, missing: 未提供值的占位符键 }
 */
export function applyParams<T>(cfg: T, params: Record<string, string>): { config: T; applied: string[]; missing: string[] } {
  const applied: string[] = [];
  const missing: string[] = [];
  const validKeys = Object.keys(params).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
  const walk = (val: any): any => {
    if (typeof val === 'string') {
      return val.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (raw, key: string) => {
        if (Object.prototype.hasOwnProperty.call(params, key) && validKeys.includes(key)) {
          if (!applied.includes(key)) applied.push(key);
          return params[key];
        }
        if (!missing.includes(key)) missing.push(key);
        return raw;
      });
    }
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(val)) out[k] = walk(val[k]);
      return out;
    }
    return val;
  };
  return { config: walk(cfg) as T, applied, missing };
}

/**
 * 扫描并执行所有「已启用且已到期」的任务
 */
async function tick(): Promise<void> {
  const d = getDb();
  const now = Date.now();
  const rows = d
    .prepare(
      'SELECT id, name, type, cron, enabled, config, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at, timeout_sec, max_retries, retry_interval_sec, notify_mode FROM cron_tasks WHERE enabled = 1 AND next_run_at <= ?',
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
