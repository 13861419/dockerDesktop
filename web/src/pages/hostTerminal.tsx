/**
 * 宿主机终端页面
 *
 * 非交互式命令执行器：在宿主机执行单条 PowerShell / cmd 命令并显示输出。
 * 后端维护会话工作目录，前端展示当前目录与命令历史。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '../api/client';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import { Select } from '../components/Form';
import './hostTerminal.less';

/** 输出行 */
interface Line {
  kind: 'prompt' | 'cmd' | 'out' | 'err' | 'muted';
  text: string;
}

/** 执行响应 */
interface ExecResponse {
  output: string;
  exitCode: number | null;
  cwd: string;
}

/** 终端信息 */
interface InfoResponse {
  cwd: string;
  shell: string;
  shells: string[];
}

/**
 * 宿主机终端页面组件
 */
export default function HostTerminalPage() {
  const { showToast } = useToast();
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 当前 shell
  const [shell, setShell] = useState('powershell');
  // 可用 shell
  const [shells, setShells] = useState<string[]>(['powershell', 'cmd']);
  // 当前工作目录
  const [cwd, setCwd] = useState('');
  // 输出行
  const [lines, setLines] = useState<Line[]>([]);
  // 命令输入
  const [command, setCommand] = useState('');
  // 正在执行
  const [running, setRunning] = useState(false);
  // 命令历史
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);

  /**
   * 追加输出行
   * @param line 行
   */
  const pushLine = useCallback((line: Line) => {
    setLines((prev) => [...prev, line]);
  }, []);

  /**
   * 初始化：拉取终端信息（当前目录、可用 shell）
   */
  const init = useCallback(async () => {
    try {
      const data = await get<InfoResponse>('/api/hostterminal/info');
      if (data) {
        setCwd(data.cwd || '');
        setShell(data.shell || 'powershell');
        if (Array.isArray(data.shells) && data.shells.length) {
          setShells(data.shells);
        }
      }
    } catch (e: any) {
      pushLine({ kind: 'err', text: `初始化失败：${e?.message || '无法连接后端'}` });
    }
    // 让输入框获得焦点
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushLine]);

  useEffect(() => {
    init();
  }, [init]);

  // 新行产生后自动滚动到底部
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  /**
   * 执行命令
   * @param cmd 命令文本
   */
  const exec = useCallback(
    async (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed) return;

      // 记录历史
      historyRef.current.push(trimmed);
      historyIdxRef.current = historyRef.current.length;

      const prompt = shell === 'powershell' ? `PS ${cwd}>` : `${cwd}>`;
      pushLine({ kind: 'prompt', text: prompt });
      pushLine({ kind: 'cmd', text: trimmed });

      setRunning(true);
      try {
        const resp = await post<ExecResponse>('/api/hostterminal/exec', {
          command: trimmed,
          shell,
        });
        const out = resp?.output || '';
        if (out) {
          pushLine({ kind: 'out', text: out.replace(/\s+$/, '') });
        }
        if (resp?.exitCode != null && resp.exitCode !== 0) {
          pushLine({ kind: 'err', text: `进程退出码：${resp.exitCode}` });
        }
        if (resp?.cwd) setCwd(resp.cwd);
      } catch (e: any) {
        pushLine({ kind: 'err', text: `执行失败：${e?.message || '未知错误'}` });
      } finally {
        setRunning(false);
      }
    },
    [shell, cwd, pushLine],
  );

  /**
   * 处理回车执行
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        exec(command);
        setCommand('');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const hist = historyRef.current;
        let idx = historyIdxRef.current - 1;
        if (idx < 0) idx = 0;
        historyIdxRef.current = idx;
        if (hist[idx] !== undefined) setCommand(hist[idx]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const hist = historyRef.current;
        let idx = historyIdxRef.current + 1;
        historyIdxRef.current = idx;
        setCommand(idx < hist.length ? hist[idx] : '');
      }
    },
    [exec, command],
  );

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">宿主机终端</h1>
        <p className="page__desc">在宿主机执行 PowerShell / cmd 命令</p>
      </div>

      <Card>
        <div className="ht-toolbar">
          <span className="ht-toolbar__cwd" title={cwd}>当前目录：{cwd || '加载中...'}</span>
          <Select
            className="ht-shell"
            value={shell}
            onChange={(e) => setShell(e.target.value)}
          >
            {shells.map((s) => (
              <option key={s} value={s}>{s === 'powershell' ? 'PowerShell' : 'CMD'}</option>
            ))}
          </Select>
          <Button variant="ghost" size="sm" onClick={init}>刷新</Button>
        </div>

        <div className="ht-terminal">
          <div className="ht-terminal__output" ref={outputRef}>
            {lines.length === 0 && (
              <div className="ht-output-line ht-output-line--muted">
                就绪。输入命令并按回车执行（如 dir、Get-Process、ipconfig）。
              </div>
            )}
            {lines.map((l, i) => (
              <div
                key={i}
                className={`ht-output-line ${l.kind === 'prompt' ? 'ht-output-line--prompt' : l.kind === 'cmd' ? 'ht-output-line--cmd' : l.kind === 'err' ? 'ht-output-line--err' : l.kind === 'muted' ? 'ht-output-line--muted' : ''}`}
              >
                {l.text}
              </div>
            ))}
          </div>
          <div className="ht-inputbar">
            <span className="ht-inputbar__prompt">
              {`${shell === 'powershell' ? 'PS' : ''} ${cwd || ''}>`}
            </span>
            <input
              ref={inputRef}
              className="ht-inputbar__input"
              value={command}
              placeholder="输入命令..."
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={running}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
