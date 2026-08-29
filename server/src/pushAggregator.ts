/**
 * 告警推送窗口聚合器
 *
 * 场景：大量容器同时退出/异常时，逐条推送会形成消息风暴。
 * 将同一窗口（默认 60s，可配 alerts.pushAggWindowSec，0=关闭）内的
 * warn/danger 推送合并为一条摘要；recovery 与窗口关闭时逐条即时推送。
 * 告警记录仍逐条落库（push_status='aggregated' 标识该条已被合并推送）。
 */
export interface AggregatedPushResult {
  status: 'ok' | 'failed' | 'aggregated';
  detail?: string;
}

/** 摘要文案：最多展示 5 条原文并附总条数 */
export function buildDigestText(messages: string[]): string {
  const MAX_SHOWN = 5;
  const shown = messages.slice(0, MAX_SHOWN);
  const lines = shown.map((m) => `• ${m}`).join('\n');
  const more = messages.length > MAX_SHOWN ? `\n…等共 ${messages.length} 条` : '';
  return `【告警聚合】窗口内共 ${messages.length} 条告警：\n${lines}${more}`;
}

/** 聚合缓冲级别键 */
type AggLevel = 'warn' | 'danger' | 'recovery';

export function createPushAggregator(
  send: (level: AggLevel, text: string) => Promise<{ ok: boolean; detail?: string }>,
  getWindowMs: () => number,
) {
  /** 按级别分桶缓冲：同级别同窗口合并为一条摘要（级别不同不混合，保证按级别路由语义正确） */
  const buffer = new Map<AggLevel, string[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 立即把缓冲区内容发出（单条原样，多条合并摘要） */
  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batches = Array.from(buffer.entries());
    buffer.clear();
    for (const [level, msgs] of batches) {
      if (msgs.length === 0) continue;
      const text = msgs.length === 1 ? msgs[0] : buildDigestText(msgs);
      try {
        await send(level, text);
      } catch {
        // 聚合消息发送失败不重投：逐条记录已标 aggregated，重投会再造风暴
      }
    }
  }

  /**
   * 提交一条推送：recovery 或窗口关闭时即时发送并回传结果；
   * 否则进入缓冲并立即返回 aggregated（结果由窗口到期后的聚合发送统一承载）
   */
  async function queue(level: AggLevel, message: string): Promise<AggregatedPushResult> {
    const windowMs = getWindowMs();
    if (windowMs <= 0 || level === 'recovery') {
      try {
        const res = await send(level, message);
        return { status: res.ok ? 'ok' : 'failed', detail: res.detail };
      } catch (err: any) {
        return { status: 'failed', detail: String(err?.message || err) };
      }
    }
    const bucket = buffer.get(level) || [];
    bucket.push(message);
    buffer.set(level, bucket);
    if (!timer) timer = setTimeout(() => { void flush(); }, windowMs);
    return { status: 'aggregated' };
  }

  return {
    queue,
    flush,
    pendingCount: () => Array.from(buffer.values()).reduce((n, msgs) => n + msgs.length, 0),
  };
}

export type PushAggregator = ReturnType<typeof createPushAggregator>;
