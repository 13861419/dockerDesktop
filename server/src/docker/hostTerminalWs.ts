/**
 * 宿主机会话式交互终端 WebSocket 服务
 *
 * 在宿主机上维持一个长驻的 shell 子进程，
 * 通过 /ws/hostterminal 与前端双向实时通信：
 *  - 前端输入（含按键）写入子进程 stdin
 *  - 子进程 stdout / stderr 实时桥接回 WebSocket
 *  - 支持自定义 resize 消息（保留给后续 PTY 扩展；非 TTY 模式下透传忽略）
 *
 * 平台说明：
 *  - Windows：支持 powershell / cmd
 *  - Linux：支持 bash / sh
 *
 * 说明：本项目遵循零第三方运行时依赖原则，未引入 node-pty。
 * 因此该终端为「持久会话式」交互体验（区别于 REST 的单命令执行器），
 * 但并非真正 PTY：vim / top 等依赖 TTY 的全屏程序无法完美运行。
 *
 * 安全约束：
 *  - 仅管理员可连接（与 REST 版一致，高危操作）。
 *  - 复用统一 WS 鉴权（token 经 URL query 传递）。
 */
import type { Server as HttpServer } from 'http';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { registerWsHandler, authenticateWs, rejectWsUpgrade } from './wsRouter';
import { logOperation } from '../operationLog';
import { isWindows, getDefaultShells, getDefaultShell, type ShellName } from '../platform/detect';

/** 支持的 shell（按平台） */
type Shell = ShellName;

/** 上调 shell 默认工作目录 */
const DEFAULT_CWD = process.env.HOME || process.env.USERPROFILE || (isWindows() ? 'C:\\' : '/');

/**
 * 将 WebSocket 宿主终端附加到指定 HTTP 服务器
 * @param httpServer HTTP 服务
 */
export function setupHostTerminalServer(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  registerWsHandler(httpServer, (req, socket, head, url) => {
    if (url.pathname !== '/ws/hostterminal') return false;
    // 高危：宿主机命令执行，要求已登录且为管理员
    if (!authenticateWs(url, { requireOperator: true })) {
      rejectWsUpgrade(socket, 401, '未登录或权限不足，无法连接宿主机终端');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws);
    });
    return true;
  });

  wss.on('connection', (ws: WebSocket) => {
    handleSession(ws);
  });

  console.log('[hostterminal] 宿主机会话式终端 WebSocket 已就绪 (/ws/hostterminal)');
}

/**
 * 处理单个宿主终端 WebSocket 会话
 * @param ws 客户端 WebSocket
 */
function handleSession(ws: WebSocket): void {
  let child: ChildProcessWithoutNullStreams | null = null;

  const send = (data: string | Buffer) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(typeof data === 'string' ? data : data.toString('utf8'));
    }
  };

  const close = () => {
    try {
      if (child && child.exitCode === null && child.killed === false) {
        child.kill();
      }
    } catch {
      // 忽略关闭异常
    }
    try {
      ws.close();
    } catch {
      // 忽略
    }
  };

  // 等待客户端发送 shell 选择后再启动子进程（前端连接后立即发送配置）
  const configTimeout = setTimeout(() => {
    if (!child) close();
  }, 10000);

  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const head = buf.subarray(0, 8).toString('utf8');

    // 配置消息：CONFIG,<shell>
    if (head.startsWith('CONFIG')) {
      if (child) return;
      clearTimeout(configTimeout);
      const requestedShell = buf.toString('utf8').split(',')[1] || getDefaultShell();
      const shell: Shell = getDefaultShells().includes(requestedShell as ShellName)
        ? (requestedShell as Shell)
        : getDefaultShell();
      try {
        if (isWindows()) {
          child = spawn(
            shell === 'powershell' ? 'powershell.exe' : 'cmd.exe',
            shell === 'powershell'
              ? ['-NoLogo', '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; ']
              : [],
            { cwd: DEFAULT_CWD, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
          );
        } else {
          const bin = shell === 'sh' ? '/bin/sh' : '/bin/bash';
          child = spawn(bin, [], {
            cwd: DEFAULT_CWD,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        }
      } catch (err: any) {
        send('\r\n[错误] 无法启动宿主终端进程: ' + String(err?.message || err) + '\r\n');
        try { ws.close(); } catch { /* ignore */ }
        return;
      }

      child.stdout.on('data', (d: Buffer) => send(d));
      child.stderr.on('data', (d: Buffer) => send(d));
      child.on('error', (err) => {
        send('\r\n[错误] 宿主终端进程错误: ' + String(err?.message || err) + '\r\n');
        close();
      });
      child.on('close', () => {
        send('\r\n[DockerManager] 宿主终端会话已结束。\r\n');
        try { ws.close(); } catch { /* ignore */ }
      });

      // 启动后推送一个空提示，让前端知道已就绪
      send('\r\n[DockerManager] 已连接宿主机会话终端。\r\n');
      return;
    }

    // 普通输入转发给子进程
    if (child && buf.length > 0) {
      try {
        child.stdin.write(buf);
      } catch {
        // 进程已退出则忽略
      }
    }
  });

  ws.on('close', () => {
    try {
      if (child && child.exitCode === null) child.kill();
    } catch {
      // 忽略
    }
  });

  ws.on('error', () => {
    try {
      if (child && child.exitCode === null) child.kill();
    } catch {
      // 忽略
    }
  });
}
