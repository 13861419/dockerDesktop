/**
 * Docker 日志解析工具（共享，零依赖）
 *
 * 将 dockerode `container.logs()` 返回的多路复用 Buffer 解析为带流类型与时间戳的文本行，
 * 供「日志聚合中心」及 AI 日志分析等跨模块复用。区别于 containers.ts 内部私有实现，
 * 本工具更关注结构化输出（stream / ts / text），便于排序与过滤。
 */
import type Dockerode from 'dockerode';

/** 单行解析结果 */
export interface LogLine {
  stream: 'stdout' | 'stderr';
  /** 时间戳（ms，若容器日志未开启 timestamps 则为 undefined，由调用方补序） */
  ts?: number;
  text: string;
}

/** 解析多路复用日志缓冲 → 结构化行数组（纯函数，便于单测） */
export function demuxLogToLines(buf: Buffer | any, opts: { tty?: boolean; timestamps?: boolean } = {}): LogLine[] {
  const { tty = false, timestamps = false } = opts;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
  const lines: LogLine[] = [];
  if (tty) {
    // TTY：纯字节流，整段作为 stdout
    const text = buf.toString('utf8');
    for (const raw of text.split(/\r?\n/)) {
      if (!raw) continue;
      if (timestamps) {
        lines.push(extractTs(raw, 'stdout'));
      } else {
        lines.push({ stream: 'stdout', text: raw });
      }
    }
    return lines;
  }
  // 多路复用：8 字节头（streamType + 4 字节长度）+ payload
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const streamType = buf[pos];
    const payloadLen = buf.readUInt32BE(pos + 4);
    if (pos + 8 + payloadLen > buf.length) break;
    const payload = buf.subarray(pos + 8, pos + 8 + payloadLen).toString('utf8');
    pos += 8 + payloadLen;
    const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';
    for (const raw of payload.split(/\r?\n/)) {
      if (!raw) continue;
      if (timestamps) {
        lines.push(extractTs(raw, stream));
      } else {
        lines.push({ stream, text: raw });
      }
    }
  }
  // 末尾残余（通常无）
  if (pos < buf.length) {
    const rest = buf.subarray(pos).toString('utf8').trim();
    if (rest) lines.push({ stream: 'stdout', text: rest });
  }
  return lines;
}

/** 从带时间戳前缀的行中解析出 ts（秒字符串 "2026-01-01T00:00:00.000000000Z" 或 秒/纳秒数字） */
function extractTs(raw: string, stream: 'stdout' | 'stderr'): LogLine {
  let ts: number | undefined;
  let text = raw;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s?(.*)$/s);
  if (m) {
    const t = Date.parse(m[1]);
    if (!Number.isNaN(t)) {
      ts = t;
      text = m[2] || '';
    }
  } else {
    const num = raw.match(/^([\d.]+)\s?(.*)$/);
    if (num) {
      const v = Number(num[1]);
      if (Number.isFinite(v)) {
        // Docker 时间戳为秒（可带小数纳秒）；>1e12 视为纳秒，否则按秒补 ms
        ts = v > 1e12 ? v / 1e6 : v * 1000;
        text = num[2] || '';
      }
    }
  }
  return { stream, ts, text: text || raw };
}

/** 拉取单个容器日志 → 结构化行（tail/since/until 透传） */
export async function fetchContainerLogLines(
  docker: Dockerode,
  containerId: string,
  opts: { tail?: number; since?: number; until?: number; timestamps?: boolean } = {},
): Promise<{ name: string; lines: LogLine[] }> {
  const container = docker.getContainer(containerId);
  let name: string = containerId.slice(0, 12);
  let tty = false;
  try {
    const insp: any = await container.inspect();
    const n = insp?.Name || insp?.Config?.Hostname;
    if (typeof n === 'string' && n) name = n.replace(/^\//, '');
    tty = !!insp?.Config?.Tty;
  } catch {
    // 容器不可见则用 id 前缀
  }
  const logOpts: any = { stdout: true, stderr: true, follow: false };
  const tail = Number.isFinite(opts.tail) ? opts.tail as number : 0;
  const since = Number.isFinite(opts.since) ? opts.since as number : 0;
  const until = Number.isFinite(opts.until) ? opts.until as number : 0;
  if (tail > 0) logOpts.tail = tail;
  if (since > 0) logOpts.since = since;
  if (until > 0) logOpts.until = until;
  if (opts.timestamps) logOpts.timestamps = true;

  let buf: Buffer;
  try {
    buf = (await container.logs(logOpts) as unknown) as Buffer;
  } catch {
    buf = Buffer.alloc(0);
  }
  const lines = demuxLogToLines(buf, { tty, timestamps: opts.timestamps });
  return { name, lines };
}

/** 去除 ANSI 转义序列（用于终端类日志清理） */
export function stripAnsi(text: string): string {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}
