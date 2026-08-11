/**
 * Docker 事件实时 WebSocket 服务
 *
 * 前端连接 /ws/events 后，将持续收到后端广播的实时 Docker 事件。
 * 复用事件采集服务（docker/events.ts）的订阅机制，订阅者注册后即可收到推送。
 */
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { onNewEvent, getRecentEvents, DockerEvent } from './events';

/**
 * 将 Docker 事件 WebSocket 附加到指定 HTTP 服务器
 * @param httpServer HTTP 服务
 */
export function setupEventWsServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', 'http://localhost');
    if (url.pathname !== '/ws/events') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    // 连接建立后立即推送缓存的最远 50 条，便于页面打开即有数据
    const recent = getRecentEvents(50);
    if (recent.length > 0 && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'snapshot', events: recent }));
    }
    ws.on('close', () => {
      clients.delete(ws);
    });
    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  // 订阅采集服务，收到新事件后广播给所有连接
  const unsubscribe = onNewEvent((ev: DockerEvent) => {
    const payload = JSON.stringify({ type: 'event', event: ev });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  });

  // server 关闭时清理（进程退出场景）
  wss.on('close', () => {
    unsubscribe();
    clients.clear();
  });

  console.log('[events] 事件实时 WebSocket 已就绪 (/ws/events)');
}
