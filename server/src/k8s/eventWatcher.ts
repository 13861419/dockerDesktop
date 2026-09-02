/**
 * K8s 事件实时广播（1.10.0）
 *
 * - 全局单例 Watch（监听 /api/v1/events），有订阅者时启动，断线自动重连（5s）
 * - 事件广播给所有已订阅的 WebSocket 客户端（复用 wsRouter 鉴权：登录用户）
 * - 消息格式：{ type: 'event', event: {...} }（与 GET /api/k8s/events 字段一致）
 */
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { registerWsHandler, authenticateWs, rejectWsUpgrade } from '../docker/wsRouter';
import { loadKubeConfig, isK8sAvailable } from './k8sClient';

/** 已订阅的 WebSocket 集合 */
const subscribers = new Set<WebSocket>();

/** 当前 Watch 实例（断线重连用） */
let watch: { abort(): void } | null = null;

/** 重连定时器 */
let reconnectTimer: NodeJS.Timeout | null = null;

/** 单例启动标记 */
let watching = false;

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
 * 启动 K8s 事件 watch（仅在有订阅者时调用；断线自动重连）
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
          broadcast({
            type: 'event',
            event: {
              type: ev.type,
              reason: ev.reason,
              message: ev.message,
              object: ev.involvedObject?.name,
              kind: ev.involvedObject?.kind,
              namespace: ev.metadata?.namespace,
              count: ev.count,
              lastAt: ev.lastTimestamp ? new Date(ev.lastTimestamp).getTime() : Date.now(),
            },
          });
        },
        (err: Error | null) => {
          // done：流结束（断线）→ 清理并延迟重连
          watch = null;
          if (subscribers.size > 0) {
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
        if (subscribers.size > 0) {
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

  console.log('[k8sEvents] K8s 事件实时广播已就绪 (/ws/k8sevents)');
}
