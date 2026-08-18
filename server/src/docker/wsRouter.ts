/**
 * WebSocket 统一 upgrade 分发器
 *
 * Node.js http.Server 的 upgrade 事件在存在多个监听器时，只会调用第一个注册的监听器，
 * 导致后注册的 WebSocket 服务（如事件流 /ws/events）永远无法建立连接。
 * 本模块确保在同一个 HTTP Server 上只注册一次 upgrade 监听器，并按其自定义匹配逻辑
 * 依次把请求分发给各 WebSocket 服务；没有任何服务匹配时关闭连接。
 */
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { isValidToken, getSessionUsername } from '../auth';
import { getUserRole } from '../users';

/** 单个 upgrade 处理函数：按路径匹配并升级连接，返回是否已处理 */
type WsHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
) => boolean;

/** 已注册的 WebSocket 处理函数集合 */
const handlers = new Set<WsHandler>();
/** 该分发器是否已绑定到某个 HTTP Server（全局仅绑定一次） */
let boundServer: HttpServer | null = null;

/**
 * 校验 WebSocket upgrade 请求的登录凭证并返回用户信息
 *
 * 浏览器 WebSocket API 无法自定义请求头，因此放行凭证必须通过 URL query 传递，
 * 约定为 ?token=<会话Token>，与登录后前端的 getToken() 保持一致。
 *
 * @param url 已解析的请求 URL（含 query）
 * @param requireOperator 是否要求 admin / operator 运维权限（终端等资源操作需该权限）
 * @returns 校验通过返回 { username, role }，否则返回 null（调用方应拒绝连接）
 */
export function authenticateWs(
  url: URL,
  options?: { requireOperator?: boolean },
): { username: string; role: string } | null {
  const token = url.searchParams.get('token');
  if (!token || !isValidToken(token)) return null;
  const username = getSessionUsername(token);
  if (!username) return null;
  const role = getUserRole(username);
  if (options?.requireOperator && role !== 'admin' && role !== 'operator') return null;
  return { username, role };
}

/**
 * 向尚未升级的 http.Socket 写入一个拒绝响应并关闭连接（用于 WebSocket 鉴权失败）
 * @param socket 原始连接 socket
 * @param status HTTP 状态码（401 未登录 / 403 权限不足）
 */
export function rejectWsUpgrade(socket: Duplex, status: 401 | 403, message: string): void {
  const payload =
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
    `Content-Type: application/json\r\n` +
    `Connection: close\r\n` +
    `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n` +
    message;
  try {
    socket.write(payload);
  } catch {
    // ignore
  }
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

/**
 * 注册一个 WebSocket upgrade 处理函数（幂等，仅在首个 handler 时绑定 server）
 * @param server HTTP 服务
 * @param handler 按路径分发并升级连接的处理函数，返回 true 表示已处理
 */
export function registerWsHandler(server: HttpServer, handler: WsHandler): void {
  handlers.add(handler);
  if (boundServer === server) return;
  boundServer = server;
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      // URL 解析失败直接关闭
      socket.destroy();
      return;
    }
    for (const h of handlers) {
      try {
        if (h(req, socket, head, url)) return;
      } catch {
        // 单个 handler 异常时尝试下一个
      }
    }
    // 无 handler 匹配：关闭连接
    socket.destroy();
  });
}
