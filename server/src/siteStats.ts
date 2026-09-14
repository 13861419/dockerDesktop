/**
 * 站点访问统计（1.62.0）
 *
 * 后台每分钟增量读取内置反代容器（dm-reverse-proxy）的访问日志，
 * 按域名聚合为日粒度请求统计（site_stats 表，保留 90 天）：
 *
 *  - nginx log_format 由 routes/sites.ts 注入："$host $status $time_iso8601 \"$request\""
 *  - 游标持久化于 setting 表（siteStats.since），按行时间戳去重
 */
import { fetchContainerLogLines } from './docker/logUtil';
import { getDockerClient } from './docker/client';
import { getDb } from './storage';

/** 反代容器名（与 routes/sites.ts 保持一致） */
const PROXY_CONTAINER = 'dm-reverse-proxy';

/** 统计保留天数 */
const KEEP_DAYS = 90;

/** 采集循环句柄 */
let timer: ReturnType<typeof setInterval> | null = null;

/** 读取游标（setting 表原始读写，非注册键） */
function loadCursor(): number {
  try {
    const row = getDb().prepare("SELECT value FROM setting WHERE key = 'siteStats.since'").get() as any;
    const v = Number(row?.value);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function saveCursor(v: number): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO setting (key, value) VALUES ('siteStats.since', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(Math.floor(v)));
  } catch {
    // 游标持久化失败不影响采集
  }
}

/** 解析一行 nginx 访问日志（dm_stats 格式："$host $status $time_iso8601 \"$request\""） */
export function parseAccessLine(text: string): { host: string; status: number } | null {
  const m = text.match(/^(\S+)\s+(\d{3})\s+/);
  if (!m) return null;
  const host = m[1];
  if (host === '_' || host === '-' || !host) return null;
  return { host, status: Number(m[2]) };
}

/** 当天日期（UTC YYYY-MM-DD，与日聚合键一致） */
function dayOf(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

/** 执行一轮增量采集 */
export async function runSiteStatsSweep(): Promise<{ lines: number; inserted: number }> {
  const docker = await getDockerClient();
  let cursor = loadCursor();
  if (!cursor) cursor = Math.floor(Date.now() / 1000) - 86400; // 首次：回看 1 天
  let maxTs = cursor;

  let lines: Array<{ ts: number; stream: string; text: string }>;
  try {
    const { lines: raw } = await fetchContainerLogLines(docker, PROXY_CONTAINER, {
      since: cursor,
      tail: 20000,
      timestamps: true,
    });
    lines = raw as any;
  } catch {
    // 反代容器不存在时静默跳过
    return { lines: 0, inserted: 0 };
  }

  const db = getDb();
  const init = db.prepare('INSERT OR IGNORE INTO site_stats (domain, day, requests, e4xx, e5xx) VALUES (?, ?, 0, 0, 0)');
  const upsert = db.prepare(
    `INSERT INTO site_stats (domain, day, requests, e4xx, e5xx) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(domain, day) DO UPDATE SET
       requests = requests + 1,
       e4xx = e4xx + excluded.e4xx,
       e5xx = e5xx + excluded.e5xx`,
  );

  let inserted = 0;
  for (const l of lines) {
    if (!(l.ts > cursor)) continue;
    const parsed = parseAccessLine(l.text);
    if (!parsed) continue;
    const day = dayOf(l.ts);
    init.run(parsed.host, day);
    const e4xx = parsed.status >= 400 && parsed.status < 500 ? 1 : 0;
    const e5xx = parsed.status >= 500 ? 1 : 0;
    upsert.run(parsed.host, day, e4xx, e5xx);
    inserted++;
    if (l.ts > maxTs) maxTs = l.ts;
  }

  if (maxTs > cursor) saveCursor(maxTs);
  return { lines: lines.length, inserted };
}

/** 访问统计汇总（站点页展示用） */
export function getSiteStats(
  days = 7,
): {
  daily: Array<{ day: string; requests: number; e4xx: number; e5xx: number }>;
  domains: Array<{ domain: string; requests: number; e4xx: number; e5xx: number; today: number }>;
} {
  const db = getDb();
  const since = Date.now() - Math.min(Math.max(days, 1), 90) * 24 * 3600 * 1000;
  const dayStr = new Date(since).toISOString().slice(0, 10);
  const today = dayOf(Math.floor(Date.now() / 1000));

  const daily = (
    db
      .prepare(
        `SELECT day, SUM(requests) AS requests, SUM(e4xx) AS e4xx, SUM(e5xx) AS e5xx
         FROM site_stats WHERE day >= ? GROUP BY day ORDER BY day ASC`,
      )
      .all(dayStr) as unknown as Array<{ day: string; requests: number; e4xx: number; e5xx: number }>
  ).map((r) => ({ day: r.day, requests: Number(r.requests), e4xx: Number(r.e4xx), e5xx: Number(r.e5xx) }));

  const domains = (
    db
      .prepare(
        `SELECT domain, SUM(requests) AS requests, SUM(e4xx) AS e4xx, SUM(e5xx) AS e5xx,
           COALESCE(SUM(CASE WHEN day = ? THEN requests END), 0) AS today
         FROM site_stats WHERE day >= ? GROUP BY domain ORDER BY requests DESC`,
      )
      .all(today, dayStr) as unknown as Array<{ domain: string; requests: number; e4xx: number; e5xx: number; today: number }>
  ).map((r) => ({
    domain: r.domain,
    requests: Number(r.requests),
    e4xx: Number(r.e4xx),
    e5xx: Number(r.e5xx),
    today: Number(r.today),
  }));

  return { daily, domains };
}

/** 清理过期统计行 */
export function pruneSiteStats(): number {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return Number(getDb().prepare('DELETE FROM site_stats WHERE day < ?').run(cutoff).changes);
}

/** 启动采集循环（每小时顺带清理过期行） */
export function startSiteStatsCollector(): void {
  if (timer) return;
  timer = setInterval(() => {
    runSiteStatsSweep()
      .then(() => pruneSiteStats())
      .catch(() => {});
  }, 60_000);
}

/** 停止采集循环（测试用） */
export function stopSiteStatsCollector(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
