/**
 * 资源告警服务
 *
 * 周期性读取实时监控点（CPU/内存/磁盘使用率），按可配置告警规则（阈值/开关）
 * 判断是否触发告警。触发时：
 *  1. 写入告警记录表 alert_records（供历史查询）
 *  2. 推送到已启用的通知渠道（Webhook / 邮件 / 钉钉 / 飞书）
 *
 * 为避免同一持续告警反复刷屏，采用"最近触发去重"：同一类型+级别在达到
 * 静默间隔前不重复推送与落库。
 */
import { getDb } from './storage';
import { getCurrentMonitor } from './docker/monitor';
import { listChannels, sendAlert } from './notify';

/** 资源类型 */
export type AlertType = 'cpu' | 'mem' | 'disk' | 'task';
/** 告警级别 */
export type AlertLevel = 'warn' | 'danger' | 'recovery';

/** 告警规则行 */
interface AlertRuleRow {
  type: string;
  enabled: number;
  warn_threshold: number;
  danger_threshold: number;
  updated_at: number;
  silent_start: string | null;
  silent_end: string | null;
  workdays_only: number;
  work_start: string | null;
  work_end: string | null;
}

/** 归一化后的告警规则（含静默/工作时段配置） */
interface AlertRule {
  enabled: boolean;
  warn: number;
  danger: number;
  silentStart: string | null;
  silentEnd: string | null;
  workdaysOnly: boolean;
  workStart: string | null;
  workEnd: string | null;
}

/** 告警记录行 */
interface AlertRecordRow {
  id: number;
  type: string;
  level: string;
  message: string;
  value: number | null;
  channel_id: string | null;
  push_status: string;
  push_detail: string | null;
  created_at: number;
}

/** 默认告警规则（首次创建或缺省行时写入） */
const DEFAULT_RULES: Array<{ type: AlertType; name: string; warn: number; danger: number }> = [
  { type: 'cpu', name: 'CPU', warn: 75, danger: 90 },
  { type: 'mem', name: '内存', warn: 75, danger: 90 },
  { type: 'disk', name: '磁盘', warn: 75, danger: 90 },
];

/** 检测 tick 间隔（毫秒）：沿用监控采集节奏，但检测不必过频，10s 足够 */
const TICK_MS = 10000;
/** 同一告警（类型+级别）重复推送的静默间隔（毫秒）：默认 30 分钟 */
const REPEAT_INTERVAL = Number(process.env.ALERT_REPEAT_MS || 30 * 60 * 1000);

/** 是否已启动 */
let started = false;
/** 检测定时器 */
let timer: NodeJS.Timeout | null = null;
/** 最近触发去重表：key = `${type}:${level}` -> 上次触发时间戳 */
const lastAlertAt = new Map<string, number>();
/** 资源当前活跃告警级别：type -> 当前级别，用于恢复通知状态机 */
const activeAlerts = new Map<string, AlertLevel>();

/**
 * 读取告警规则表，缺省行自动补默认值
 * @returns 规则映射 { type -> rule }
 */
