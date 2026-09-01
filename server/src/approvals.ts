/**
 * 高危操作审批流（二期）
 *
 * 开启 approvals.enabled 设置后，非管理员执行危险操作（删除容器/镜像/卷、
 * 网络清理等）不再直接生效，而是写入 approvals 表生成待审批记录；
 * 管理员在审批中心批准后由系统执行该操作，拒绝则留档。
 *
 * 设计要点：
 * - 管理员自身操作直接执行，不经审批（管理员即审批人）
 * - 同一提交人对同一动作+目标的待审批请求去重（避免重复刷单）
 * - 执行器注册表将 action_type 映射到实际 Docker 操作，审批通过后执行
 * - 执行失败不回滚审批状态，但把错误信息记录在 result 字段供排查
 */
import { Request, Response } from 'express';
import { getDb } from './storage';
import { getDockerClient } from './docker/client';
import { getSetting } from './settings';
import { listChannels, sendAlert } from './notify';
import { markExecuted } from './aiActions';
import { hasPermission } from './rbac';

/** 审批状态 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** 可触发审批门禁的危险动作类型 */
export const GATE_ACTIONS: Record<string, { label: string; targetType: string }> = {
  'container.delete': { label: '删除容器', targetType: 'container' },
  'image.delete': { label: '删除镜像', targetType: 'image' },
  'image.deleteBatch': { label: '批量删除镜像', targetType: 'image' },
  'image.prune': { label: '清理悬空镜像', targetType: 'image' },
  'volume.delete': { label: '删除卷', targetType: 'volume' },
  'volume.prune': { label: '清理未使用卷', targetType: 'volume' },
  'network.prune': { label: '清理网络', targetType: 'network' },
  'compose.down': { label: '停止编排项目', targetType: 'compose' },
  'container.fix': { label: '修复容器配置', targetType: 'container' },
};

/** 审批记录行 */
export interface ApprovalRow {
  id: number;
  username: string;
  action_type: string;
  target: string;
  payload: string;
  status: ApprovalStatus;
  reason: string;
  result: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  /** 审批单编号（AP-YYYYMMDD-ID，1.3.0 起生成，存量记录惰性回填） */
  ticket_no?: string;
  /** 审批链总级数（1 = 单级；2 = 两级双签） */
  levels?: number;
  /** 已完成的审批级数 */
  level?: number;
  /** 审批轨迹（JSON 数组：每级的 decision/by/at/reason） */
  decisions?: string;
  /** 是否已推送过期前提醒（0/1） */
  reminded?: number;
}

/** 审批决策轨迹条目 */
interface DecisionEntry {
  decision: 'approved' | 'rejected';
  by: string;
  at: number;
  level: number;
  reason?: string;
}

/** 存量记录编号回填标记（进程内一次） */
let ticketBackfilled = false;

/**
 * 为存量审批记录回填编号（AP-YYYYMMDD-ID），幂等；仅在首次列表/提交时执行一次
 */
function ensureTicketBackfill(): void {
  if (ticketBackfilled) return;
  ticketBackfilled = true;
  try {
    getDb()
      .prepare(
        "UPDATE approvals SET ticket_no = 'AP-' || strftime('%Y%m%d', created_at / 1000, 'unixepoch') || '-' || id WHERE ticket_no = ''",
      )
      .run();
  } catch {
    // 回填失败不影响主流程
  }
}

/**
 * 动作所需的审批级数：settings.approval.twoStepActions（CSV）中列出的动作为 2 级，其余 1 级
 */
function levelsForAction(actionType: string): number {
  const csv = getSetting<string>('approval.twoStepActions') || '';
  const twoStep = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return twoStep.includes(actionType) ? 2 : 1;
}

/** 生成审批单编号：AP-YYYYMMDD-ID */
function ticketNoFor(id: number, createdAt: number): string {
  const d = new Date(createdAt);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `AP-${ymd}-${id}`;
}

/** 追加一条决策到轨迹 JSON */
function appendDecision(decisionsJson: string | null | undefined, entry: DecisionEntry): string {
  let arr: DecisionEntry[] = [];
  try {
    arr = JSON.parse(String(decisionsJson || '[]'));
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }
  arr.push(entry);
  return JSON.stringify(arr);
}

