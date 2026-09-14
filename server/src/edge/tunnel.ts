/**
 * Edge 隧道（1.63.0）
 *
 * agent 主动通过 WebSocket 反向连接面板（/api/edge/ws?token=...），
 * 面板保持每个在线节点的 ws，通过 callNode(nodeId, method, path) 发起
 * 请求并由 agent 在远端对本地 Docker socket 执行后回传结果。
 *
 * 协议（JSON 文本帧）：
 *   agent → panel : {type:'hello', id, version}
 *   panel → agent : {id, method, path, body?}      // 请求
 *   agent → panel : {id, ok, status, data?, error?} // 响应（id 对应回执）
 */
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { registerWsHandler, rejectWsUpgrade } from '../docker/wsRouter';
import { ingestEdgeEvent } from '../docker/events';
import {
  findNodeByTokenHash,
  hashEdgeToken,
  touchEdgeNode,
} from './registry';

/** nodeId → 活跃连接 */
const online = new Map<string, WebSocket>();
/** 请求回执表 */
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
/** 自增请求 id */
let seq = 0;

/** 节点是否在线 */
export function isEdgeNodeOnline(nodeId: string): boolean {
  const ws = online.get(nodeId);
  return !!ws && ws.readyState === WebSocket.OPEN;
}

/** 在线节点 id 集合（供展示） */
export function onlineEdgeNodeIds(): string[] {
  return Array.from(online.keys());
}

/**
 * 通过隧道调用远端 agent（透传 Docker Engine HTTP API）
 *
 * @param nodeId 节点 id
 * @param method HTTP 方法（GET/POST/DELETE）
 * @param path   Docker API 路径（如 /containers/json?all=true）
 * @param body   可选请求体
 * @param timeoutMs 超时（默认 10s）
 */
export function callEdgeNode(
  nodeId: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<{ status: number; data: any }> {
  const ws = online.get(nodeId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(Object.assign(new Error('节点离线或隧道未连接'), { statusCode: 502 }));
  }
  const id = 'q' + ++seq;
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('节点响应超时'), { statusCode: 504 }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, path, body }));
  });
}

/** agent WebSocket 服务挂载（index.ts 启动时调用一次） */
export function setupEdgeWsServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  registerWsHandler(httpServer, (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean => {
    if (url.pathname !== '/api/edge/ws') return false;
    const token = url.searchParams.get('token') || '';
    const row = token ? findNodeByTokenHash(hashEdgeToken(token)) : null;
    if (!row) {
      rejectWsUpgrade(socket, 401, 'Edge token 无效');
      return true;
    }
    wss.handleUpgrade(req as any, socket, head, (ws) => {
      wss.emit('connection', ws, row.id);
    });
    return true;
  });

  wss.on('connection', (ws: WebSocket, nodeId: string) => {
    online.set(nodeId, ws);
    // 首帧 hello 记录版本与心跳
    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg && msg.type === 'hello') {
        touchEdgeNode(nodeId, String(msg.version || ''));
        return;
      }
      // agent 转发的远端 Docker 事件（1.65.0）：并入统一事件管线
      if (msg && msg.type === 'event' && msg.event) {
        try {
          ingestEdgeEvent(nodeId, msg.event);
        } catch {
          // 单条事件解析失败不影响隧道
        }
        return;
      }
      // 请求回执
      const entry = msg && typeof msg.id === 'string' ? pending.get(msg.id) : null;
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve({ status: msg.status || 200, data: msg.data });
        else entry.reject(Object.assign(new Error(String(msg.error || '节点执行失败')), { statusCode: msg.status || 500 }));
      }
    });
    ws.on('close', () => {
      if (online.get(nodeId) === ws) online.delete(nodeId);
    });
    ws.on('error', () => {
      if (online.get(nodeId) === ws) online.delete(nodeId);
    });
  });
}
