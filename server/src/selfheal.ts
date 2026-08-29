/**
 * 容器自愈服务（0.5.0）
 *
 * 按规则在后台周期巡检容器状态，命中条件时自动执行恢复动作：
 *  - watch_type = unhealthy：容器健康检查失败（State.Health.Status === 'unhealthy'）→ 执行动作
 *  - watch_type = exited：容器退出/死亡（State.Status ∈ {exited, dead}）→ 执行动作
 *  - action：restart（重启）/ start（启动）
 *
 * 防重：规则级冷却期（cooldown_sec），冷却窗口内同一规则不重复触发。
 * 留痕：每次触发写入 alert_records（type = selfheal）并按级别推送到通知渠道
 *（成功 → recovery，失败 → danger），复用多渠道路由策略。
 */
import { getDb } from './storage';
import { getDockerClient } from './docker/client';
import { resolveTargetChannels, pushToTargets } from './alerting';
import type { ChannelInfo } from './notify';

/** 巡检间隔：与告警检测同节奏（10s） */
const TICK_MS = 10000;

/** 自愈监控类型 */
export type SelfHealWatchType = 'unhealthy' | 'exited';
/** 自愈动作 */
export type SelfHealAction = 'restart' | 'start';

/** 规则行（数据库） */
interface SelfHealRuleRow {
  id: number;
  container_name: string;
  watch_type: string;
  action: string;
  cooldown_sec: number;
  enabled: number;
  last_triggered_at: number | null;
  created_at: number;
  updated_at: number;
}

