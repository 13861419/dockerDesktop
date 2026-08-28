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

/** 审批状态 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** 可触发审批门禁的危险动作类型 */
export const GATE_ACTIONS: Record<string, { label: string; targetType: string }> = {
  'container.delete': { label: '删除容器', targetType: 'container' },
  'image.delete': { label: '删除镜像', targetType: 'image' },
  'volume.delete': { label: '删除卷', targetType: 'volume' },
  'network.prune': { label: '清理网络', targetType: 'network' },
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
 * 判断当前请求是否应被审批门禁拦截
 * @param role 请求用户角色（管理员直接放行）
 * @param actionType 动作类型（须在 GATE_ACTIONS 中）
 */
export function shouldGate(role: string | undefined, actionType: string): boolean {
  if (!isApprovalGateEnabled()) return false;
  if (role === 'admin') return false;
  return actionType in GATE_ACTIONS;
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
}): { id: number; reused: boolean } {
  const d = getDb();
  const existing = d
    .prepare(
      "SELECT id FROM approvals WHERE username = ? AND action_type = ? AND target = ? AND status = 'pending' LIMIT 1",
    )
    .get(input.username, input.actionType, input.target) as { id: number } | undefined;
  if (existing) return { id: existing.id, reused: true };

  const label = GATE_ACTIONS[input.actionType]?.label || input.actionType;
  const r = d
    .prepare(
      'INSERT INTO approvals (username, action_type, target, payload, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.username,
      input.actionType,
      input.target,
      JSON.stringify(input.payload || {}),
      'pending',
      input.reason || label,
      Date.now(),
    );
  const id = Number(r.lastInsertRowid);
  // 通知所有启用渠道：有新审批待处理（目标解析为容器名等可读标识）
  void (async () => {
    const shown = await resolveTargetLabel(input.actionType, input.target).catch(() => input.target);
    await notifyApprovalEvent(
      `【审批提醒】用户 ${input.username} 申请「${label}」，目标：${shown || input.target}，请到面板「审批中心」处理`,
    );
  })();
  return { id, reused: false };
}

/**
 * 查询审批列表
 * @param opts.username 限定提交人（非管理员查自己）
 * @param status 限定状态（缺省全部）
 */
export function listApprovals(username?: string, status?: string): ApprovalRow[] {
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
      `SELECT id, username, action_type, target, payload, status, reason, result, created_at, decided_at, decided_by
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
 * 审批决定：批准则立即执行目标操作，拒绝仅留档
 * @returns 执行结果（批准时）
 * @throws 审批记录不存在/状态不对时抛 404/400
 */
export async function decideApproval(
  id: number,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  reason?: string,
): Promise<{ executed: boolean; result?: string; error?: string }> {
  const d = getDb();
  const row = d.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  if (!row) throw Object.assign(new Error('审批记录不存在'), { statusCode: 404 });
  if (row.status !== 'pending') {
    throw Object.assign(new Error('该审批已处理，不可重复操作'), { statusCode: 400 });
  }

  if (decision === 'rejected') {
    d.prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, result = ? WHERE id = ?').run(
      'rejected',
      Date.now(),
      decidedBy,
      reason || '已拒绝',
      id,
    );
    void notifyApprovalEvent(
      `【审批结果】用户 ${row.username} 提交的「${GATE_ACTIONS[row.action_type]?.label || row.action_type}」申请已被 ${decidedBy} 拒绝${reason ? `：${reason}` : ''}`,
    );
    return { executed: false };
  }

  // 批准：先落状态再执行，执行失败把错误写入 result（不回滚状态，留档排查）
  d.prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, result = ? WHERE id = ?').run(
    'approved',
    Date.now(),
    decidedBy,
    reason || '',
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
      `【审批结果】用户 ${row.username} 提交的「${GATE_ACTIONS[row.action_type]?.label || row.action_type}」申请已由 ${decidedBy} 批准并执行成功`,
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
      `【审批结果】用户 ${row.username} 提交的「${GATE_ACTIONS[row.action_type]?.label || row.action_type}」申请已由 ${decidedBy} 批准，但执行失败：${msg}`,
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
  'volume.delete': async (target) => {
    const docker = await getDockerClient();
    await docker.getVolume(target).remove();
    return `卷 ${target} 已删除`;
  },
  'network.prune': async () => {
    const docker = await getDockerClient();
    const r = await docker.pruneNetworks();
    const n = Array.isArray(r?.NetworksDeleted) ? r.NetworksDeleted.length : 0;
    return `已清理 ${n} 个未使用网络`;
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
  const { id, reused } = submitApproval({
    username: res.locals.username,
    actionType,
    target,
    payload,
    reason: GATE_ACTIONS[actionType]?.label || '',
  });
  res.status(202).json({ approvalPending: true, approvalId: id, reused });
  return true;
}
