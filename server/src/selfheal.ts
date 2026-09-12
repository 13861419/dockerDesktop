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
  match_label: string;
  max_triggers: number;
  trigger_window_sec: number;
  limit_notified_at: number | null;
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
  /** 标签匹配（1.40.0）：非空时按 Docker label 匹配容器（如 `team=api` 或仅 key），此时 containerName 为空 */
  matchLabel: string;
  /** 窗口内最大触发次数（1.40.0）：0 = 不限制 */
  maxTriggers: number;
  /** 触发次数统计窗口秒数（1.40.0） */
  triggerWindowSec: number;
  /** 上次超限告警时间（1.40.0） */
  limitNotifiedAt: number | null;
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
    matchLabel: r.match_label || '',
    maxTriggers: Math.max(0, Math.floor(Number(r.max_triggers) || 0)),
    triggerWindowSec: Math.max(60, Math.floor(Number(r.trigger_window_sec) || 3600)),
    limitNotifiedAt: r.limit_notified_at || null,
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
  matchLabel: string;
  maxTriggers: number;
  triggerWindowSec: number;
} {
  const matchLabel = String(body?.matchLabel ?? '').trim();
  if (matchLabel && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(=[a-zA-Z0-9_.-]*)?$/.test(matchLabel)) {
    throw Object.assign(new Error('标签格式应为 key 或 key=value'), { statusCode: 400 });
  }
  const containerName = String(forUpdate ? (body?.containerName ?? '') : body?.containerName || '').trim();
  if (forUpdate && body?.containerName === undefined) {
    // 更新时未传保持原值（由调用方兜底）
  } else if (!containerName && !matchLabel) {
    throw Object.assign(new Error('请输入容器名或匹配标签'), { statusCode: 400 });
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
  let maxTriggers = 0;
  if (body?.maxTriggers !== undefined && body?.maxTriggers !== null && body?.maxTriggers !== '') {
    maxTriggers = Math.floor(Number(body.maxTriggers));
    if (!Number.isFinite(maxTriggers) || maxTriggers < 0 || maxTriggers > 100) {
      throw Object.assign(new Error('触发上限需为 0-100（0 = 不限制）'), { statusCode: 400 });
    }
  }
  let triggerWindowSec = 3600;
  if (body?.triggerWindowSec !== undefined && body?.triggerWindowSec !== null && body?.triggerWindowSec !== '') {
    triggerWindowSec = Math.floor(Number(body.triggerWindowSec));
    if (!Number.isFinite(triggerWindowSec) || triggerWindowSec < 60 || triggerWindowSec > 86400) {
      throw Object.assign(new Error('统计窗口需为 60-86400 秒'), { statusCode: 400 });
    }
  }
  const enabled = body?.enabled === undefined ? 1 : body.enabled ? 1 : 0;
  return {
    containerName,
    watchType: watchType || undefined!,
    action: action || undefined!,
    cooldownSec,
    enabled,
    matchLabel,
    maxTriggers,
    triggerWindowSec,
  };
}

/**
 * 新增自愈规则（同名容器同监控类型去重）
 */
export function createSelfHealRule(body: any): SelfHealRule {
  const v = validateInput(body);
  if (!v.containerName && !v.matchLabel) throw Object.assign(new Error('请输入容器名或匹配标签'), { statusCode: 400 });
  if (!v.watchType) throw Object.assign(new Error('请选择监控类型'), { statusCode: 400 });
  if (!v.action) throw Object.assign(new Error('请选择恢复动作'), { statusCode: 400 });
  const d = getDb();
  const dup = v.matchLabel
    ? d
        .prepare("SELECT id FROM selfheal_rules WHERE match_label = ? AND watch_type = ? AND container_name = ''")
        .get(v.matchLabel, v.watchType)
    : d
        .prepare('SELECT id FROM selfheal_rules WHERE container_name = ? AND watch_type = ? AND match_label = ?')
        .get(v.containerName, v.watchType, '');
  if (dup) throw Object.assign(new Error('该容器已存在同类型的自愈规则'), { statusCode: 409 });
  const now = Date.now();
  const info = d
    .prepare(
      "INSERT INTO selfheal_rules (container_name, watch_type, action, cooldown_sec, enabled, last_triggered_at, match_label, max_triggers, trigger_window_sec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    .run(v.containerName, v.watchType, v.action, v.cooldownSec, v.enabled, v.matchLabel, v.maxTriggers, v.triggerWindowSec, now, now);
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
    match_label: body?.matchLabel !== undefined ? v.matchLabel : row.match_label || '',
    max_triggers: body?.maxTriggers !== undefined ? v.maxTriggers : row.max_triggers,
    trigger_window_sec: body?.triggerWindowSec !== undefined ? v.triggerWindowSec : row.trigger_window_sec,
  };
  if (!next.container_name && !next.match_label) throw Object.assign(new Error('请输入容器名或匹配标签'), { statusCode: 400 });
  getDb()
    .prepare(
      'UPDATE selfheal_rules SET container_name = ?, watch_type = ?, action = ?, cooldown_sec = ?, enabled = ?, match_label = ?, max_triggers = ?, trigger_window_sec = ?, updated_at = ? WHERE id = ?',
    )
    .run(next.container_name, next.watch_type, next.action, next.cooldown_sec, next.enabled, next.match_label, next.max_triggers, next.trigger_window_sec, Date.now(), id);
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

/** 自愈执行记录保留条数（超出清理最旧记录） */
const SELFHEAL_EVENT_LIMIT = 200;

/**
 * 写入一条自愈执行记录（1.39.0 留档），并裁剪到最近 200 条
 */
function recordSelfHealEvent(
  ruleId: number | null,
  containerName: string,
  watchType: string,
  action: string,
  success: boolean,
  detail: string | null,
): void {
  try {
    getDb()
      .prepare(
        'INSERT INTO selfheal_events (rule_id, container_name, watch_type, action, success, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(ruleId, containerName, watchType, action, success ? 1 : 0, detail, Date.now());
    getDb()
      .prepare(
        'DELETE FROM selfheal_events WHERE id NOT IN (SELECT id FROM selfheal_events ORDER BY id DESC LIMIT 200)',
      )
      .run();
  } catch {
    // 留档失败不影响自愈主流程
  }
}

/**
 * 查询最近的自愈执行记录（最新在前）
 */
export function listSelfHealEvents(limit = 50): Array<{
  id: number;
  ruleId: number | null;
  containerName: string;
  watchType: string;
  action: string;
  success: boolean;
  detail: string | null;
  createdAt: number;
}> {
  const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
  const rows = getDb()
    .prepare(
      'SELECT id, rule_id, container_name, watch_type, action, success, detail, created_at FROM selfheal_events ORDER BY id DESC LIMIT ?',
    )
    .all(lim) as unknown as Array<{
    id: number;
    rule_id: number | null;
    container_name: string;
    watch_type: string;
    action: string;
    success: number;
    detail: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    containerName: r.container_name,
    watchType: r.watch_type,
    action: r.action,
    success: r.success === 1,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

/**
 * 标签匹配（纯函数，便于单测，1.40.0）
 * @param label 规则上的标签：`key=value` 或仅 `key`
 * @param labels 容器 Labels 对象
 */
export function matchesLabelRule(label: string, labels: Record<string, string> | undefined | null): boolean {
  const [lk, lv] = String(label || '').split('=');
  if (!lk) return false;
  return Object.entries(labels || {}).some(([k, v]) => k === lk && (lv === undefined || lv === v));
}

/**
 * 触发次数上限判定（纯函数，便于单测，1.41.0 抽取）
 * @param maxTriggers 窗口内最大触发次数（<=0 = 不限制）
 * @param windowSec 统计窗口秒数
 * @param triggeredCount 窗口内已触发次数
 * @param limitNotifiedAt 上次超限告警时间
 * @param now 当前时间戳
 */
export function evalTriggerLimit(
  maxTriggers: number,
  windowSec: number,
  triggeredCount: number,
  limitNotifiedAt: number | null,
  now: number,
): { limited: boolean; notify: boolean } {
  if (!maxTriggers || maxTriggers <= 0) return { limited: false, notify: false };
  if (triggeredCount < maxTriggers) return { limited: false, notify: false };
  return { limited: true, notify: !limitNotifiedAt || now - limitNotifiedAt > windowSec * 1000 };
}

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
      // 解析目标容器：优先按标签匹配（1.40.0），否则按名称精确匹配
      const list = (await docker.listContainers({ all: true }).catch(() => [])) as any[];
      const found = list.find((c) => {
        if (rule.matchLabel) return matchesLabelRule(rule.matchLabel, c.Labels || {});
        return (c.Names || []).some((n: string) => n.replace(/^\//, '') === rule.containerName);
      });
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
      const targetName = rule.containerName || (info.Name || '').replace(/^\//, '') || rule.matchLabel;
      // 触发次数上限（1.40.0）：统计窗口内已触发次数达到上限则暂停自愈并发一次危险告警
      if (rule.maxTriggers > 0) {
        const cntRow = getDb()
          .prepare('SELECT count(*) AS c FROM selfheal_events WHERE rule_id = ? AND created_at > ?')
          .get(rule.id, now - rule.triggerWindowSec * 1000) as { c: number };
        const verdict = evalTriggerLimit(rule.maxTriggers, rule.triggerWindowSec, cntRow?.c || 0, rule.limitNotifiedAt, now);
        if (verdict.limited) {
          if (verdict.notify) {
            getDb().prepare('UPDATE selfheal_rules SET limit_notified_at = ? WHERE id = ?').run(now, rule.id);
            await recordAndPush(
              'danger',
              `Docker 面板【自愈】容器 ${targetName} 在 ${Math.round(rule.triggerWindowSec / 60)} 分钟内已触发 ${cntRow.c} 次自愈（上限 ${rule.maxTriggers}），已暂停自动恢复，请人工排查`,
            );
          }
          continue;
        }
      }
      getDb()
        .prepare('UPDATE selfheal_rules SET last_triggered_at = ? WHERE id = ?')
        .run(now, rule.id);
      triggered++;
      const head = `Docker 面板【自愈】容器 ${targetName} ${WATCH_LABELS[rule.watchType]}`;
      try {
        await applyAction(rule.action, found.Id);
        recordSelfHealEvent(rule.id, targetName, rule.watchType, rule.action, true, `已自动${ACTION_LABELS[rule.action]}`);
        await recordAndPush('recovery', `${head}，已自动${ACTION_LABELS[rule.action]}`);
      } catch (err: any) {
        recordSelfHealEvent(
          rule.id,
          targetName,
          rule.watchType,
          rule.action,
          false,
          `自动${ACTION_LABELS[rule.action]}失败: ${String(err?.message || err).slice(0, 200)}`,
        );
        await recordAndPush(
          'danger',
          `${head}，自动${ACTION_LABELS[rule.action]}失败: ${String(err?.message || err).slice(0, 200)}`,
        );
      }
    } catch (err: any) {
      console.error(`[selfheal] 规则 ${rule.id}(${rule.containerName || rule.matchLabel}) 巡检失败:`, String(err?.message || err));
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