/**
 * 审批门禁是否启用（approvals.enabled 设置，默认关闭保持原有行为）
 */
export function isApprovalGateEnabled(): boolean {
  return getSetting<boolean>('approvals.enabled') === true;
}

/**
 * 推送审批事件到所有启用的通知渠道（尽力而为，失败静默，不影响审批主流程）。
 * 并行推送避免多渠道时串行拖长（每渠道 10s 超时）。
 */
async function notifyApprovalEvent(text: string): Promise<void> {
  try {
    const channels = listChannels().filter((ch) => ch.enabled);
    await Promise.allSettled(channels.map((ch) => sendAlert(ch.id, text)));
  } catch {
    // 通知失败静默
  }
}

/**
 * 过期未处理的待审批自动作废（留痕为 cancelled + 超时说明）。
 * 在查询列表与提交门禁前惰性调用，避免待审批无限堆积。
 * 超时阈值取自设置 approvals.ttlHours（小时，0 表示不过期）。
 */
export function expireStaleApprovals(): void {
  const ttl = Number(getSetting<number>('approvals.ttlHours'));
  if (!Number.isFinite(ttl) || ttl <= 0) return;
  const cutoff = Date.now() - ttl * 3600_000;
  getDb()
    .prepare(
      "UPDATE approvals SET status = 'cancelled', decided_at = ?, decided_by = '系统', result = ? WHERE status = 'pending' AND created_at < ?",
    )
    .run(Date.now(), `待审批超时（超过 ${ttl} 小时未处理），已自动过期`, cutoff);
}

/**
 * 待审批超时前提醒：处理截止时间剩余不足 1/4 时推送一次提醒（每条记录只提醒一次）。
 * 由 startApprovalReminder 定时调用；TTL 未启用（0）时不提醒。
 * @returns 本轮提醒的记录数
 */
export function remindPendingApprovals(): number {
  const ttl = Number(getSetting<number>('approvals.ttlHours'));
  if (!Number.isFinite(ttl) || ttl <= 0) return 0;
  const remindBefore = Date.now() - ttl * 0.75 * 3600_000;
  let rows: ApprovalRow[] = [];
  try {
    rows = getDb()
      .prepare(
        "SELECT id, ticket_no, username, action_type FROM approvals WHERE status = 'pending' AND reminded = 0 AND created_at < ?",
      )
      .all(remindBefore) as unknown as ApprovalRow[];
  } catch {
    return 0;
  }
  for (const row of rows) {
    const hoursLeft = Math.max(0, Math.round(ttl - (Date.now() - row.created_at) / 3600_000));
    void notifyApprovalEvent(
      `【审批催办】单号 ${row.ticket_no || row.id}（${row.username} 申请的「${GATE_ACTIONS[row.action_type]?.label || row.action_type}」）已等待较久，约 ${hoursLeft} 小时后自动过期，请尽快处理`,
    );
    try {
      getDb().prepare('UPDATE approvals SET reminded = 1 WHERE id = ?').run(row.id);
    } catch {
      // 置位失败不影响其余记录
    }
  }
  return rows.length;
}

let reminderStarted = false;

/**
 * 启动审批提醒定时器（幂等）：每 60 秒执行一次过期清理 + 超时前提醒
 */
export function startApprovalReminder(): void {
  if (reminderStarted) return;
  reminderStarted = true;
  const tick = () => {
    try {
      expireStaleApprovals();
      remindPendingApprovals();
    } catch {
      // 定时任务失败静默
    }
  };
  tick();
  const timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
  console.log('[approvals] 审批超时提醒已启动 (间隔 60s)');
}

/** 审批动作 -> RBAC 权限键映射（角色持有该权限时可不经审批直接执行） */
const GATE_PERM_MAP: Record<string, string> = {
  'container.delete': 'containers.delete',
  'image.delete': 'images.delete',
  'image.deleteBatch': 'images.delete',
  'image.prune': 'images.prune',
  'volume.delete': 'volumes.delete',
  'volume.prune': 'volumes.prune',
  'network.prune': 'networks.prune',
  'compose.down': 'compose.down',
};

