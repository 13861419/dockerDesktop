/**
 * 事件触发自动化器（1.61.0）
 *
 * 订阅 Docker 实时事件流，按用户定义的「事件 → 动作」规则自动执行：
 *   规则 = 事件类型（container.die / container.oom / image.pull ...）
 *        + 容器名 / 镜像名匹配（子串，留空匹配全部）
 *        + 动作（restart / stop / start / webhook）
 *        + 冷却期（同规则冷却窗口内不重复触发，防事件风暴）
 *
 * 触发留档 automation_events（保留最近 500 条），供前端查看执行历史。
 */
import { getDockerClient } from './docker/client';
import { onNewEvent, DockerEvent } from './docker/events';
import { getDb } from './storage';

export type AutomationAction = 'restart' | 'stop' | 'start' | 'webhook';

/** 允许的动作 */
const ACTIONS = ['restart', 'stop', 'start', 'webhook'] as const;

/** 触发留档保留条数 */
const EVENT_KEEP = 500;

interface AutomationRuleRow {
  id: number;
  name: string;
  enabled: number;
  event_type: string;
  match_container: string | null;
  match_image: string | null;
  action: string;
  action_params: string | null;
  cooldown_sec: number;
  last_triggered_at: number | null;
  trigger_count: number;
  created_at: number;
  updated_at: number;
}

export interface AutomationRule {
  id: number;
  name: string;
  enabled: boolean;
  eventType: string;
  matchContainer: string;
  matchImage: string;
  action: string;
  actionParams: Record<string, unknown>;
  cooldownSec: number;
  lastTriggeredAt: number | null;
  triggerCount: number;
  createdAt: number;
}

/** 行 → 规则对象 */
function mapRule(r: AutomationRuleRow): AutomationRule {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(r.action_params || '{}');
  } catch {
    params = {};
  }
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    eventType: r.event_type,
    matchContainer: r.match_container || '',
    matchImage: r.match_image || '',
    action: r.action,
    actionParams: params,
    cooldownSec: r.cooldown_sec,
    lastTriggeredAt: r.last_triggered_at,
    triggerCount: r.trigger_count,
    createdAt: r.created_at,
  };
}

/** 读取全部规则 */
export function listAutomations(): AutomationRule[] {
  const rows = getDb()
    .prepare('SELECT * FROM automation_rules ORDER BY created_at DESC')
    .all() as unknown as AutomationRuleRow[];
  return (rows || []).map(mapRule);
}

/** 校验并整理规则输入 */
function normalizeInput(body: any): {
  name: string;
  eventType: string;
  matchContainer: string;
  matchImage: string;
  action: string;
  actionParams: string;
  cooldownSec: number;
} {
  const name = String(body?.name || '').trim();
  if (!name) {
    const err: any = new Error('规则名称不能为空');
    err.statusCode = 400;
    throw err;
  }
  const eventType = String(body?.eventType || '').trim().toLowerCase();
  if (!/^[a-z]+\.[a-z_:-]+$/i.test(eventType)) {
    const err: any = new Error('事件类型格式非法（应为 container.die、container.oom、image.pull 等）');
    err.statusCode = 400;
    throw err;
  }
  const action = String(body?.action || '').trim();
  if (!ACTIONS.includes(action as any)) {
    const err: any = new Error(`不支持的动作：${action}（可选 ${ACTIONS.join(' / ')}）`);
    err.statusCode = 400;
    throw err;
  }
  let actionParams: Record<string, unknown> = {};
  if (action === 'webhook') {
    const url = String(body?.actionParams?.url || '').trim();
    if (!/^https?:\/\//.test(url)) {
      const err: any = new Error('webhook 动作需提供 http(s) URL');
      err.statusCode = 400;
      throw err;
    }
    actionParams = { url, secret: String(body?.actionParams?.secret || '') };
  }
  const cooldownSec = Math.min(Math.max(Math.floor(Number(body?.cooldownSec) || 300), 10), 86400 * 7);
  return {
    name,
    eventType,
    matchContainer: String(body?.matchContainer || '').trim(),
    matchImage: String(body?.matchImage || '').trim(),
    action,
    actionParams: JSON.stringify(actionParams),
    cooldownSec,
  };
}

/** 新建规则 */
export function createAutomation(body: any): AutomationRule {
  const input = normalizeInput(body);
  const now = Date.now();
  const r = getDb()
    .prepare(
      `INSERT INTO automation_rules (name, enabled, event_type, match_container, match_image, action, action_params, cooldown_sec, trigger_count, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(input.name, input.eventType, input.matchContainer, input.matchImage, input.action, input.actionParams, input.cooldownSec, now, now);
  const row = getDb().prepare('SELECT * FROM automation_rules WHERE id = ?').get(r.lastInsertRowid) as unknown as AutomationRuleRow;
  return mapRule(row);
}

/** 更新规则 */
export function updateAutomation(id: number, body: any): AutomationRule | null {
  const existing = getDb().prepare('SELECT * FROM automation_rules WHERE id = ?').get(id) as unknown as AutomationRuleRow | undefined;
  if (!existing) return null;
  const cur = mapRule(existing);
  const merged = { ...cur, ...(body || {}), actionParams: { ...cur.actionParams, ...(body?.actionParams || {}) } };
  const input = normalizeInput(merged);
  getDb()
    .prepare(
      `UPDATE automation_rules SET name = ?, enabled = ?, event_type = ?, match_container = ?, match_image = ?, action = ?, action_params = ?, cooldown_sec = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      input.name,
      body?.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0,
      input.eventType,
      input.matchContainer,
      input.matchImage,
      input.action,
      input.actionParams,
      input.cooldownSec,
      Date.now(),
      id,
    );
  const row = getDb().prepare('SELECT * FROM automation_rules WHERE id = ?').get(id) as unknown as AutomationRuleRow;
  return mapRule(row);
}

