/**
 * Docker 日志解析工具（共享，零依赖）
 *
 * 将 dockerode `container.logs()` 返回的多路复用 Buffer 解析为带流类型与时间戳的文本行，
 * 供「日志聚合中心」及 AI 日志分析等跨模块复用。
 *
 * 1.92.0 重构：合并原先散落在 containers.ts / registryCache.ts / ai.ts /
 * databases.ts / files.ts / volumeFiles.ts 的多份 demux 私有实现，
 * 统一在此维护：缓冲→文本、缓冲→行、流式按行分发、执行输出帧剥离等形态。
 */
import { StringDecoder } from 'string_decoder';
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

/**
 * ANSI 转义序列正则（SGR 颜色 / 光标控制等，含 8 位 CSI 引导符 \u009b）
 */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/** 去除 ANSI 转义序列（用于终端类日志清理，含颜色码与光标控制序列） */
export function stripAnsi(text: string): string {
  return String(text || '').replace(ANSI_RE, '');
}

/**
 * 行拆分器：跨多次 push 拼接尚未换行的残余内容（用于流式日志按行分发）
 */
export function createLineSplitter(onLine: (line: string, streamType: number) => void) {
  let pending = '';
  let pendingType = 0;
  return {
    push(text: string, streamType: number) {
      pendingType = streamType;
      const combined = pending + text;
      let start = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] === '\n') {
          const line = combined.slice(start, i);
          if (line) onLine(line, pendingType);
          start = i + 1;
        }
      }
      pending = combined.slice(start);
    },
    end() {
      if (pending) onLine(pending, pendingType);
      pending = '';
    },
  };
}

/**
 * 解复用容器日志流（SSE 实时日志用）
 *
 * 根据容器 TTY 配置自适应：
 *  - TTY：日志为纯字节流，StringDecoder 直接 UTF-8 解码后按行分发；
 *  - 非 TTY：解析 8 字节帧头，取出各帧载荷后同样按行分发。
 * streamType: 1=stdout(0 兼容), 2=stderr。
 * @param stream dockerode 日志流
 * @param tty 容器是否为 TTY 模式
 * @param onLine 每行回调
 */
export function demuxLogStream(
  stream: NodeJS.ReadableStream,
  tty: boolean,
  onLine: (text: string, streamType: number) => void
): void {
  const splitter = createLineSplitter(onLine);
  if (tty) {
    // TTY：纯字节流，UTF-8 解码后按行分发（TTY 下 stdout/stderr 合并，type 取 0）
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk: Buffer) => splitter.push(decoder.write(chunk), 0));
    stream.on('error', () => splitter.end());
    stream.on('end', () => {
      splitter.push(decoder.end(), 0);
      splitter.end();
    });
  } else {
    // 非 TTY：解析 8 字节帧头
    let buffer = Buffer.alloc(0);
    const decoder = new StringDecoder('utf8');
    const tryParse = () => {
      while (buffer.length >= 8) {
        const streamType = buffer[0];
        const payloadLen = buffer.readUInt32BE(4);
        if (buffer.length < 8 + payloadLen) break;
        splitter.push(decoder.write(buffer.subarray(8, 8 + payloadLen)), streamType);
        buffer = buffer.subarray(8 + payloadLen);
      }
    };
    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      tryParse();
    });
    stream.on('error', () => {
      buffer = Buffer.alloc(0);
      splitter.end();
    });
    stream.on('end', () => {
      splitter.push(decoder.end(), 0);
      splitter.end();
    });
  }
}

/**
 * 将容器日志缓冲解析为纯文本。
 *
 * Docker 日志存在两种格式，需按容器 TTY 配置区分：
 *  - TTY 容器（创建默认即 TTY）：日志为纯字节流，无帧头，直接按 UTF-8 解码；
 *  - 非 TTY 容器：8 字节帧头（streamType + payloadLen）的多路复用格式。
 *
 * 解析均使用 StringDecoder，避免 UTF-8 多字节字符在帧/块边界被截断导致乱码。
 * @param buf 原始日志缓冲
 * @param tty 容器是否为 TTY 模式
 * @returns 拼接后的纯文本日志
 */
export function demuxBufferToText(buf: Buffer | any, tty = false): string {
  if (!buf || buf.length === 0) return '';
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  // TTY：纯字节流，直接 UTF-8 解码
  if (tty) {
    return stripAnsi(new StringDecoder('utf8').write(buffer));
  }
  // 非 TTY：解析多路复用帧
  const decoder = new StringDecoder('utf8');
  let result = '';
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const payloadLen = buffer.readUInt32BE(offset + 4);
    if (buffer.length - offset < 8 + payloadLen) break;
    result += decoder.write(buffer.subarray(offset + 8, offset + 8 + payloadLen));
    offset += 8 + payloadLen;
  }
  result += decoder.end();
  return stripAnsi(result);
}

/**
 * 从 docker 多路复用流中解出文本输出（stdout/stderr 合并，自动识别无帧头纯文本）
 * @param buf 原始输出缓冲
 * @returns 合并后的文本（不做 ANSI 清理，由调用方按需处理）
 */
export function demuxToString(buf: Buffer): string {
  let out = '';
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset + 4);
    out += buf.slice(offset + 8, offset + 8 + len).toString('utf8');
    offset += 8 + len;
  }
  if (offset === 0 && buf.length) out = buf.toString('utf8');
  return out;
}

/**
 * 解析多路复用日志缓冲为帧数组（帧级，不拆行；残余经 UTF-8 解码器兜底输出）
 * @returns [streamType, payload] 数组；残余尾部以 streamType=0 产出
 */
export function demuxLogFrames(buf: Buffer | any): Array<[number, string]> {
  let buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const decoder = new StringDecoder('utf8');
  const frames: Array<[number, string]> = [];
  while (buffer.length >= 8) {
    const streamType = buffer[0];
    const payloadLen = buffer.readUInt32BE(4);
    if (buffer.length < 8 + payloadLen) break;
    frames.push([streamType, decoder.write(buffer.subarray(8, 8 + payloadLen))]);
    buffer = buffer.subarray(8 + payloadLen);
  }
  const tail = decoder.end();
  if (tail) frames.push([0, tail]);
  return frames;
}

/**
 * 创建多路复用流帧剥离器（exec 命令输出等流式增量场景）
 *
 * 跨多次调用累积缓冲，循环剥离完整帧（8 字节头 + payload），
 * 将各帧载荷文本经回调返回。
 */
export function createFrameStripper(onText: (text: string) => void): (chunk: Buffer | string) => void {
  let frameBuf = Buffer.alloc(0);
  return (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    frameBuf = Buffer.concat([frameBuf, buf]);
    // 循环剥离完整帧（8 字节头 + payload）
    while (frameBuf.length >= 8) {
      const payloadLen = frameBuf.readUInt32BE(4);
      if (frameBuf.length < 8 + payloadLen) break;
      onText(frameBuf.subarray(8, 8 + payloadLen).toString('utf8'));
      frameBuf = frameBuf.subarray(8 + payloadLen);
    }
  };
}