/**
 * 判断当前请求是否应被审批门禁拦截
 * @param role 请求用户角色（持有对应直接执行权限——含 admin——的角色放行）
 * @param actionType 动作类型（须在 GATE_ACTIONS 中）
 */
export function shouldGate(role: string | undefined, actionType: string): boolean {
  if (!isApprovalGateEnabled()) return false;
  if (!(actionType in GATE_ACTIONS)) return false;
  if (role === 'admin') return false;
  const perm = GATE_PERM_MAP[actionType];
  if (perm && hasPermission(role, perm)) return false;
  return true;
}

/**
 * 提交审批请求；同一提交人对同一动作+目标的待审批请求自动去重
 * @returns 审批记录 id
 */
export function submitApproval(input: {
  username: string;
  actionType: string;
  target: string;
  payload?: Record<string, unknown>;
  reason?: string;
}): { id: number; reused: boolean; ticketNo: string } {
  ensureTicketBackfill();
  const d = getDb();
  const existing = d
    .prepare(
      "SELECT id, ticket_no FROM approvals WHERE username = ? AND action_type = ? AND target = ? AND status = 'pending' LIMIT 1",
    )
    .get(input.username, input.actionType, input.target) as { id: number; ticket_no: string } | undefined;
  if (existing) return { id: existing.id, reused: true, ticketNo: existing.ticket_no };

  const label = GATE_ACTIONS[input.actionType]?.label || input.actionType;
  const levels = levelsForAction(input.actionType);
  const r = d
    .prepare(
      'INSERT INTO approvals (username, action_type, target, payload, status, reason, created_at, levels) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.username,
      input.actionType,
      input.target,
      JSON.stringify(input.payload || {}),
      'pending',
      input.reason || label,
      Date.now(),
      levels,
    );
  const id = Number(r.lastInsertRowid);
  const ticketNo = ticketNoFor(id, Date.now());
  d.prepare('UPDATE approvals SET ticket_no = ? WHERE id = ?').run(ticketNo, id);
  // 通知所有启用渠道：有新审批待处理（目标解析为容器名等可读标识）
  void (async () => {
    const shown = await resolveTargetLabel(input.actionType, input.target).catch(() => input.target);
    await notifyApprovalEvent(
      `【审批提醒】用户 ${input.username} 申请「${label}」（单号 ${ticketNo}${levels > 1 ? `，需 ${levels} 级审批` : ''}），目标：${shown || input.target}，请到面板「审批中心」处理`,
    );
  })();
  return { id, reused: false, ticketNo };
}

/**
 * 查询审批列表
 * @param opts.username 限定提交人（非管理员查自己）
 * @param status 限定状态（缺省全部）
 */
export function listApprovals(username?: string, status?: string): ApprovalRow[] {
  ensureTicketBackfill();
  const d = getDb();
  expireStaleApprovals();
  const conditions: string[] = [];
  const params: any[] = [];
  if (username) {
    conditions.push('username = ?');
    params.push(username);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return d
    .prepare(
      `SELECT id, username, action_type, target, payload, status, reason, result, created_at, decided_at, decided_by,
              ticket_no, levels, level, decisions, reminded
       FROM approvals ${where} ORDER BY id DESC LIMIT 200`,
    )
    .all(...params) as unknown as ApprovalRow[];
}

/** 审批记录视图行（附展示用目标标签） */
export interface ApprovalRowView extends ApprovalRow {
  /** 人类可读的目标标识（容器名 / 镜像名等），解析失败时为短 ID */
  target_label: string;
}

/**
 * 解析展示用目标标签：容器 ID 解析为容器名（容器已删除或引擎不可达时回退短 ID）
 */
async function resolveTargetLabel(actionType: string, target: string): Promise<string> {
  if (!target || target === 'all') return target;
  if (actionType === 'container.delete') {
    try {
      const docker = await getDockerClient();
      const info = await docker.getContainer(target).inspect();
      const name = (info.Name || '').replace(/^\//, '');
      if (name) return name;
    } catch {
      // 容器不存在（已删除）或引擎不可达：回退短 ID 展示
    }
    return target.length > 24 ? target.slice(0, 12) : target;
  }
  return target;
}

/**
 * 查询审批列表并解析展示标签（目标列显示容器名等人类可读标识，而非原始 ID）
 */
export async function listApprovalsView(username?: string, status?: string): Promise<ApprovalRowView[]> {
  const rows = listApprovals(username, status);
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      target_label: await resolveTargetLabel(row.action_type, row.target),
    })),
  );
}

