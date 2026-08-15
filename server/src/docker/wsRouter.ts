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
