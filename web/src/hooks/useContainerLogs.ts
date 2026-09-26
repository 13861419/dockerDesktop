/**
 * 容器实时日志 hook（基于 SSE 流式读取）
 *
 * 通过 fetch + ReadableStream 订阅 /api/containers/:id/logs/stream 持续接收日志行。
 * 之所以不用原生 EventSource：日志接口在 requireAuth 鉴权下需携带 Authorization header，
 * 而 EventSource 无法自定义请求头，会导致 401 断连。故改用 fetch 手动解析 SSE。
 * 支持指数退避重连、重连上限、容器停止时停止重连。
 */
import { useLogStream } from './useLogStream';

export type { LogLine } from './useLogStream';

interface Options {
  tail?: number;
  autoStart?: boolean;
}

/**
 * 容器实时日志 hook（useLogStream 的容器端点封装）
 * @param containerId 容器 ID（为空时不连接）
 * @param options 选项
 */
export function useContainerLogs(containerId: string | null, options: Options = {}) {
  const { tail = 200, autoStart = true } = options;
  const url = containerId
    ? `/api/containers/${encodeURIComponent(containerId)}/logs/stream?tail=${tail}&follow=true`
    : null;
  return useLogStream(url, { autoStart, maxLines: 1000 });
}
