/**
 * K8s 节点指标采样与落库（1.9.0）
 *
 * - 每 60s 通过 metrics-server 采集各节点 CPU（核）与内存（字节）快照，写入 k8s_metrics 原始表
 * - 复用 metrics_hourly 小时级聚合：scope='k8s-node'，key=node 名（保留 90 天）
 * - 无 kubeconfig（K8s 不可用）时采样静默跳过，不影响面板其他功能
 */
import { getDb } from '../storage';
import { isK8sAvailable, metricsClient, parseQuantity } from './k8sClient';

/** 原始采样保留 7 天（与 host_metrics / container_metrics 一致） */
const RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 确保 k8s_metrics 原始采样表存在 */
export function ensureK8sMetricsTable(): void {
  getDb()
    .prepare(
      `CREATE TABLE IF NOT EXISTS k8s_metrics (
         ts INTEGER NOT NULL,
         node TEXT NOT NULL,
         cpu_cores REAL NOT NULL,
         mem_bytes INTEGER NOT NULL
       )`,
    )
    .run();
  getDb().prepare('CREATE INDEX IF NOT EXISTS idx_k8s_metrics_ts ON k8s_metrics (ts)').run();
}

/** 采样一轮：metrics-server 快照 → k8s_metrics（集群不可用时静默跳过） */
export async function sampleK8sMetrics(): Promise<number> {
  if (!isK8sAvailable()) return 0;
  try {
    const m = await metricsClient().getNodeMetrics();
    const ts = Date.now();
    const db = getDb();
    const ins = db.prepare('INSERT INTO k8s_metrics (ts, node, cpu_cores, mem_bytes) VALUES (?, ?, ?, ?)');
    let n = 0;
    db.exec('BEGIN');
    try {
      for (const it of m.items || []) {
        const cpuCores = parseQuantity(it.usage?.cpu);
        const memBytes = parseQuantity(it.usage?.memory);
        ins.run(ts, it.metadata?.name, cpuCores, Math.round(memBytes));
        n++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // 约 1/60 轮次执行一次过期清理（约每小时一次）
    if (Math.random() < 0.0167) {
      db.prepare('DELETE FROM k8s_metrics WHERE ts < ?').run(ts - RAW_RETENTION_MS);
    }
    return n;
  } catch {
    // metrics-server 未安装 / 集群临时不可达：静默跳过本轮
    return 0;
  }
}

/**
 * 聚合一个小时的 k8s 节点指标到 metrics_hourly（scope='k8s-node'，幂等）
 * @returns 聚合的采样条数
 */
export function rollupK8sHour(tsHour: number): number {
  ensureK8sMetricsTable();
  const db = getDb();
  const start = tsHour;
  const end = tsHour + 3600_000;
  const rows = db
    .prepare(
      `SELECT node AS key, count(*) AS samples,
              avg(cpu_cores) AS cpu_avg, max(cpu_cores) AS cpu_max,
              avg(mem_bytes) AS mem_avg, max(mem_bytes) AS mem_max
       FROM k8s_metrics WHERE ts >= ? AND ts < ?
       GROUP BY node`,
    )
    .all(start, end) as unknown as Array<{ key: string; samples: number; cpu_avg: number; cpu_max: number; mem_avg: number; mem_max: number }>;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO metrics_hourly
      (scope, key, ts_hour, samples, cpu_avg, cpu_max, mem_avg, mem_max, memp_avg, disk_avg, rx_sum, tx_sum)
     VALUES ('k8s-node', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  );
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(r.key, start, r.samples, r.cpu_avg, r.cpu_max, r.mem_avg, r.mem_max);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.reduce((acc, r) => acc + r.samples, 0);
}

/** 聚合行（K8s 节点维度） */
export interface K8sHourlyRow {
  ts_hour: number;
  samples: number;
  cpu_avg: number;
  cpu_max: number;
  mem_avg: number;
  mem_max: number;
}

/** 查询单节点的小时级聚合曲线 */
export function queryK8sNodeHourly(node: string, since: number): K8sHourlyRow[] {
  try {
    return getDb()
      .prepare(
        `SELECT ts_hour, samples, cpu_avg, cpu_max, mem_avg, mem_max
         FROM metrics_hourly WHERE scope = 'k8s-node' AND key = ? AND ts_hour >= ?
         ORDER BY ts_hour ASC`,
      )
      .all(node, since) as unknown as K8sHourlyRow[];
  } catch {
    return [];
  }
}

/** 查询集群级聚合曲线（所有节点求和） */
export function queryK8sClusterHourly(since: number): Array<{ bucket: number; cpuCores: number; memBytes: number }> {
  try {
    const rows = getDb()
      .prepare(
        `SELECT ts_hour, sum(cpu_avg) AS cpu, sum(mem_avg) AS mem
         FROM metrics_hourly WHERE scope = 'k8s-node' AND ts_hour >= ?
         GROUP BY ts_hour ORDER BY ts_hour ASC`,
      )
      .all(since) as unknown as Array<{ ts_hour: number; cpu: number; mem: number }>;
    return rows.map((r) => ({ bucket: r.ts_hour, cpuCores: r.cpu || 0, memBytes: r.mem || 0 }));
  } catch {
    return [];
  }
}

let started = false;

/** 启动 K8s 指标采样定时器（幂等；缺省 60s，集群不可用时静默跳过） */
export function startK8sMetricsCollector(intervalMs = 60_000): void {
  ensureK8sMetricsTable();
  if (started) return;
  started = true;
  const timer = setInterval(() => {
    try {
      sampleK8sMetrics();
    } catch {
      /* 静默 */
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[k8sMetrics] K8s 节点指标采样器已启动 (间隔 ${Math.round(intervalMs / 1000)}s)`);
}
