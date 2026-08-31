/**
 * 宿主机终端页面（会话式交互终端）
 *
 * 通过 WebSocket 连接后端 /ws/hostterminal，在宿主机维持一个长驻的
 * PowerShell / cmd 会话，前端用 xterm.js 提供实时交互界面：
 *  - 输入（含按键）实时转发至子进程
 *  - 子进程输出实时回显
 *  - 支持 shell 切换、连接状态展示与手动重连
 *
 * 保留了后端 REST exec 接口作为兼容（本页面改用 WS 会话式交互）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getToken } from '../api/auth';
import { useCanManage } from '../hooks/useCanManage';
import Card from '../components/Card';
import Button from '../components/Button';
import { Select } from '../components/Form';
import { translateNow as t } from '../i18n';
import './hostTerminal.less';

/** 连接状态 */
type ConnState = 'connecting' | 'connected' | 'closed' | 'error';

/**
 * 计算宿主终端 WebSocket URL（附带鉴权 token）
 * @param shell 期望的 shell 类型
 */
function buildWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${window.location.host}/ws/hostterminal${qs}`;
}

/**
 * 宿主机终端页面组件
 */
export default function HostTerminalPage() {
  // 是否为管理员（可执行宿主机命令）：采用服务端权威角色判定，防止基于被篡改的 localStorage 误放行
  const { canManage, checking } = useCanManage();

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // 当前与目标 shell
  const [shell, setShell] = useState('powershell');
  const [connState, setConnState] = useState<ConnState>('connecting');

  /**
   * 断开当前 WebSocket 并清理
   */
  const teardown = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch { /* ignore */ }
    }
    wsRef.current = null;
  }, []);

  /**
   * 建立（或重建）WebSocket 会话终端连接
   * @param targetShell 目标 shell
   */
  const connect = useCallback(
    (targetShell: string) => {
      teardown();
      setConnState('connecting');
      const term = termRef.current;
      if (!term) return;

      const ws = new WebSocket(buildWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(`CONFIG,${targetShell}`);
        setConnState('connected');
        term.focus();
        fitRef.current?.fit();
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          term.write(ev.data);
        }
      };

      ws.onerror = () => {
        setConnState('error');
      };

      ws.onclose = () => {
        setConnState((prev) => (prev === 'connecting' ? 'error' : 'closed'));
      };
    },
    [teardown],
  );

  // 初始化终端并建立连接
  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Consolas', monospace",
      theme: {
        background: '#0f1117',
        foreground: '#d5d8de',
        cursor: '#7ee787',
        selectionBackground: '#7ee78733',
      },
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;

    // 输入转发：前端按键写入 WebSocket（由后端写入子进程 stdin）
    const disposeData = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const onResize = () => {
      try {
        fit.fit();
      } catch { /* ignore */ }
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    if (hostRef.current) ro.observe(hostRef.current);

    // 有权限时才建立连接（后端也会强制校验）
    if (canManage && !checking) {
      connect(shellRef.current);
    }

    return () => {
      disposed = true;
      disposeData.dispose();
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      teardown();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保存当前 shell 到 ref，供 effect 内读取最新值
  const shellRef = useRef(shell);
  shellRef.current = shell;

  // 权限就绪后自动建连（初次加载时 useCanManage 正在校验）
  useEffect(() => {
    if (canManage && !checking && termRef.current && wsRef.current === null) {
      connect(shell);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, checking]);

  // 切换 shell 后重建连接
  useEffect(() => {
    if (canManage && !checking && termRef.current) {
      connect(shell);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell]);

  // 断开连接（供用户手动断开）
  const disconnect = useCallback(() => {
    teardown();
    setConnState('closed');
  }, [teardown]);

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">{t('宿主机终端')}</h1>
        <p className="page__desc">{t('在宿主机执行 PowerShell / cmd 命令（会话式交互终端）')}</p>
      </div>

      <Card>
        <div className="ht-toolbar">
          <span className={`ht-toolbar__state ht-toolbar__state--${connState}`}>
            {t('状态：')}{connState === 'connecting' && t('连接中...')}
            {connState === 'connected' && t('已连接')}
            {connState === 'closed' && t('已断开')}
            {connState === 'error' && t('连接失败')}
          </span>
          <Select
            className="ht-shell"
            value={shell}
            onChange={(e) => setShell(e.target.value)}
            disabled={!canManage || connState === 'connecting'}
          >
            <option value="powershell">PowerShell</option>
            <option value="cmd">CMD</option>
            <option value="bash">Bash</option>
            <option value="sh">sh</option>
          </Select>
          {connState === 'connected' ? (
            <Button variant="ghost" size="sm" onClick={disconnect}>{t('断开')}</Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => connect(shell)}>{t('连接')}</Button>
          )}
        </div>

        <div className="ht-terminal">
          <div className="ht-terminal__host" ref={hostRef} />
          {(!canManage || checking) && (
            <div className="ht-terminal__guard">
              {checking ? t('正在确认权限，请稍候...') : t('当前账号无管理员权限，无法使用宿主机终端。')}
            </div>
          )}
        </div>

        <div className="ht-tip">
          {t('提示：在终端中输入 exit 或按 Ctrl+D 结束会话；可用方向键查看输入历史。该会话基于长驻子进程实现，')}
          {t('全屏交互类程序（如 vim / top）因非 PTY 环境可能表现受限。')}
        </div>
      </Card>
    </div>
  );
}