/**
 * 审批统计：近 days 天按状态汇总、按动作类型分布、按提交人分布、执行质量
 * @param days 统计回溯天数（默认 30，1-365）
 */
export function getApprovalStats(days = 30): {
  since: number;
  totals: { total: number; pending: number; approved: number; rejected: number; cancelled: number; executedOk: number; executedFail: number };
  byAction: Array<{ actionType: string; label: string; total: number; approved: number; rejected: number; pending: number }>;
  byUser: Array<{ username: string; total: number; approved: number; rejected: number; pending: number }>;
} {
  const window = Math.max(1, Math.min(365, days));
  const since = Date.now() - window * 86400_000;
  const d = getDb();

  const totalsRow = d
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
              SUM(CASE WHEN status = 'approved' AND result LIKE '执行成功%' THEN 1 ELSE 0 END) AS executedOk,
              SUM(CASE WHEN status = 'approved' AND result LIKE '执行失败%' THEN 1 ELSE 0 END) AS executedFail
       FROM approvals WHERE created_at >= ?`,
    )
    .get(since) as any;

  const actionRows = d
    .prepare(
      `SELECT action_type,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM approvals WHERE created_at >= ? GROUP BY action_type ORDER BY total DESC`,
    )
    .all(since) as unknown as Array<{ action_type: string; total: number; approved: number; rejected: number; pending: number }>;

  const userRows = d
    .prepare(
      `SELECT username,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM approvals WHERE created_at >= ? GROUP BY username ORDER BY total DESC LIMIT 10`,
    )
    .all(since) as unknown as Array<{ username: string; total: number; approved: number; rejected: number; pending: number }>;

  return {
    since,
    totals: {
      total: Number(totalsRow?.total ?? 0),
      pending: Number(totalsRow?.pending ?? 0),
      approved: Number(totalsRow?.approved ?? 0),
      rejected: Number(totalsRow?.rejected ?? 0),
      cancelled: Number(totalsRow?.cancelled ?? 0),
      executedOk: Number(totalsRow?.executedOk ?? 0),
      executedFail: Number(totalsRow?.executedFail ?? 0),
    },
    byAction: actionRows.map((r) => ({
      actionType: r.action_type,
      label: GATE_ACTIONS[r.action_type]?.label || r.action_type,
      total: Number(r.total),
      approved: Number(r.approved),
      rejected: Number(r.rejected),
      pending: Number(r.pending),
    })),
    byUser: userRows.map((r) => ({
      username: r.username,
      total: Number(r.total),
      approved: Number(r.approved),
      rejected: Number(r.rejected),
      pending: Number(r.pending),
    })),
  };
}

/**
 * 导出用：按状态查询全部审批记录（不受列表 200 条截断限制）
 * @param username 限定提交人（非管理员查自己）
 */
export function listAllApprovals(username?: string, status?: string): ApprovalRow[] {
  expireStaleApprovals();
  const conditions: string[] = [];
  const params: any[] = [];
  if (username) {
    conditions.push('username = ?');
    params.push(username);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return getDb()
    .prepare(
      `SELECT id, username, action_type, target, payload, status, reason, result, created_at, decided_at, decided_by
       FROM approvals ${where} ORDER BY id DESC`,
    )
    .all(...params) as unknown as ApprovalRow[];
}

/** CSV 字段转义（含引号/逗号/换行的字段用双引号包裹） */
function csvField(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 渲染审批记录 CSV（UTF-8 BOM 便于 Excel 识别中文）
 */
export function renderApprovalsCsv(rows: ApprovalRow[]): string {
  const esc = (v: unknown) => csvField(v);
  const header = 'ID,提交人,动作类型,目标,状态,理由,结果,提交时间,审批时间,审批人';
  const body = rows
    .map((r) =>
      [
        r.id,
        r.username,
        r.action_type,
        r.target,
        r.status,
        r.reason,
        r.result || '',
        new Date(r.created_at).toISOString(),
        r.decided_at ? new Date(r.decided_at).toISOString() : '',
        r.decided_by || '',
      ]
        .map(esc)
        .join(','),
    )
    .join('\n');
  return `\ufeff${header}\n${body}\n`;
}

/**
 * 审批决定：批准则立即执行目标操作，拒绝仅留档
 * @returns 执行结果（批准时）
 * @throws 审批记录不存在/状态不对时抛 404/400
 */
export async function decideApproval(
  id: number,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  reason?: string,
  decidedRole: string = 'admin',
): Promise<{ executed: boolean; result?: string; error?: string; advanced?: boolean }> {
  const d = getDb();
  const row = d.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  if (!row) throw Object.assign(new Error('审批记录不存在'), { statusCode: 404 });
  if (row.status !== 'pending') {
    throw Object.assign(new Error('该审批已处理，不可重复操作'), { statusCode: 400 });
  }

  const levels = Math.max(1, Number(row.levels) || 1);
  const curLevel = Number(row.level) || 0;

  // 末级审批必须由管理员签批（中间级允许运维或管理员）
  if (curLevel + 1 >= levels && decidedRole !== 'admin') {
    throw Object.assign(new Error('该审批为末级审批，需要管理员权限'), { statusCode: 403 });
  }

  if (decision === 'rejected') {
    const decisions = appendDecision(row.decisions, {
      decision,
      by: decidedBy,
      at: Date.now(),
      level: curLevel + 1,
      reason,
    });
    d.prepare(
      'UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, result = ?, level = ?, decisions = ? WHERE id = ?',
    ).run('rejected', Date.now(), decidedBy, reason || '已拒绝', curLevel + 1, decisions, id);
    void notifyApprovalEvent(
      `【审批结果】用户 ${row.username} 提交的「${GATE_ACTIONS[row.action_type]?.label || row.action_type}」（单号 ${row.ticket_no || id}）申请已被 ${decidedBy} 拒绝${reason ? `：${reason}` : ''}`,
    );
    return { executed: false };
  }

  // 多级审批：未到末级时仅推进级数、保持待审批，等待下一级签批
  if (curLevel + 1 < levels) {
    const decisions = appendDecision(row.decisions, {
      decision,
      by: decidedBy,
      at: Date.now(),
      level: curLevel + 1,
      reason,
    });
    d.prepare('UPDATE approvals SET level = ?, decisions = ?, reminded = 0 WHERE id = ?').run(
      curLevel + 1,
      decisions,
      id,
    );
    void notifyApprovalEvent(
      `【审批进度】${row.ticket_no || `#${id}`}「${GATE_ACTIONS[row.action_type]?.label || row.action_type}」第 ${curLevel + 1}/${levels} 级已由 ${decidedBy} 通过，等待下一级审批`,
    );
    return { executed: false, advanced: true };
  }

  // 批准：先落状态再执行，执行失败把错误写入 result（不回滚状态，留档排查）
  const decisions = appendDecision(row.decisions, {
    decision,
    by: decidedBy,
    at: Date.now(),
    level: curLevel + 1,
    reason,
  });
  d.prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, result = ?, level = ?, decisions = ? WHERE id = ?').run(
    'approved',
    Date.now(),
    decidedBy,
    reason || '',
    curLevel + 1,
    decisions,
    id,
  );
  try {
    const payload = safeParse(row.payload);
    const output = await runExecutor(row.action_type, row.target, payload);
    d.prepare('UPDATE approvals SET result = ? WHERE id = ?').run(
      `执行成功${output ? `：${output}` : ''}`,
      id,
    );
    // 来源为 AI 操作建议时，回写对应 ai_action 的最终状态（闭环）
    if (payload.aiActionId) {
      try {
        markExecuted(Number(payload.aiActionId), `审批单 #${id} 已由 ${decidedBy} 批准并执行成功${output ? `：${output}` : ''}`, true);
      } catch {
        // 回写失败不影响审批结果
      }
    }
    void notifyApprovalEvent(
      `【审批结果】用户 ${row.username} 提交的「${GATE_ACTIONS[row.action_type]?.label || row.action_type}」（单号 ${row.ticket_no || id}）申请已由 ${decidedBy} 批准并执行成功`,
    );
    return { executed: true, error: undefined };
  } catch (err: any) {
    const msg = err?.json?.message || err?.message || String(err);
    d.prepare('UPDATE approvals SET result = ? WHERE id = ?').run(`执行失败：${msg}`, id);
    // 来源为 AI 操作建议时，同样回写失败状态
    if (safeParse(row.payload).aiActionId) {
      try {
        markExecuted(Number(safeParse(row.payload).aiActionId), `审批单 #${id} 执行失败：${msg}`, false);
      } catch {
        // 回写失败不影响审批结果
      }
    }
    void notifyApprovalEvent(
      `【审批结果】用户 ${row.username} 提交的「${GATE_ACTIONS[row.action_type]?.label || row.action_type}」（单号 ${row.ticket_no || id}）申请已由 ${decidedBy} 批准，但执行失败：${msg}`,
    );
    return { executed: false, error: msg };
  }
}

