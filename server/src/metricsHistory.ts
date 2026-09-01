/**
 * 指标小时级聚合（rollup）与长周期历史查询
 *
 * 原始采样表（host_metrics / container_metrics）仅保留 7 天；
 * 本模块每小时对上一整小时的数据做聚合写入 metrics_hourly，
 * 使 30 天 / 90 天级别的长周期曲线成为可能（聚合表保留 90 天）。
 *
 * - scope='host'：聚合自 host_metrics（key 固定 'host'）
 * - scope='container'：聚合自 container_metrics（key 为容器 id），rx_sum/tx_sum 为周期内增量之和
 *
 * rollupByHour(tsHour) 幂等：同 (scope, key, ts_hour) 重复执行时覆盖写入。
 */
import { getDb } from './storage';

/** 聚合表保留时长（毫秒）：90 天 */
const ROLLUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** 小时起点（毫秒时间戳对齐 UTC 整点） */
export function hourStart(ts: number): number {
  return Math.floor(ts / 3600_000) * 3600_000;
}

/**
 * 聚合写入一个小时桶（幂等）
 * @param scope 'host' | 'container'
 * @param tsHour 小时起点（毫秒）
 */
export function rollupHour(scope: 'host' | 'container', tsHour: number): number {
  const db = getDb();
  const start = tsHour;
  const end = tsHour + 3600_000;
  let n = 0;
  if (scope === 'host') {
    const row = db
      .prepare(
        `SELECT count(*) AS samples,
                avg(cpu_percent) AS cpu_avg, max(cpu_percent) AS cpu_max,
                avg(mem_percent) AS memp_avg, avg(mem_used) AS mem_avg, max(mem_used) AS mem_max,
                avg(mem_total) AS mem_total, avg(cpu_cores) AS cores, avg(disk_percent) AS disk_avg,
                min(net_rx) AS rx_min, max(net_rx) AS rx_max,
                min(net_tx) AS tx_min, max(net_tx) AS tx_max,
                avg(containers_running) AS ctn_avg, avg(images) AS img_avg
         FROM host_metrics WHERE ts >= ? AND ts < ?`,
      )
      .get(start, end) as
      | { samples: number; cpu_avg: number; cpu_max: number; memp_avg: number; mem_avg: number; mem_max: number; mem_total: number; cores: number; disk_avg: number; rx_min: number; rx_max: number; tx_min: number; tx_max: number; ctn_avg: number; img_avg: number }
      | undefined;
    if (!row || !row.samples) return 0;
    db.prepare(
      `INSERT OR REPLACE INTO metrics_hourly
        (scope, key, ts_hour, samples, cpu_avg, cpu_max, mem_avg, mem_max, memp_avg, disk_avg, rx_sum, tx_sum,
         cpu_cores, mem_total, ctn_avg, img_avg)
       VALUES ('host', 'host', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      start,
      row.samples,
      row.cpu_avg,
      row.cpu_max,
      row.mem_avg,
      row.mem_max,
      row.memp_avg,
      row.disk_avg,
      Math.max(0, row.rx_max - row.rx_min),
      Math.max(0, row.tx_max - row.tx_min),
      Math.round(row.cores) || 0,
      Math.round(row.mem_total) || 0,
      row.ctn_avg,
      row.img_avg,
    );
    n = row.samples;
  } else {
    // 容器侧：按容器分组聚合，网络增量直接求和（rx_delta/tx_delta 为周期增量）
    const rows = db
      .prepare(
        `SELECT container_id AS key, count(*) AS samples,
                avg(cpu_percent) AS cpu_avg, max(cpu_percent) AS cpu_max,
                avg(mem_usage) AS mem_avg, max(mem_usage) AS mem_max,
                avg(mem_percent) AS memp_avg,
                0 AS disk_avg,
                sum(rx_delta) AS rx_sum, sum(tx_delta) AS tx_sum
         FROM container_metrics WHERE ts >= ? AND ts < ?
         GROUP BY container_id`,
      )
      .all(start, end) as unknown as Array<{ key: string; samples: number; cpu_avg: number; cpu_max: number; mem_avg: number; mem_max: number; memp_avg: number; disk_avg: number; rx_sum: number; tx_sum: number }>;
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO metrics_hourly
        (scope, key, ts_hour, samples, cpu_avg, cpu_max, mem_avg, mem_max, memp_avg, disk_avg, rx_sum, tx_sum)
       VALUES ('container', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        stmt.run(r.key, start, r.samples, r.cpu_avg, r.cpu_max, r.mem_avg, r.mem_max, r.memp_avg, r.disk_avg, r.rx_sum, r.tx_sum);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    n = rows.reduce((acc, r) => acc + r.samples, 0);
  }
  return n;
}

/**
 * 执行一轮 rollup：聚合"上一个完整小时"的数据并清理 90 天前的旧聚合。
 * 由定时器每 15 分钟调用（幂等，重复执行只覆盖写同一小时桶）。
 * @returns 本轮聚合的采样条数（0 = 无新数据）
 */
export function runHourlyRollup(): number {
  let total = 0;
  try {
    const prevHour = hourStart(Date.now() - 3600_000);
    total += rollupHour('host', prevHour);
    total += rollupHour('container', prevHour);
    // 每约 24 次执行（约 6 小时）清一次过期聚合行
    const db = getDb();
    rollupCount += 1;
    if (rollupCount % 24 === 0) {
      db.prepare('DELETE FROM metrics_hourly WHERE ts_hour < ?').run(Date.now() - ROLLUP_RETENTION_MS);
    }
  } catch (err) {
    console.error('[metricsHistory] 小时级聚合失败:', (err as Error)?.message);
  }
  return total;
}

let rollupCount = 0;
let started = false;

/** 启动小时级聚合定时器（幂等；每 15 分钟聚合上一小时数据） */
export function startMetricsHistory(): void {
  if (started) return;
  started = true;
  // 启动时先补聚合一次（覆盖停机期间错过的小时）
  rollupHour('host', hourStart(Date.now() - 3600_000));
  rollupHour('container', hourStart(Date.now() - 3600_000));
  const timer = setInterval(runHourlyRollup, 15 * 60 * 1000);
  if (timer.unref) timer.unref();
  console.log('[metricsHistory] 指标小时级聚合器已启动 (间隔 15min)');
}

/** 聚合表行结构（查询用） */
export interface HourlyRow {
  ts_hour: number;
  samples: number;
  cpu_avg: number;
  cpu_max: number;
  mem_avg: number;
  mem_max: number;
  memp_avg: number;
  disk_avg: number;
  rx_sum: number;
  tx_sum: number;
  cpu_cores: number;
  mem_total: number;
  ctn_avg: number;
  img_avg: number;
}

/**
 * 查询小时级聚合数据
 * @param scope 'host' | 'container'
 * @param key host 固定 'host'；container 为容器 id
 * @param since 起始时间（毫秒）
 */
export function queryHourly(scope: 'host' | 'container', key: string, since: number): HourlyRow[] {
  try {
    return getDb()
      .prepare(
        `SELECT ts_hour, samples, cpu_avg, cpu_max, mem_avg, mem_max, memp_avg, disk_avg, rx_sum, tx_sum,
                cpu_cores, mem_total, ctn_avg, img_avg
         FROM metrics_hourly WHERE scope = ? AND key = ? AND ts_hour >= ?
         ORDER BY ts_hour ASC`,
      )
      .all(scope, key, since) as unknown as HourlyRow[];
  } catch (err) {
    console.error('[metricsHistory] 聚合查询失败:', (err as Error)?.message);
    return [];
  }
}