/** 归一化规则（对外） */
export interface SelfHealRule {
  id: number;
  containerName: string;
  watchType: SelfHealWatchType;
  action: SelfHealAction;
  cooldownSec: number;
  enabled: boolean;
  lastTriggeredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function normalizeRule(r: SelfHealRuleRow): SelfHealRule {
  return {
    id: r.id,
    containerName: r.container_name,
    watchType: r.watch_type as SelfHealWatchType,
    action: r.action as SelfHealAction,
    cooldownSec: Math.max(10, Math.floor(Number(r.cooldown_sec) || 300)),
    enabled: r.enabled === 1,
    lastTriggeredAt: r.last_triggered_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 判定规则在当前容器状态下是否应触发（纯函数，便于单测）
 * @param cooldown 判定参数：冷却秒数与上次触发时间
 * @param watchType 监控类型
 * @param state 容器 State.Status
 * @param health 容器 State.Health.Status（无 healthcheck 为 'none'）
 * @param now 当前时间戳
 * @returns hit=是否应执行动作；reason=说明（用于日志）
 */
export function shouldTrigger(
  cooldown: { cooldownSec: number; lastTriggeredAt: number | null },
  watchType: SelfHealWatchType,
  state: string,
  health: string,
  now: number,
): { hit: boolean; reason: string } {
  let hit = false;
  if (watchType === 'unhealthy') {
    hit = health === 'unhealthy';
  } else if (watchType === 'exited') {
    hit = state === 'exited' || state === 'dead';
  }
  if (!hit) return { hit: false, reason: '状态未命中' };
  if (cooldown.lastTriggeredAt && now - cooldown.lastTriggeredAt < cooldown.cooldownSec * 1000) {
    return { hit: false, reason: '冷却期内' };
  }
  return { hit: true, reason: '命中且超出冷却期' };
}

/** 读取全部规则（按创建时间倒序） */
export function listSelfHealRules(): SelfHealRule[] {
  const rows = getDb()
    .prepare('SELECT * FROM selfheal_rules ORDER BY id DESC')
    .all() as unknown as SelfHealRuleRow[];
  return rows.map(normalizeRule);
}

/** 读取单条规则 */
function getRuleRow(id: number): SelfHealRuleRow | undefined {
  return getDb().prepare('SELECT * FROM selfheal_rules WHERE id = ?').get(id) as
    | SelfHealRuleRow
    | undefined;
}

/** 校验并归一化规则输入 */
function validateInput(body: any, forUpdate = false): {
  containerName: string;
  watchType: SelfHealWatchType;
  action: SelfHealAction;
  cooldownSec: number;
  enabled: number;
} {
  const containerName = String(forUpdate ? (body?.containerName ?? '') : body?.containerName || '').trim();
  if (forUpdate && body?.containerName === undefined) {
    // 更新时未传保持原值（由调用方兜底）
  } else if (!containerName) {
    throw Object.assign(new Error('请输入容器名'), { statusCode: 400 });
  }
  const watchType = String(body?.watchType ?? '') as SelfHealWatchType;
  if (watchType && !['unhealthy', 'exited'].includes(watchType)) {
    throw Object.assign(new Error('监控类型需为 unhealthy 或 exited'), { statusCode: 400 });
  }
  const action = String(body?.action ?? '') as SelfHealAction;
  if (action && !['restart', 'start'].includes(action)) {
    throw Object.assign(new Error('动作需为 restart 或 start'), { statusCode: 400 });
  }
  let cooldownSec = 300;
  if (body?.cooldownSec !== undefined) {
    cooldownSec = Math.floor(Number(body.cooldownSec));
    if (!Number.isFinite(cooldownSec) || cooldownSec < 10 || cooldownSec > 86400) {
      throw Object.assign(new Error('冷却期需为 10-86400 秒'), { statusCode: 400 });
    }
  }
  const enabled = body?.enabled === undefined ? 1 : body.enabled ? 1 : 0;
  return {
    containerName,
    watchType: watchType || undefined!,
    action: action || undefined!,
    cooldownSec,
    enabled,
  };
}

/**
 * 新增自愈规则（同名容器同监控类型去重）
 */
export function createSelfHealRule(body: any): SelfHealRule {
  const v = validateInput(body);
  if (!v.containerName) throw Object.assign(new Error('请输入容器名'), { statusCode: 400 });
  if (!v.watchType) throw Object.assign(new Error('请选择监控类型'), { statusCode: 400 });
  if (!v.action) throw Object.assign(new Error('请选择恢复动作'), { statusCode: 400 });
  const d = getDb();
  const dup = d
    .prepare('SELECT id FROM selfheal_rules WHERE container_name = ? AND watch_type = ?')
    .get(v.containerName, v.watchType);
  if (dup) throw Object.assign(new Error('该容器已存在同类型的自愈规则'), { statusCode: 409 });
  const now = Date.now();
  const info = d
    .prepare(
      'INSERT INTO selfheal_rules (container_name, watch_type, action, cooldown_sec, enabled, last_triggered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
    )
    .run(v.containerName, v.watchType, v.action, v.cooldownSec, v.enabled, now, now);
  return normalizeRule(getRuleRow(Number(info.lastInsertRowid))!);
}

/**
 * 更新自愈规则
 */
export function updateSelfHealRule(id: number, body: any): SelfHealRule {
  const row = getRuleRow(id);
  if (!row) throw Object.assign(new Error('自愈规则不存在'), { statusCode: 404 });
  const v = validateInput(body, true);
  const next = {
    container_name: body?.containerName !== undefined ? v.containerName || row.container_name : row.container_name,
    watch_type: v.watchType ?? row.watch_type,
    action: v.action ?? row.action,
    cooldown_sec: body?.cooldownSec !== undefined ? v.cooldownSec : row.cooldown_sec,
    enabled: body?.enabled !== undefined ? v.enabled : row.enabled,
  };
  if (!next.container_name) throw Object.assign(new Error('请输入容器名'), { statusCode: 400 });
  getDb()
    .prepare(
      'UPDATE selfheal_rules SET container_name = ?, watch_type = ?, action = ?, cooldown_sec = ?, enabled = ?, updated_at = ? WHERE id = ?',
    )
    .run(next.container_name, next.watch_type, next.action, next.cooldown_sec, next.enabled, Date.now(), id);
  return normalizeRule(getRuleRow(id)!);
}

/**
 * 删除自愈规则
 */
export function deleteSelfHealRule(id: number): void {
  const r = getDb().prepare('DELETE FROM selfheal_rules WHERE id = ?').run(id);
  if (r.changes === 0) throw Object.assign(new Error('自愈规则不存在'), { statusCode: 404 });
}

/**
 * 写入自愈留痕（alert_records，type=selfheal）并推送到通知渠道
 * @param level recovery（成功）/ danger（失败）
 */
async function recordAndPush(level: 'recovery' | 'danger', message: string): Promise<void> {
  const targets = resolveTargetChannels(level);
  const channelId = targets.length ? targets.map((t) => t.id).join(',') : null;
  let pushStatus = 'none';
  let pushDetail: string | null = null;
  if (targets.length) {
    const res = await pushToTargets(level, message);
    pushStatus = res.ok ? 'ok' : 'failed';
    pushDetail = res.ok ? null : res.detail;
  }
  const d = getDb();
  d.prepare(
    'INSERT INTO alert_records (type, level, message, value, channel_id, push_status, push_detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('selfheal', level, message, null, channelId, pushStatus, pushDetail, Date.now());
  try {
    d.prepare('DELETE FROM alert_records WHERE id NOT IN (SELECT id FROM alert_records ORDER BY id DESC LIMIT 800)').run();
  } catch {
    // 忽略清理失败
  }
}

/** 执行单个容器恢复动作 */
async function applyAction(
  action: SelfHealAction,
  containerId: string,
): Promise<void> {
  const container = (await getDockerClient()).getContainer(containerId);
  if (action === 'restart') {
    await container.restart();
  } else {
    await container.start();
  }
}

/** 动作中文描述 */
const ACTION_LABELS: Record<SelfHealAction, string> = { restart: '重启', start: '启动' };
/** 命中原因中文描述 */
const WATCH_LABELS: Record<SelfHealWatchType, string> = {
  unhealthy: '健康检查失败（unhealthy）',
  exited: '容器已退出',
};

/**
 * 巡检全部启用的自愈规则：命中即执行动作，带冷却期防重
 * @returns 本轮实际触发动作的规则数
 */
export async function runSelfHealCheck(): Promise<{ triggered: number }> {
  const rules = listSelfHealRules().filter((r) => r.enabled);
  if (rules.length === 0) return { triggered: 0 };
  const docker = await getDockerClient();
  let triggered = 0;
  const now = Date.now();
  for (const rule of rules) {
    try {
      // 按名称解析容器（取首个精确匹配）
      const list = (await docker.listContainers({ all: true }).catch(() => [])) as any[];
      const found = list.find((c) =>
        (c.Names || []).some((n: string) => n.replace(/^\//, '') === rule.containerName),
      );
      if (!found) continue;
      let info: any;
      try {
        info = await docker.getContainer(found.Id).inspect();
      } catch {
        continue;
      }
      const state = info?.State?.Status || '';
      const health = info?.State?.Health?.Status || 'none';
      const decision = shouldTrigger(
        { cooldownSec: rule.cooldownSec, lastTriggeredAt: rule.lastTriggeredAt },
        rule.watchType,
        state,
        health,
        now,
      );
      if (!decision.hit) continue;
      getDb()
        .prepare('UPDATE selfheal_rules SET last_triggered_at = ? WHERE id = ?')
        .run(now, rule.id);
      triggered++;
      const head = `Docker 面板【自愈】容器 ${rule.containerName} ${WATCH_LABELS[rule.watchType]}`;
      try {
        await applyAction(rule.action, found.Id);
        await recordAndPush('recovery', `${head}，已自动${ACTION_LABELS[rule.action]}`);
      } catch (err: any) {
        await recordAndPush(
          'danger',
          `${head}，自动${ACTION_LABELS[rule.action]}失败: ${String(err?.message || err).slice(0, 200)}`,
        );
      }
    } catch (err: any) {
      console.error(`[selfheal] 规则 ${rule.id}(${rule.containerName}) 巡检失败:`, String(err?.message || err));
    }
  }
  return { triggered };
}

/** 是否已启动 */
let started = false;
/** 巡检定时器 */
let timer: NodeJS.Timeout | null = null;

/**
 * 启动自愈巡检（幂等；10s tick，与告警检测同节奏）
 */
export function startSelfHeal(): void {
  if (started) return;
  started = true;
  timer = setInterval(() => {
    runSelfHealCheck().catch((err) =>
      console.error('[selfheal] 巡检失败:', String((err as Error)?.message || err)),
    );
  }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[selfheal] 容器自愈服务已启动 (间隔 ' + TICK_MS + 'ms)');
}

/**
 * 停止自愈巡检
 */
export function stopSelfHeal(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}
