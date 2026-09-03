/**
 * K8s 事件实时广播 + 本地持久化（1.10.0 实时流 / 1.12.0 落库）
 *
 * - 全局单例 Watch（监听 /api/v1/events），服务启动即采集（与订阅者无关），断线自动重连（5s）
 * - 事件同步写入 k8s_events 表（uid 去重 UPSERT，保留 7 天），集群不可达时仍可回看本地历史
 * - 事件广播给所有已订阅的 WebSocket 客户端（复用 wsRouter 鉴权：登录用户）
 * - 消息格式：{ type: 'event', event: {...} }（与 GET /api/k8s/events 字段一致）
 */
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { registerWsHandler, authenticateWs, rejectWsUpgrade } from '../docker/wsRouter';
import { getDb } from '../storage';
import { loadKubeConfig, isK8sAvailable } from './k8sClient';

/** 原始事件保留 7 天（与 host_metrics / k8s_metrics 一致） */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 已订阅的 WebSocket 集合 */
const subscribers = new Set<WebSocket>();

/** 当前 Watch 实例（断线重连用） */
let watch: { abort(): void } | null = null;

/** 重连定时器 */
let reconnectTimer: NodeJS.Timeout | null = null;

/** 单例启动标记 */
let watching = false;

/** 确保 k8s_events 本地事件表存在 */
export function ensureK8sEventsTable(): void {
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS k8s_events (
         uid TEXT PRIMARY KEY,
         ts INTEGER NOT NULL,
         namespace TEXT,
         type TEXT,
         reason TEXT,
         kind TEXT,
         object TEXT,
         message TEXT,
         count INTEGER,
         last_at INTEGER
       )`,
    )
    .run();
  getDb().prepare('CREATE INDEX IF NOT EXISTS idx_k8s_events_ts ON k8s_events (last_at)').run();
}

/** 事件落库（uid 去重 UPSERT：重复事件刷新 count 与 last_at） */
export function insertK8sEvent(ev: {
  uid?: string;
  namespace?: string;
  type?: string;
  reason?: string;
  kind?: string;
  object?: string;
  message?: string;
  count?: number;
  lastAt?: number | null;
}): void {
  const uid = String(ev.uid || '');
  if (!uid) return;
  ensureK8sEventsTable();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO k8s_events (uid, ts, namespace, type, reason, kind, object, message, count, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(uid, Date.now(), ev.namespace || '', ev.type || '', ev.reason || '', ev.kind || '', ev.object || '', ev.message || '', ev.count ?? 1, ev.lastAt ?? Date.now());
}

/** 查询本地历史事件（按最近发生时间倒序） */
export function queryK8sEventsHistory(namespace: string | undefined, limit: number): Array<{
  type: string;
  reason: string;
  message: string;
  object: string;
  kind: string;
  namespace: string;
  count: number;
  lastAt: number;
}> {
  ensureK8sEventsTable();
  const lim = Math.min(Math.max(limit || 200, 1), 1000);
  const rows = namespace
    ? getDb()
        .prepare('SELECT namespace, type, reason, kind, object, message, count, last_at FROM k8s_events WHERE namespace = ? ORDER BY last_at DESC LIMIT ?')
        .all(namespace, lim)
    : getDb()
        .prepare('SELECT namespace, type, reason, kind, object, message, count, last_at FROM k8s_events ORDER BY last_at DESC LIMIT ?')
        .all(lim);
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    namespace: String(r.namespace || ''),
    type: String(r.type || ''),
    reason: String(r.reason || ''),
    kind: String(r.kind || ''),
    object: String(r.object || ''),
    message: String(r.message || ''),
    count: Number(r.count) || 1,
    lastAt: Number(r.last_at) || 0,
  }));
}

/** 事件广播 */
function broadcast(payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {
        subscribers.delete(ws);
      }
    }
  }
}

/**
 * 启动 K8s 事件 watch（服务启动即调用；断线自动重连）
 */
function startWatch(): void {
  if (watch || !isK8sAvailable()) return;
  try {
    const k8s = require('@kubernetes/client-node');
    const kc = loadKubeConfig();
    const w = new k8s.Watch(kc);
    void w
      .watch(
        '/api/v1/events',
        {},
        (_type: string, ev: any) => {
          const event = {
            type: ev.type,
            reason: ev.reason,
            message: ev.message,
            object: ev.involvedObject?.name,
            kind: ev.involvedObject?.kind,
            namespace: ev.metadata?.namespace,
            count: ev.count,
            lastAt: ev.lastTimestamp ? new Date(ev.lastTimestamp).getTime() : Date.now(),
          };
          // 同步落库（uid 去重）；失败不影响广播
          try {
            insertK8sEvent({ uid: ev.metadata?.uid, ...event });
            // 约 1% 概率触发过期清理（7 天保留）
            if (Math.random() < 0.01) {
              getDb().prepare('DELETE FROM k8s_events WHERE last_at < ?').run(Date.now() - EVENT_RETENTION_MS);
            }
          } catch {
            /* ignore */
          }
          // Warning 事件 → 告警联动（1.18.0，alerts.k8sEvents 开关 + 5 分钟去重）
          if (ev.type === 'Warning') {
            import('../alerting')
              .then((m) => m.reportK8sEventWarning(event))
              .catch(() => {});
          }
          broadcast({ type: 'event', event });
        },
        (err: Error | null) => {
          // done：流结束（断线）→ 清理并延迟重连
          watch = null;
          if (subscribers.size > 0 || watching) {
            setTimeout(() => startWatch(), 5000);
          }
          void err;
        },
      )
      .then((abort: { abort(): void }) => {
        watch = abort;
      })
      .catch(() => {
        watch = null;
        if (subscribers.size > 0 || watching) {
          setTimeout(() => startWatch(), 5000);
        }
      });
  } catch {
    watch = null;
  }
}

/**
 * 附加 K8s 事件实时广播 WebSocket（/ws/k8sevents）
 */
export function setupK8sEventWatcher(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  registerWsHandler(httpServer, (req, socket, head, url) => {
    if (url.pathname !== '/ws/k8sevents') return false;
    if (!authenticateWs(url)) {
      rejectWsUpgrade(socket, 401, '未登录，无法接收 K8s 事件流');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  });

  wss.on('connection', (ws: WebSocket) => {
    subscribers.add(ws);
    startWatch();
    ws.on('close', () => subscribers.delete(ws));
    ws.on('error', () => subscribers.delete(ws));
  });

  // 1.12.0：服务启动即持续采集事件（落库），与是否有订阅者无关
  if (!watching) {
    watching = true;
    ensureK8sEventsTable();
    startWatch();
    console.log('[k8sEvents] K8s 事件采集已启动（本地持久化 7 天 + /ws/k8sevents 实时广播）');
  }
}