/**
 * 按动作类型分发到执行器
 * @throws 未注册的动作类型抛 400
 */
export async function runExecutor(
  actionType: string,
  target: string,
  payload: Record<string, any> = {},
): Promise<string | void> {
  const fn = executors[actionType];
  if (!fn) throw Object.assign(new Error(`未注册的审批动作: ${actionType}`), { statusCode: 400 });
  return fn(target, payload);
}

/**
 * 撤销自己的待审批请求
 * @throws 不存在/非本人/非待审批时抛 404/403/400
 */
export function cancelApproval(id: number, username: string, isAdmin = false): void {
  const d = getDb();
  const row = d.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  if (!row) throw Object.assign(new Error('审批记录不存在'), { statusCode: 404 });
  if (!isAdmin && row.username !== username) {
    throw Object.assign(new Error('只能撤销自己提交的审批'), { statusCode: 403 });
  }
  if (row.status !== 'pending') {
    throw Object.assign(new Error('仅待审批记录可撤销'), { statusCode: 400 });
  }
  d.prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, result = ? WHERE id = ?').run(
    'cancelled',
    Date.now(),
    decidedBy(username, isAdmin),
    '提交人撤销',
    id,
  );
}

/** 撤销操作的 decided_by 归属 */
function decidedBy(username: string, isAdmin: boolean): string {
  return isAdmin ? `${username}（管理员）` : username;
}