/** 启用 / 禁用 */
export function setAutomationEnabled(id: number, enabled: boolean): AutomationRule | null {
  const r = getDb()
    .prepare('UPDATE automation_rules SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id);
  if (r.changes === 0) return null;
  const row = getDb().prepare('SELECT * FROM automation_rules WHERE id = ?').get(id) as unknown as AutomationRuleRow;
  return mapRule(row);
}

/** 删除规则 */
export function deleteAutomation(id: number): boolean {
  return getDb().prepare('DELETE FROM automation_rules WHERE id = ?').run(id).changes > 0;
}

/** 触发历史（最近 N 条） */
export function listAutomationEvents(limit = 100): Array<Record<string, unknown>> {
  const n = Math.min(Math.max(Number(limit) || 100, 1), EVENT_KEEP);
  return getDb()
    .prepare('SELECT rule_id, rule_name, event_type, container, image, action, detail, ok, created_at FROM automation_events ORDER BY created_at DESC LIMIT ?')
    .all(n) as unknown as Array<Record<string, unknown>>;
}

/** 写触发留档并裁剪 */
function logTrigger(row: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO automation_events (rule_id, rule_name, event_type, container, image, action, detail, ok, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.rule_id as any,
    row.rule_name as any,
    row.event_type as any,
    row.container as any,
    row.image as any,
    row.action as any,
    row.detail as any,
    row.ok as any,
    Date.now(),
  );
  db.prepare('DELETE FROM automation_events WHERE id IN (SELECT id FROM automation_events ORDER BY created_at DESC LIMIT -1 OFFSET ?)').run(EVENT_KEEP);
}

/** 规则是否命中事件 */
function ruleMatches(rule: AutomationRuleRow, ev: DockerEvent): boolean {
  const dot = rule.event_type.indexOf('.');
  if (dot <= 0) return false;
  const type = rule.event_type.slice(0, dot);
  const actionPrefix = rule.event_type.slice(dot + 1);
  if (ev.type !== type) return false;
  if (!actionPrefix || !ev.action.startsWith(actionPrefix)) return false;
  if (rule.match_container && !(ev.attributes?.name || '').includes(rule.match_container)) return false;
  if (rule.match_image && !(ev.attributes?.image || '').includes(rule.match_image)) return false;
  return true;
}

/** 执行动作 */
async function executeAction(action: string, actionParams: Record<string, unknown>, ev: DockerEvent, ruleName: string): Promise<string> {
  if (action === 'restart' || action === 'stop' || action === 'start') {
    const docker = await getDockerClient();
    const container = docker.getContainer(ev.id);
    if (action === 'restart') await container.restart();
    else if (action === 'stop') await container.stop();
    else await container.start();
    return `已对容器执行 ${action}`;
  }
  if (action === 'webhook') {
    const url = String(actionParams.url || '');
    const secret = String(actionParams.secret || '');
    const payload = {
      rule: ruleName,
      event: { type: ev.type, action: ev.action, time: ev.time },
      container: { id: ev.id, name: ev.attributes?.name || '', image: ev.attributes?.image || '' },
    };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Automation-Secret'] = secret;
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    return `webhook 已投递：HTTP ${resp.status}`;
  }
  throw new Error(`未实现的动作：${action}`);
}

/** 事件处理：匹配规则 → 冷却 → 执行 → 留档 */
async function handleEvent(ev: DockerEvent): Promise<void> {
  const rows = getDb()
    .prepare('SELECT * FROM automation_rules WHERE enabled = 1')
    .all() as unknown as AutomationRuleRow[];
  const now = Date.now();
  for (const row of rows || []) {
    try {
      if (!ruleMatches(row, ev)) continue;
      if (row.last_triggered_at && now - row.last_triggered_at < row.cooldown_sec * 1000) continue;
      let detail = '';
      let ok = true;
      try {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(row.action_params || '{}');
        } catch {
          params = {};
        }
        detail = await executeAction(row.action, params, ev, row.name);
      } catch (e: any) {
        ok = false;
        detail = String(e?.message || e);
      }
      getDb()
        .prepare('UPDATE automation_rules SET last_triggered_at = ?, trigger_count = trigger_count + 1 WHERE id = ?')
        .run(now, row.id);
      logTrigger({
        rule_id: row.id,
        rule_name: row.name,
        event_type: `${ev.type}.${ev.action}`,
        container: ev.attributes?.name || ev.id.slice(0, 12),
        image: ev.attributes?.image || '',
        action: row.action,
        detail,
        ok: ok ? 1 : 0,
      });
    } catch {
      // 单条规则异常不影响其他规则
    }
  }
}

/** 订阅句柄 */
let unsubscribe: (() => void) | null = null;

/** 启动自动化引擎（订阅 Docker 实时事件流） */
export function startAutomation(): void {
  if (unsubscribe) return;
  unsubscribe = onNewEvent((ev) => {
    if (ev.type !== 'container' && ev.type !== 'image') return;
    handleEvent(ev).catch(() => {});
  });
}

/** 停止自动化引擎（测试用） */
export function stopAutomation(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}
