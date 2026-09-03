/**
 * K8s Pod Web 终端服务器（1.7.0）
 *
 * 通过 WebSocket 提供 Pod 容器内的交互式终端：
 *  - 前端用 xterm.js 连接 /ws/k8sterminal/:ns/:pod/:container
 *  - 后端用 client-node Exec（tty 模式）启动 /bin/sh，并将双向数据桥接
 *
 * 复用 docker/terminal.ts 的 wsRouter 注册与鉴权模式（requireOperator）。
 * 注：1.14.0 起支持运行期 resize（client-node 1.4 Exec 内置 ResizeStream 通道）。
 */
import type { Server as HttpServer } from 'http';
import { Writable, Readable } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { registerWsHandler, authenticateWs, rejectWsUpgrade } from '../docker/wsRouter';
import { loadKubeConfig } from './k8sClient';
import { Exec } from '@kubernetes/client-node';

/** 从 URL 解析三元组：/ws/k8sterminal/<ns>/<pod>/<container> */
function parsePath(pathname: string): { ns: string; pod: string; container: string } | null {
  const m = pathname.match(/^\/ws\/k8sterminal\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return {
    ns: decodeURIComponent(m[1]),
    pod: decodeURIComponent(m[2]),
    container: decodeURIComponent(m[3]),
  };
}

/**
 * 将 Pod 终端 WebSocket 附加到 HTTP 服务器
 */
export function setupK8sTerminalServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  registerWsHandler(httpServer, (req, socket, head, url) => {
    const parts = parsePath(url.pathname);
    if (!parts) return false;
    // Pod 终端在容器内执行 shell（高危），与 Docker 终端一致要求 operator/admin
    if (!authenticateWs(url, { requireOperator: true })) {
      rejectWsUpgrade(socket, 401, '未登录或权限不足，无法连接 Pod 终端');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, parts);
    });
    return true;
  });

  wss.on('connection', (ws: WebSocket, _req: any, parts: { ns: string; pod: string; container: string }) => {
    void handleTerminal(ws, parts.ns, parts.pod, parts.container);
  });

  console.log('[k8sterminal] Pod 终端 WebSocket 已就绪 (/ws/k8sterminal/:ns/:pod/:container)');
}

/**
 * 处理单个 Pod 终端连接：桥接 client-node Exec 与 WebSocket
 */
async function handleTerminal(ws: WebSocket, ns: string, pod: string, container: string): Promise<void> {
  const send = (data: string | Buffer) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(typeof data === 'string' ? data : data.toString('utf8'));
    }
  };

  try {
    const kc = loadKubeConfig();
    const exec = new Exec(kc);

    // stdout/stderr 桥：K8s → 浏览器
    // 1.14.0：带 rows/columns 属性使 client-node isResizable() 通过，启用 ResizeStream 通道
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        send(chunk);
        cb();
      },
    }) as Writable & { rows: number; columns: number };
    stdout.rows = 24;
    stdout.columns = 80;
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        send(chunk);
        cb();
      },
    });

    // stdin 桥：浏览器 → K8s
    let stdinPush: ((buf: Buffer) => boolean) | null = null;
    const stdin = new Readable({
      read() {
        /* 数据由 push 注入 */
      },
    });
    stdinPush = (buf) => stdin.push(buf);

    const wsSock = await exec.exec(ns, pod, container, ['/bin/sh'], stdout, stderr, stdin, true, (status) => {
      send(`\r\n[K8sManager] 会话结束（exit ${status?.status ?? 'unknown'}）。\r\n`);
      try { ws.close(); } catch { /* ignore */ }
    });

    // exec WebSocket 断开时关闭前端会话
    wsSock.on('close', () => {
      try { ws.close(); } catch { /* ignore */ }
    });
    wsSock.on('error', () => {
      try { ws.close(); } catch { /* ignore */ }
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length === 0) return;
      const text = buf.subarray(0, 64).toString('utf8');
      // RESIZE,<cols>,<rows>：运行期终端尺寸调整（1.14.0，经 client-node ResizeStream 通道）
      if (text.startsWith('RESIZE,')) {
        const m = text.match(/^RESIZE,(\d+),(\d+)/);
        if (m) {
          stdout.columns = Math.max(2, Math.min(Number(m[1]) || 80, 500));
          stdout.rows = Math.max(2, Math.min(Number(m[2]) || 24, 500));
          stdout.emit('resize');
        }
        return;
      }
      if (stdinPush) stdinPush(buf);
    });

    ws.on('close', () => {
      try { wsSock.close(); } catch { /* ignore */ }
    });

    send(`\r\n[K8sManager] 已连接 Pod ${ns}/${pod}（容器 ${container}）。输入 exit 退出。\r\n`);
  } catch (err) {
    send('\r\n[错误] 终端连接失败: ' + friendlyErrorMessage(err) + '\r\n');
    try { ws.close(); } catch { /* ignore */ }
  }
}

/**
 * 将 K8s exec 原始错误转换为友好提示
 */
function friendlyErrorMessage(err: any): string {
  const msg = String(err?.message || err?.body?.message || err || '');
  if (/(not found|404)/i.test(msg)) {
    return 'Pod 或容器不存在（可能已被删除或重启）';
  }
  if (/container .* not running|no such pod/i.test(msg)) {
    return '容器当前未运行，请先确认 Pod 状态';
  }
  if (/executable file|no such file/i.test(msg)) {
    return '镜像中未包含可用的 shell（如 /bin/sh），无法连接终端';
  }
  if (/upgrade/i.test(msg)) {
    return '集群不支持 exec（可能未启用 SPDY/WebSocket 升级）';
  }
  return msg;
}