/** 安全解析 payload JSON */
function safeParse(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/**
 * 执行器注册表：action_type -> 实际 Docker 操作
 * @returns 人类可读的执行结果摘要（可为空）
 */
type Executor = (target: string, payload: Record<string, any>) => Promise<string | void>;

const executors: Record<string, Executor> = {
  'container.delete': async (target, payload) => {
    const docker = await getDockerClient();
    await docker.getContainer(target).remove({ force: !!payload.force, v: !!payload.v });
    return `容器 ${target} 已删除`;
  },
  'image.delete': async (target) => {
    const docker = await getDockerClient();
    await docker.getImage(target).remove({ force: false });
    return `镜像 ${target} 已删除`;
  },
  'image.deleteBatch': async (_target, payload) => {
    const docker = await getDockerClient();
    const names = Array.isArray(payload.names) ? payload.names.map(String) : [];
    let ok = 0;
    const fails: string[] = [];
    for (const n of names) {
      try {
        await docker.getImage(n).remove({ force: true });
        ok++;
      } catch {
        fails.push(n);
      }
    }
    return `批量删除镜像：成功 ${ok}/${names.length}${fails.length ? `，失败：${fails.join(', ')}` : ''}`;
  },
  'image.prune': async (_target, payload) => {
    // 动态导入避免模块加载环（images 路由静态依赖 approvals 门禁）
    const { pruneImagesInternal } = await import('./routes/images');
    const r = await pruneImagesInternal(payload.all === true);
    return `已清理 ${r.deleted.length} 个${payload.all === true ? '未使用' : '悬空'}镜像`;
  },
  'volume.delete': async (target) => {
    const docker = await getDockerClient();
    await docker.getVolume(target).remove();
    return `卷 ${target} 已删除`;
  },
  'volume.prune': async () => {
    const docker = await getDockerClient();
    const r = await docker.pruneVolumes();
    const n = Array.isArray(r?.VolumesDeleted) ? r.VolumesDeleted.length : 0;
    return `已清理 ${n} 个未使用卷`;
  },
  'network.prune': async () => {
    const docker = await getDockerClient();
    const r = await docker.pruneNetworks();
    const n = Array.isArray(r?.NetworksDeleted) ? r.NetworksDeleted.length : 0;
    return `已清理 ${n} 个未使用网络`;
  },
  'compose.down': async (target, payload) => {
    // 动态导入避免模块加载环（compose 路由静态依赖 approvals 门禁）
    const { composeProjectDown } = await import('./routes/compose');
    const out = await composeProjectDown(target, payload.volumes === true);
    const text = String(out || '').trim();
    return text ? `编排项目 ${target} 已停止：${text.slice(0, 300)}` : `编排项目 ${target} 已停止`;
  },
  'container.fix': async (target, payload) => {
    // 动态导入避免模块加载环（policy → scheduler / approvals → policy）
    const { applyPolicyFix } = await import('./policy');
    const r = await applyPolicyFix(String(payload.containerId || target), String(payload.ruleId || ''), payload.params || {});
    if (!r.ok) throw new Error(r.message);
    return r.message;
  },
};

/**
 * 供路由层读取执行器（测试与扩展用）
 */
export function hasExecutor(actionType: string): boolean {
  return actionType in executors;
}

/**
 * 危险操作门禁：在路由处理器开头调用。
 * - 审批流未开启，或当前用户是管理员 -> 返回 false（继续直接执行）
 * - 审批流开启且非管理员 -> 自动生成待审批记录，响应 202，返回 true
 *
 * @param req Express 请求（须已过 requireAuth，res.locals.username 可用）
 * @param res 响应对象（被门禁拦截时发送 202）
 * @param actionType 动作类型（须在 GATE_ACTIONS 中）
 * @param target 目标标识
 * @param payload 执行参数（审批通过后原样交给执行器）
 * @returns true 表示已转为审批（调用方应直接 return）
 */
export function maybeGate(
  req: Request,
  res: Response,
  actionType: string,
  target: string,
  payload: Record<string, unknown> = {},
): boolean {
  if (!shouldGate(res.locals.user?.role, actionType)) return false;
  expireStaleApprovals();
  const { id, reused, ticketNo } = submitApproval({
    username: res.locals.username,
    actionType,
    target,
    payload,
    reason: GATE_ACTIONS[actionType]?.label || '',
  });
  res.status(202).json({ approvalPending: true, approvalId: id, reused, ticketNo });
  return true;
}

/**
 * 管理员专属危险操作的统一门禁：路由以 requireAuth + 本函数替代 requireAdmin。
 * - 管理员 -> 返回 false，继续直接执行
 * - 非管理员 + 审批流开启 -> 转为待审批记录并响应 202，返回 true
 * - 非管理员 + 审批流关闭 -> 响应 403（保持「非管理员不可执行」的默认安全姿态）
 *
 * @returns true 表示已响应（调用方应直接 return）
 */
export function maybeGateOrForbidden(
  req: Request,
  res: Response,
  actionType: string,
  target: string,
  payload: Record<string, unknown> = {},
): boolean {
  if (res.locals.user?.role === 'admin') return false;
  const perm = GATE_PERM_MAP[actionType];
  if (perm && hasPermission(res.locals.user?.role, perm)) return false;
  if (!isApprovalGateEnabled() || !(actionType in GATE_ACTIONS)) {
    res.status(403).json({ error: '需要管理员权限（或在系统设置中开启审批流后提交审批）' });
    return true;
  }
  return maybeGate(req, res, actionType, target, payload);
}