function loadRules(): Record<AlertType, AlertRule> {
  const d = getDb();
  const rows = d
    .prepare(
      'SELECT type, enabled, warn_threshold, danger_threshold, updated_at, silent_start, silent_end, workdays_only, work_start, work_end FROM alert_rules',
    )
    .all() as unknown as AlertRuleRow[];
  const byType = new Map<string, AlertRuleRow>();
  for (const r of rows) byType.set(r.type, r);

  const now = Date.now();
  const ins = d.prepare(
    'INSERT OR IGNORE INTO alert_rules (type, enabled, warn_threshold, danger_threshold, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const result = {} as Record<AlertType, AlertRule>;
  for (const def of DEFAULT_RULES) {
    const row = byType.get(def.type);
    const normalize = (r: AlertRuleRow): AlertRule => ({
      enabled: r.enabled === 1,
      warn: Number(r.warn_threshold),
      danger: Number(r.danger_threshold),
      silentStart: r.silent_start || null,
      silentEnd: r.silent_end || null,
      workdaysOnly: r.workdays_only === 1,
      workStart: r.work_start || null,
      workEnd: r.work_end || null,
    });
    if (!row) {
      ins.run(def.type, 1, def.warn, def.danger, now);
      result[def.type] = {
        enabled: true,
        warn: def.warn,
        danger: def.danger,
        silentStart: null,
        silentEnd: null,
        workdaysOnly: false,
        workStart: null,
        workEnd: null,
      };
    } else {
      result[def.type] = normalize(row);
    }
  }
  return result;
}

/**
 * 依据规则的阈值判定当前使用率对应的告警级别
 * @param percent 使用率（0-100）
 * @param rule 规则
 * @returns 级别或 null（未达告警线）
 */
function evaluateLevel(percent: number, rule: { warn: number; danger: number }): AlertLevel | null {
  if (percent >= rule.danger) return 'danger';
  if (percent >= rule.warn) return 'warn';
  return null;
}

/**
 * 将 "HH:mm" 时间字符串转换为当日分钟数（0-1439）
 * @param time 形如 "08:30" 的时间
 * @returns 分钟数；非法输入返回 null
 */
function toMinutes(time: string | null): number | null {
  if (!time) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

/**
 * 判断规则在当前时刻是否处于"静默"状态：
 *  - 静默时段：当前时间落在 [silentStart, silentEnd] 内（支持跨午夜）
 *  - 仅工作日：当前是周六/周日
 *  - 工作时段：当前时间不在 [workStart, workEnd] 内
 * 任一条件命中即视为静默；全部未配置返回 false（不禁言）
 * @param rule 归一化规则
 * @param now 当前时间
 * @returns 是否处于静默
 */
function isInSilentWindow(rule: AlertRule, now: Date): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();

  // 静默时段：配置了起止时间则判断是否在区间内（含跨午夜）
  const sStart = toMinutes(rule.silentStart);
  const sEnd = toMinutes(rule.silentEnd);
  if (sStart !== null && sEnd !== null) {
    if (sStart <= sEnd) {
      if (cur >= sStart && cur <= sEnd) return true;
    } else if (cur >= sStart || cur <= sEnd) {
      // 跨午夜：如 22:00 - 06:00
      return true;
    }
  }

  // 仅工作日告警：周六(6) 或 周日(0) 静默
  if (rule.workdaysOnly) {
    const day = now.getDay();
    if (day === 0 || day === 6) return true;
  }

  // 工作时段：配置了起止时间且当前不在区间内则静默
  const wStart = toMinutes(rule.workStart);
  const wEnd = toMinutes(rule.workEnd);
  if (wStart !== null && wEnd !== null) {
    if (wStart <= wEnd) {
      if (cur < wStart || cur > wEnd) return true;
    } else if (cur < wStart && cur > wEnd) {
      // 工作时段跨午夜：均不在区间内才静默
      return true;
    }
  }

  return false;
}

/**
 * 构建资源告警文案（CPU/内存/磁盘）
 * @param type 资源类型
 * @param level 级别
 */
function buildMessage(type: AlertType, level: AlertLevel, value: number): string {
  const names: Record<string, string> = { cpu: 'CPU', mem: '内存', disk: '磁盘' };
  if (level === 'danger') {
    return `Docker 面板【${names[type]}】使用率过高：${value.toFixed(1)}%`;
  }
  return `Docker 面板【${names[type]}】使用率偏高：${value.toFixed(1)}%`;
}

/**
 * 选择第一个启用的通知渠道用于本次推送
 * @returns 渠道 id；无启用渠道时返回 null
 */
function pickEnabledChannel(): string | null {
  const channels = listChannels();
  const enabled = channels.find((c) => c.enabled);
  return enabled ? enabled.id : null;
}

/**
 * 写入一条告警记录并尝试推送到启用渠道（通用）
 * @param type 告警类型（资源或 task）
 * @param level 级别（warn/danger/recovery）
 * @param message 告警文案
 * @param value 可选数值（如使用率）
 */
async function emitAlert(type: AlertType, level: AlertLevel, message: string, value: number | null): Promise<void> {
  const channelId = pickEnabledChannel();
  const d = getDb();

  let pushStatus = 'none';
  let pushDetail: string | null = null;

  if (channelId) {
    try {
      const res = await sendAlert(channelId, message);
      if (res.ok) {
        pushStatus = 'ok';
      } else {
        pushStatus = 'failed';
        pushDetail = res.detail;
      }
    } catch (err: any) {
      pushStatus = 'failed';
      pushDetail = String(err?.message || err);
    }
  }

  d.prepare(
    'INSERT INTO alert_records (type, level, message, value, channel_id, push_status, push_detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(type, level, message, value, channelId, pushStatus, pushDetail, Date.now());

  // 清理超量记录，最多保留最近 800 条
  try {
    d.prepare('DELETE FROM alert_records WHERE id NOT IN (SELECT id FROM alert_records ORDER BY id DESC LIMIT 800)').run();
  } catch {
    // 清理失败不影响告警
  }
}

/**
 * 资源告警（CPU/内存/磁盘）触发入口
 * @param type 资源类型
 * @param level 级别
 * @param value 使用率
 */
async function fireAlert(type: AlertType, level: AlertLevel, value: number): Promise<void> {
  await emitAlert(type, level, buildMessage(type, level, value), value);
}

/**
 * 资源恢复通知：资源从告警态回落到阈值下方时触发
 * @param type 资源类型
 * @param value 使用率
 */
async function fireRecovery(type: AlertType, value: number): Promise<void> {
  const names: Record<string, string> = { cpu: 'CPU', mem: '内存', disk: '磁盘' };
  await emitAlert(type, 'recovery', `Docker 面板【${names[type]}】已恢复正常：${value.toFixed(1)}%`, value);
}

/**
 * 以指定类型+级别的去重键执行告警
 * @param type 资源类型
 * @param level 级别
 * @param value 使用率
 * @param force 是否忽略静默间隔（级别升级或恢复时强制推送）
 */
async function maybeFire(type: AlertType, level: AlertLevel, value: number, force = false): Promise<void> {
  const key = `${type}:${level}`;
  const last = lastAlertAt.get(key) || 0;
  const now = Date.now();
  if (!force && now - last < REPEAT_INTERVAL) return; // 静默期内不重复
  lastAlertAt.set(key, now);
  await fireAlert(type, level, value);
}

/**
 * 任务失败告警：由调度器在任务执行失败时调用（推送 + 落库）
 * @param taskName 任务名称
 * @param detail 失败详情
 * @param source 触发来源（如 scheduled / manual）
 */
export async function reportTaskFailure(taskName: string, detail: string, source = 'scheduled'): Promise<void> {
  const message = `Docker 面板【计划任务】「${taskName}」执行失败（${source}）：${detail || '未知错误'}`;
  await emitAlert('task', 'danger', message, null);
}

/**
 * 单次检测
 */
async function check(): Promise<void> {
  const point = getCurrentMonitor();
  if (!point) return; // 监控尚未就绪
  const rules = loadRules();
  const samples: Array<{ type: AlertType; percent: number }> = [
    { type: 'cpu', percent: point.cpu.percent },
    { type: 'mem', percent: point.mem.percent },
    { type: 'disk', percent: point.disk.percent },
  ];
  for (const s of samples) {
    const rule = rules[s.type];
    const prev = activeAlerts.get(s.type) ?? null;
    if (!rule.enabled) {
      // 规则被停用：清除活跃态（不发送恢复，视为静默解除）
      if (prev) activeAlerts.delete(s.type);
      continue;
    }
    // 处于静默/非工作时段：整体跳过该资源检测（不告警也不做恢复判定）
    if (isInSilentWindow(rule, new Date())) continue;
    const level = evaluateLevel(s.percent, rule);
    if (level) {
      const escalated = prev === null || (level === 'danger' && prev !== 'danger');
      activeAlerts.set(s.type, level);
      // 级别升级或从无到有时强制推送，否则按静默间隔去重
      await maybeFire(s.type, level, s.percent, escalated);
    } else if (prev) {
      // 已恢复：推送恢复通知并清除活跃态
      activeAlerts.delete(s.type);
      await fireRecovery(s.type, s.percent);
    }
  }
}

/**
 * 启动告警服务（幂等）
 */
export function startAlerting(): void {
  if (started) return;
  started = true;
  timer = setInterval(() => {
    check().catch((err) => console.error('[alerting] 检测失败:', (err as Error)?.message));
  }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[alerting] 资源告警服务已启动 (间隔 ' + TICK_MS + 'ms)');
}

/**
 * 停止告警服务
 */
export function stopAlerting(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

/**
 * 立即触发一次检测（供「立即检测」接口手动调用）
 */
export async function runAlertCheckNow(): Promise<{ checked: boolean }> {
  await check();
  return { checked: true };
}

/**
 * 获取告警规则列表
 */
export function getAlertRules(): Array<{
  type: AlertType;
  name: string;
  enabled: boolean;
  warnThreshold: number;
  dangerThreshold: number;
  silentStart: string | null;
  silentEnd: string | null;
  workdaysOnly: boolean;
  workStart: string | null;
  workEnd: string | null;
}> {
  const rules = loadRules();
  return DEFAULT_RULES.map((def) => ({
    type: def.type,
    name: def.name,
    enabled: rules[def.type].enabled,
    warnThreshold: rules[def.type].warn,
    dangerThreshold: rules[def.type].danger,
    silentStart: rules[def.type].silentStart,
    silentEnd: rules[def.type].silentEnd,
    workdaysOnly: rules[def.type].workdaysOnly,
    workStart: rules[def.type].workStart,
    workEnd: rules[def.type].workEnd,
  }));
}

/**
 * 校验并归一化单个 "HH:mm" 时间字段
 * @param value 原始值；空字符串/undefined/null 视为未配置
 * @returns 归一化时间字符串或 null
 */
function normalizeTime(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (!/^\d{2}:\d{2}$/.test(s)) {
    throw Object.assign(new Error('时间格式需为 HH:mm（如 08:30）'), { statusCode: 400 });
  }
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(3, 5));
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw Object.assign(new Error('时间需在 00:00 - 23:59 之间'), { statusCode: 400 });
  }
  return s;
}

/**
 * 校验并归一化时段起止（起不得大于止，跨午夜需显式由用户确认？此处按普通区间处理）
 * @param start 起始时间（已归一化）
 * @param end 结束时间（已归一化）
 * @param label 字段中文名（用于报错）
 */
function validateRange(start: string | null, end: string | null, label: string): void {
  if (!start || !end) return;
  const sm = toMinutes(start);
  const em = toMinutes(end);
  if (sm === null || em === null) return;
  if (sm > em) {
    throw Object.assign(new Error(`${label}开始时间不能晚于结束时间`), { statusCode: 400 });
  }
}

/**
 * 更新单条告警规则
 * @param type 资源类型
 * @param patch 待更新字段（含静默/工作时段配置）
 */
export function updateAlertRule(
  type: string,
  patch: {
    enabled?: boolean;
    warnThreshold?: number;
    dangerThreshold?: number;
    silentStart?: string | null;
    silentEnd?: string | null;
    workdaysOnly?: boolean;
    workStart?: string | null;
    workEnd?: string | null;
  },
): void {
  if (!['cpu', 'mem', 'disk'].includes(type)) {
    throw Object.assign(new Error('不支持的告警类型'), { statusCode: 400 });
  }
  const d = getDb();
  loadRules(); // 确保默认行存在
  const row = d.prepare('SELECT warn_threshold, danger_threshold, enabled, silent_start, silent_end, workdays_only, work_start, work_end FROM alert_rules WHERE type = ?').get(type) as
    | {
        warn_threshold: number;
        danger_threshold: number;
        enabled: number;
        silent_start: string | null;
        silent_end: string | null;
        workdays_only: number;
        work_start: string | null;
        work_end: string | null;
      }
    | undefined;
  if (!row) throw Object.assign(new Error('告警规则不存在'), { statusCode: 404 });

  let warn = patch.warnThreshold !== undefined ? Number(patch.warnThreshold) : row.warn_threshold;
  let danger = patch.dangerThreshold !== undefined ? Number(patch.dangerThreshold) : row.danger_threshold;
  if (Number.isNaN(warn) || Number.isNaN(danger) || warn < 0 || danger < 0 || warn > 100 || danger > 100) {
    throw Object.assign(new Error('阈值需为 0-100 的数字'), { statusCode: 400 });
  }
  if (warn > danger) {
    throw Object.assign(new Error('警告阈值不能高于危险阈值'), { statusCode: 400 });
  }
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled;

  // 静默/工作时段字段校验与归一化
  const silentStart = patch.silentStart !== undefined ? normalizeTime(patch.silentStart) : row.silent_start || null;
  const silentEnd = patch.silentEnd !== undefined ? normalizeTime(patch.silentEnd) : row.silent_end || null;
  const workStart = patch.workStart !== undefined ? normalizeTime(patch.workStart) : row.work_start || null;
  const workEnd = patch.workEnd !== undefined ? normalizeTime(patch.workEnd) : row.work_end || null;
  validateRange(silentStart, silentEnd, '静默时段');
  validateRange(workStart, workEnd, '工作时段');
  const workdaysOnly = patch.workdaysOnly !== undefined ? (patch.workdaysOnly ? 1 : 0) : row.workdays_only;

  d.prepare(
    'UPDATE alert_rules SET enabled = ?, warn_threshold = ?, danger_threshold = ?, silent_start = ?, silent_end = ?, workdays_only = ?, work_start = ?, work_end = ?, updated_at = ? WHERE type = ?',
  ).run(
    enabled,
    warn,
    danger,
    silentStart,
    silentEnd,
    workdaysOnly,
    workStart,
    workEnd,
    Date.now(),
    type,
  );
}

/**
 * 获取告警记录（分页 + 过滤，按时间倒序）
 * @param opts 查询参数（页码/每页条数/类型/级别/推送状态）
 */
export function getAlertRecords(opts?: {
  page?: number;
  pageSize?: number;
  type?: string;
  level?: string;
  pushStatus?: string;
}): {
  records: Array<{
    id: number;
    type: string;
    level: string;
    message: string;
    value: number | null;
    channelId: string | null;
    pushStatus: string;
    pushDetail: string | null;
    createdAt: number;
  }>;
  total: number;
} {
  const page = Math.max(Number(opts?.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(opts?.pageSize) || 20, 1), 100);
  const where: string[] = [];
  const params: any[] = [];
  if (opts?.type) {
    where.push('type = ?');
    params.push(opts.type);
  }
  if (opts?.level) {
    where.push('level = ?');
    params.push(opts.level);
  }
  if (opts?.pushStatus) {
    where.push('push_status = ?');
    params.push(opts.pushStatus);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const d = getDb();
  const totalRow = d.prepare(`SELECT COUNT(*) AS c FROM alert_records ${whereSql}`).get(...params) as { c: number };
  const rows = d
    .prepare(`SELECT id, type, level, message, value, channel_id, push_status, push_detail, created_at FROM alert_records ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as AlertRecordRow[];
  return {
    records: rows.map((r) => ({
      id: r.id,
      type: r.type,
      level: r.level,
      message: r.message,
      value: r.value,
      channelId: r.channel_id,
      pushStatus: r.push_status,
      pushDetail: r.push_detail,
      createdAt: r.created_at,
    })),
    total: totalRow.c,
  };
}

/**
 * 清空全部告警记录
 */
export function clearAlertRecords(): void {
  getDb().prepare('DELETE FROM alert_records').run();
}

/**
 * 生成一条当前监控摘要文本（供「测试推送」使用）
 * @returns 摘要文本；监控未就绪时返回 null
 */
export function buildSnapshotText(): string | null {
  const point = getCurrentMonitor();
  if (!point) return null;
  const lines = [
    'Docker 管理面板 测试消息',
    `CPU ${point.cpu.percent.toFixed(1)}% / ${point.cpu.cores} 核`,
    `内存 ${point.mem.percent.toFixed(1)}%`,
    `磁盘 ${point.disk.percent.toFixed(1)}%`,
    `容器 ${point.containers.running}/${point.containers.total} 运行`,
  ];
  return lines.join('\n');
}
