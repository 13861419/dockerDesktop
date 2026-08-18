/**
 * 容器 Web 终端务器
 *
 * 通过 WebSocket 提供容器内的交互式终端：
 *  - 前端用 xterm.js 连接 /ws/terminal/:containerId
 *  - 后端用 dockerode exec 在容器内启动 shell，并将双向数据桥接
 *  - 支持 resize（终端尺寸同步）
 *
 * 使用 ws 库挂载到现有 HTTP Server 上（noServer 模式，按路径路由）。
 */
import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { getDockerClient } from './client';
import { registerWsHandler, authenticateWs, rejectWsUpgrade } from './wsRouter';
import type Dockerode from 'dockerode';

/** 从 URL 中解析容器 ID：/ws/terminal/<id> */
function parsePath(pathname: string): string | null {
  const m = pathname.match(/^\/ws\/terminal\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 将 WebSocket 终端附加到指定 HTTP 服务器
 * @param httpServer HTTP 服务
 */
export function setupTerminalServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  registerWsHandler(httpServer, (req, socket, head, url) => {
    const containerId = parsePath(url.pathname);
    if (!containerId) return false;
    // 终端会在容器内执行 shell（高危），要求已登录且具备运维（operator/admin）权限
    if (!authenticateWs(url, { requireOperator: true })) {
      rejectWsUpgrade(socket, 401, '未登录或权限不足，无法连接容器终端');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, containerId);
    });
    return true;
  });

  wss.on('connection', (ws: WebSocket, _req: any, containerId: string) => {
    handleTerminal(ws, containerId);
  });

  console.log('[terminal] 容器终端 WebSocket 已就绪 (/ws/terminal/:id)');
}

/**
 * 处理单个终端 WebSocket 连接
 * @param ws WebSocket
 * @param containerId 容器 ID
 */
async function handleTerminal(ws: WebSocket, containerId: string): Promise<void> {
  let stream: NodeJS.ReadWriteStream | null = null;
  let exec: Dockerode.Exec | null = null;

  const send = (data: string | Buffer) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(typeof data === 'string' ? data : data.toString('utf8'));
    }
  };

  try {
    const docker = await getDockerClient();
    const container = docker.getContainer(containerId);

    // 校验容器是否存在且处于运行状态，未运行则给出友好提示
    try {
      const info = await container.inspect();
      if (!info.State?.Running) {
        send('\r\n[错误] 容器当前未运行，无法连接终端。请先在容器列表或详情页启动该容器后再试。\r\n');
        send('\r\n[DockerManager] 终端已断开。\r\n');
        try { ws.close(); } catch { /* ignore */ }
        return;
      }
    } catch (inspectErr: any) {
      // inspect 失败（如容器不存在）时给出友好提示
      const msg = isNoSuchContainer(inspectErr)
        ? '容器不存在或已被删除'
        : friendlyErrorMessage(inspectErr);
      send(`\r\n[错误] 无法访问容器终端：${msg}\r\n`);
      try { ws.close(); } catch { /* ignore */ }
      return;
    }

    // 创建交互式 exec（TTY 模式）
    exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ['/bin/sh'],
      Env: ['TERM=xterm-256color', 'COLORTERM=truecolor'],
    });

    // 启动 exec 并获取双向流
    stream = await exec.start({ hijack: true, stdin: true }) as unknown as NodeJS.ReadWriteStream;

    // exec 输出 → WebSocket
    stream.on('data', (chunk: Buffer | string) => {
      send(chunk);
    });
    stream.on('error', (err) => {
      try { ws.close(); } catch { /* ignore */ }
    });
    stream.on('end', () => {
      try { ws.close(); } catch { /* ignore */ }
    });

    // WebSocket 输入 → exec stdin；处理 resize 消息
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length === 0 || stream === null) return;

      // 自定义 resize 消息（JSON 前缀：RESIZE,<cols>,<rows>）
      const head = buf.subarray(0, 6).toString('utf8');
      if (head.startsWith('RESIZE')) {
        try {
          const parts = buf.toString('utf8').split(',');
          const cols = Number(parts[1]);
          const rows = Number(parts[2]);
          if (exec && cols > 0 && rows > 0) {
            exec.resize({ h: rows, w: cols }).catch(() => undefined);
          }
        } catch { /* ignore */ }
        return;
      }

      try { stream.write(buf); } catch { /* ignore */ }
    });

    ws.on('close', () => {
      try { if (stream && (stream as any).destroy) (stream as any).destroy(); } catch { /* ignore */ }
    });

    // 通知前端连接成功
    send('\r\n[DockerManager] 已连接容器终端。输入 exit 退出。\r\n');
  } catch (err) {
    send('\r\n[错误] 终端连接失败: ' + friendlyErrorMessage(err) + '\r\n');
    try { ws.close(); } catch { /* ignore */ }
  }
}

/**
 * 判断错误是否为"容器不存在"类错误
 * @param err 原始错误
 */
function isNoSuchContainer(err: any): boolean {
  const msg = String(err?.message || err?.json?.message || '');
  return /(no such container|not found|404)/i.test(msg);
}

/**
 * 将 dockerode 原始错误转换为更友好的中文提示
 * @param err 原始错误
 */
function friendlyErrorMessage(err: any): string {
  const msg = String(err?.message || err?.json?.message || err || '');
  if (/(no such container|404)/i.test(msg)) {
    return '容器不存在或已被删除';
  }
  if (/container\s+stopped|is not running|not running/i.test(msg)) {
    return '容器当前未运行，请先启动容器后再连接终端';
  }
  if (/not found|executable file/i.test(msg)) {
    return '镜像中未包含可用的 shell（如 /bin/sh），无法连接终端';
  }
  if (/permission denied|operation not permitted/i.test(msg)) {
    return '没有足够的权限在该容器内执行终端';
  }
  return msg;
}

