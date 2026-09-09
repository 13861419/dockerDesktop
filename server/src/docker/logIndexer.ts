/**
 * 容器日志持久化索引（Phase 5 · 跨容器日志聚合增强）
 *
 * 后台采集循环（默认 60s 一轮，可用 logs.indexEnabled 设置开关）：
 *   对每个 running 容器按游标增量拉取新日志行（docker logs --since），
 *   写入 container_log_index 表；容器删除 / 重启不丢历史。
 *
 * 保留策略：logs.retentionDays（默认 7 天）+ 总行数上限 100 万（超限丢最旧）。
 *
 * 查询：GET /api/logs/history（routes/logs.ts 调用 queryLogHistory）。
 */
import { getDockerClient } from './client';
import { fetchContainerLogLines } from './logUtil';
import { getDb } from '../storage';
import { getSetting } from '../settings';

/** 采集循环句柄 */
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

/** 总行数上限（超出丢最旧） */
const MAX_ROWS = 1_000_000;

/** 索引开关（每轮实时读设置，改动即时生效） */
export function isIndexEnabled(): boolean {
  return getSetting<boolean>('logs.indexEnabled') === true;
}

function retentionDays(): number {
  const v = Number(getSetting<number>('logs.retentionDays') ?? 7);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.max(Math.floor(v), 1), 90) : 7;
}

/**
 * 执行一轮增量采集
 * @returns { scanned, inserted, skipped } 统计
 */
export async function runLogIndexSweep(): Promise<{ scanned: number; inserted: number; skipped: number }> {
  if (!isIndexEnabled()) return { scanned: 0, inserted: 0, skipped: 0 };
  const docker = await getDockerClient();
  const running = (await docker.listContainers({ all: false }).catch(() => [])) as any[];

  const db = getDb();
  let inserted = 0;
  let skipped = 0;

  for (const c of running) {
    const id: string = c.Id;
    const name: string = (c.Names?.[0] || '').replace(/^\//, '') || id.slice(0, 12);

    // 游标：上次采集到的最大 ts（秒级 Docker since 参数）
    const cursor = db.prepare('SELECT last_ts FROM container_log_cursor WHERE container_id = ?').get(id) as any;
    const lastTs: number = cursor?.last_ts || 0;

    const { lines } = await fetchContainerLogLines(docker, id, {
      since: lastTs > 0 ? lastTs : undefined,
      tail: 5000,
      timestamps: true,
    }).catch(() => ({ name, lines: [] as any[] }));

    // 只保留带时间戳且晚于游标的行（未开启 timestamps 的行无法排序，跳过）
    const fresh = lines.filter((l) => typeof l.ts === 'number' && l.ts > lastTs);
    if (fresh.length === 0) {
      skipped++;
      continue;
    }

    const insert = db.prepare(
      'INSERT INTO container_log_index (container_id, container_name, ts, stream, text) VALUES (?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    try {
      for (const l of fresh) {
        insert.run(id, name, Math.floor(l.ts!), l.stream, String(l.text || '').slice(0, 4000));
      }
      const maxTs = Math.max(...fresh.map((l) => Math.floor(l.ts!)));
      db.prepare(
        `INSERT INTO container_log_cursor (container_id, last_ts) VALUES (?, ?)
         ON CONFLICT(container_id) DO UPDATE SET last_ts = excluded.last_ts`,
      ).run(id, maxTs);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    inserted += fresh.length;
  }

  return { scanned: running.length, inserted, skipped };
}

/** 清理过期与超限行 */
export function pruneLogIndex(): { expired: number; overflow: number } {
  const db = getDb();
  const cutoff = Date.now() - retentionDays() * 24 * 3600 * 1000;
  const expired = Number(db.prepare('DELETE FROM container_log_index WHERE ts < ?').run(cutoff).changes);

  const count = Number((db.prepare('SELECT COUNT(*) AS n FROM container_log_index').get() as any).n);
  let overflow = 0;
  if (count > MAX_ROWS) {
    overflow = Number(
      db
        .prepare('DELETE FROM container_log_index WHERE id IN (SELECT id FROM container_log_index ORDER BY ts ASC, id ASC LIMIT ?)')
        .run(count - MAX_ROWS).changes,
    );
  }
  return { expired, overflow };
}

/**
 * 历史检索
 * @param opts containerIds 为空表示全部容器
 */
export function queryLogHistory(opts: {
  containerIds?: string[];
  keyword?: string;
  since?: number;
  until?: number;
  limit?: number;
}): { lines: Array<{ ts: number; container: string; stream: string; text: string }>; total: number; truncated: boolean } {
  const db = getDb();
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 5000);
  const conds: string[] = [];
  const params: any[] = [];

  if (opts.containerIds && opts.containerIds.length > 0) {
    conds.push(`container_id IN (${opts.containerIds.map(() => '?').join(',')})`);
    params.push(...opts.containerIds.slice(0, 20));
  }
  if (opts.since && opts.since > 0) {
    conds.push('ts >= ?');
    params.push(opts.since);
  }
  if (opts.until && opts.until > 0) {
    conds.push('ts <= ?');
    params.push(opts.until);
  }
  if (opts.keyword) {
    conds.push('text LIKE ?');
    params.push(`%${opts.keyword}%`);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM container_log_index ${where}`).get(...params) as any).n);
  const rows = db
    .prepare(`SELECT ts, container_name, stream, text FROM container_log_index ${where} ORDER BY ts ASC, id ASC LIMIT ?`)
    .all(...params, limit);

  return {
    lines: rows.map((r: any) => ({ ts: r.ts, container: r.container_name, stream: r.stream, text: r.text })),
    total,
    truncated: total > rows.length,
  };
}

/** 索引状态（供前端展示） */
export function getLogIndexStatus(): { enabled: boolean; rows: number; containers: number; oldestTs: number | null; newestTs: number | null } {
  const db = getDb();
  const stat = db
    .prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT container_id) AS c, MIN(ts) AS oldest, MAX(ts) AS newest FROM container_log_index')
    .get() as any;
  return {
    enabled: isIndexEnabled(),
    rows: Number(stat.n) || 0,
    containers: Number(stat.c) || 0,
    oldestTs: stat.oldest != null ? Number(stat.oldest) : null,
    newestTs: stat.newest != null ? Number(stat.newest) : null,
  };
}

/** 启动采集循环（每轮实时判断开关；含每小时清理） */
export function startLogIndexer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runLogIndexSweep().catch(() => {});
  }, 60_000);
  pruneTimer = setInterval(() => {
    pruneLogIndex();
  }, 3600_000);
}

/** 停止采集循环（测试用） */
export function stopLogIndexer(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  sweepTimer = null;
  pruneTimer = null;
}
