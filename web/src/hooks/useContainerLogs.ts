/**
 * 容器实时日志 hook（基于 SSE 流式读取）
 *
 * 通过 fetch + ReadableStream 订阅 /api/containers/:id/logs/stream 持续接收日志行。
 * 之所以不用原生 EventSource：日志接口在 requireAuth 鉴权下需携带 Authorization header，
 * 而 EventSource 无法自定义请求头，会导致 401 断连。故改用 fetch 手动解析 SSE。
 * 支持指数退避重连、重连上限、容器停止时停止重连。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from '../api/auth';

export interface LogLine {
  id: number;
  type: 'stdout' | 'stderr';
  text: string;
}

interface Options {
  tail?: number;
  autoStart?: boolean;
}

/** 最大重连次数 */
const MAX_RETRIES = 20;
/** 初始退避延迟（ms），之后每次翻倍 */
const INITIAL_RETRY_DELAY = 1000;
/** 最大退避延迟（ms） */
const MAX_RETRY_DELAY = 15000;

/**
 * 容器实时日志 hook
 * @param containerId 容器 ID（为空时不连接）
 * @param options 选项
 */
export function useContainerLogs(containerId: string | null, options: Options = {}) {
  const { tail = 200, autoStart = true } = options;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const linesRef = useRef<LogLine[]>([]);
  const maxRef = useRef(1000); // 内存中最多保留行数，防止无限增长
  const retryRef = useRef(0); // 当前重连次数
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false); // 容器已停止（不再重连）

  // 内部追加日志行
  const appendLine = useCallback((type: 'stdout' | 'stderr', text: string) => {
    const l: LogLine = { id: ++idRef.current, type, text };
    linesRef.current = [...linesRef.current, l];
    if (linesRef.current.length > maxRef.current) {
      linesRef.current = linesRef.current.slice(-maxRef.current);
    }
    setLines([...linesRef.current]);
  }, []);

  const clear = useCallback(() => {
    linesRef.current = [];
    setLines([]);
  }, []);

  /**
   * 停止日志流（主动断开，清空状态）
   */
  const stop = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    stoppedRef.current = true;
    setConnected(false);
  }, []);

  /**
   * 解析 SSE 响应流中的 data: 行并追加日志
   * @param res fetch 响应
   * @param signal 中止信号（用于断连时退出读取循环）
   */
  async function consumeStream(res: Response, signal: AbortSignal): Promise<boolean> {
    if (!res.ok || !res.body) {
      // 鉴权失败等 HTTP 错误：置 error 并返回“需要停止重连”=false 交由外部处理
      setError(`日志流连接失败 (${res.status})`);
      return false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // 按换行切分 SSE 事件行
        const linesArr = buffer.split('\n');
        buffer = linesArr.pop() || '';
        for (const line of linesArr) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (parsed && typeof parsed.text === 'string') {
            appendLine(parsed.type === 'stderr' ? 'stderr' : 'stdout', parsed.text);
          } else if (parsed && parsed.type === 'error') {
            // 容器已停止等确定性错误：置 error 并停止重连
            setError(parsed.text || '日志流错误');
            if (parsed.stopped) {
              stoppedRef.current = true;
              return false;
            }
          }
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // 主动断开，不视为错误
        return true;
      }
      throw e;
    } finally {
      try {
        reader.cancel();
      } catch {
        // 忽略取消失败
      }
    }
    // 读满自然结束：视为需要重连（可能因容器重启/网络断裂）
    return !stoppedRef.current;
  }

  /**
   * 建立日志流连接
   */
  const start = useCallback(() => {
    if (!containerId || abortRef.current) return;
    setError('');
    setConnected(false);
    const controller = new AbortController();
    abortRef.current = controller;
    stoppedRef.current = false;
    const token = getToken();

    const connect = async () => {
      try {
        const res = await fetch(
          `/api/containers/${encodeURIComponent(containerId)}/logs/stream?tail=${tail}&follow=true`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
          },
        );
        setConnected(true);
        const shouldRetry = await consumeStream(res, controller.signal);
        if (!shouldRetry) return;
        scheduleRetry(controller);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        if (stoppedRef.current) return;
        setError('日志流连接中断，正在重连...');
        scheduleRetry(controller);
      }
    };

    /**
     * 指数退避调度重连；超出上限则停止
     * @param controller 当前连接的中止控制器
     */
    const scheduleRetry = (controller: AbortController) => {
      if (stoppedRef.current || retryRef.current >= MAX_RETRIES) {
        setError(retryRef.current >= MAX_RETRIES ? '日志流重连次数过多，已停止自动重连' : '');
        setConnected(false);
        return;
      }
      const delay = Math.min(INITIAL_RETRY_DELAY * 2 ** retryRef.current, MAX_RETRY_DELAY);
      retryRef.current += 1;
      retryTimerRef.current = setTimeout(async () => {
        if (abortRef.current === controller) {
          await connect();
        }
      }, delay);
    };

    connect();
  }, [containerId, tail, appendLine]);

  useEffect(() => {
    if (autoStart && containerId) {
      start();
    }
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId]);

  return { lines, connected, error, start, stop, clear };
}
