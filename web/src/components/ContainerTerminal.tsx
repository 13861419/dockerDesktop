/**
 * 容器 Web 终端组件（基于 xterm.js + WebSocket）
 *
 * 连接后端 /ws/terminal/:id，在容器内启动交互式 shell。
 * 支持自动适配尺寸、输入转发、连接/错误状态展示。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './ContainerTerminal.less';
import { getToken } from '../api/auth';

interface ContainerTerminalProps {
  containerId: string;
  height?: number;
}

/**
 * 计算 WebSocket URL（基于当前页面协议，附带登录 token 供后端鉴权）
 */
function buildWsUrl(containerId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(containerId)}${qs}`;
}

/**
 * 容器终端组件
 * @param param0 组件属性
 */
export default function ContainerTerminal({ containerId, height = 360 }: ContainerTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'closed'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!hostRef.current) return;

    // 创建终端
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Consolas', monospace",
      theme: {
        background: '#1e2130',
        foreground: '#e4e6ef',
        cursor: '#6366f1',
        selectionBackground: '#6366f166',
      },
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    term.focus();

    setStatus('connecting');

    // 建立 WebSocket
    let ws: WebSocket;
    let alive = true;
    try {
      ws = new WebSocket(buildWsUrl(containerId));
      wsRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        setStatus('connected');
        // 首次同步尺寸
        sendResize(term, fit);
        term.write('\x1b[?25h');
      };

      ws.onmessage = (ev) => {
        if (!alive) return;
        try {
          if (typeof ev.data === 'string') {
            term.write(ev.data);
          } else {
            const buf = ev.data;
            term.write(new Uint8Array(buf));
          }
        } catch {
          // ignore binary handling fallback
        }
      };

      ws.onerror = () => {
        if (!alive) return;
        setStatus('error');
        setErrorMsg('WebSocket 连接错误');
      };

      ws.onclose = () => {
        if (!alive) return;
        setStatus('closed');
      };

      // 输入转发
      const disposeData = term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // 自定义 resize 消息：RESIZE,<cols>,<rows>
      const sendResize = (t: Terminal, f: FitAddon) => {
        try {
          f.fit();
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(`RESIZE,${t.cols},${t.rows}`);
          }
        } catch {
          // ignore
        }
      };

      // 监听容器尺寸变化
      const onResize = () => sendResize(term, fit);
      window.addEventListener('resize', onResize);
      const ro = new ResizeObserver(onResize);
      if (hostRef.current) ro.observe(hostRef.current);

      return () => {
        alive = false;
        disposeData.dispose();
        window.removeEventListener('resize', onResize);
        ro.disconnect();
        if (ws) ws.close();
        if (termRef.current) termRef.current.dispose();
        termRef.current = null;
      };
    } catch (err) {
      setStatus('error');
      setErrorMsg((err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId]);

  return (
    <div className="cterm" style={{ height }}>
      <div className="cterm__bar">
        <span className={`cterm__status cterm__status--${status}`}>●</span>
        <span className="cterm__text">
          {status === 'connecting' && '正在连接容器终端...'}
          {status === 'connected' && '已连接（输入 exit 退出）'}
          {status === 'closed' && '连接已关闭'}
          {status === 'error' && `连接失败：${errorMsg}`}
        </span>
      </div>
      <div className="cterm__host" ref={hostRef} />
    </div>
  );
}
