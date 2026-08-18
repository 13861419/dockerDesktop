/**
 * 容器资源指标采集器与历史趋势查询
 *
 * 参照 monitor.ts 中 host_metrics 的降采样落库模式，实现对每个运行中容器的
 * CPU / 内存 / 网络使用情况的周期性采集与持久化，供容器详情页历史趋势曲线使用。
 *
 * - 每 5 秒采集一次所有运行中容器的 stats（比主机级更频繁，因需覆盖多容器）
 * - 每 30 秒将各容器最近一次解析结果批量落库到 container_metrics
 * - 每 20 次落库（约 10 分钟）清理一次 7 天前的旧数据
 * - 采集失败不中断（Docker 可能临时不可用 / 单容器 stats 异常）
 */
import { getDockerClient } from './client';
import { getDb } from '../storage';
import { parseStats } from './stats';

/** 采集间隔（毫秒）：每 5 秒采集一次所有运行中容器的 stats */
const INTERVAL_MS = 5000;
/** 落库降采样间隔（毫秒）：每 30 秒向 container_metrics 批量写入一组记录 */
const PERSIST_INTERVAL_MS = 30000;
/** 旧数据保留时长（毫秒）：7 天 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 采集器是否已启动（幂等保护） */
let started = false;
/** 定时器句柄 */
let timer: NodeJS.Timeout | null = null;
/** 最近一次落库时间戳（毫秒） */
let lastPersistTs = 0;
/** 落库次数计数器，用于触发周期性旧数据清理（每 20 次约 10 分钟清一次） */
let persistCount = 0;

/**
 * 各容器上次采样的累计网络字节缓存（key=containerId）
 *
 * 用于计算本次采样周期内的网络增量（rx_delta / tx_delta）。
 * 容器首次出现时无历史记录，增量记为 0。
 */
const lastNetStats = new Map<string, { rx: number; tx: number }>();

/**
 * 单次采集：拉取所有运行中容器的 stats 并解析，按需降采样落库
 *
 * 流程：
 *  1. listContainers({ all: false }) 仅获取运行中容器
 *  2. 并发对每个容器执行 stats({ stream:false }) + parseStats
 *  3. 基于上次累计网络字节计算本周期增量，并更新缓存
 *  4. 距上次落库 >= 30 秒时，批量 INSERT 各容器最近一次解析结果
 *  5. 每 20 次落库清理 7 天前旧数据
 *
 * 任何阶段失败均打印错误后返回，不影响下一轮采集。
 */
async function collectContainerMetrics(): Promise<void> {
  try {
    const docker = await getDockerClient();
    const containers = await docker.listContainers({ all: false });
    if (!containers || containers.length === 0) {
      return;
    }
    const parsed = await Promise.all(
      containers.map(async (c) => {
        try {
          const raw = await docker.getContainer(c.Id).stats({ stream: false });
          return { id: c.Id, stats: parseStats(raw) };
        } catch (err) {
          console.error('[containerMetrics] 容器 stats 解析失败', c.Id.slice(0, 12), (err as Error)?.message);
          return null;
        }
      }),
    );
    const snapshot: Array<{
      id: string;
      cpuPercent: number;
      memUsage: number;
      memLimit: number;
      memPercent: number;
      netRx: number;
      netTx: number;
      rxDelta: number;
      txDelta: number;
    }> = [];
    for (const item of parsed) {
      if (!item) continue;
      const { id, stats } = item;
      const curRx = stats.network.rx;
      const curTx = stats.network.tx;
      const last = lastNetStats.get(id);
      const rxDelta = last ? Math.max(0, curRx - last.rx) : 0;
      const txDelta = last ? Math.max(0, curTx - last.tx) : 0;
      lastNetStats.set(id, { rx: curRx, tx: curTx });
      snapshot.push({
        id,
        cpuPercent: stats.cpuPercent,
        memUsage: stats.memory.usage,
        memLimit: stats.memory.limit,
        memPercent: stats.memory.percent,
        netRx: curRx,
        netTx: curTx,
        rxDelta,
        txDelta,
      });
    }
    if (lastNetStats.size > snapshot.length) {
      const live = new Set(snapshot.map((s) => s.id));
      for (const key of lastNetStats.keys()) {
        if (!live.has(key)) lastNetStats.delete(key);
      }
    }
    if (snapshot.length === 0) return;
    const now = Date.now();
    if (now - lastPersistTs < PERSIST_INTERVAL_MS) return;
    lastPersistTs = now;
    try {
      const db = getDb();
      const stmt = db.prepare(
        `INSERT INTO container_metrics
          (container_id, ts, cpu_percent, mem_usage, mem_limit, mem_percent,
           net_rx, net_tx, rx_delta, tx_delta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec('BEGIN');
      try {
        for (const s of snapshot) {
          stmt.run(
            s.id,
            now,
            s.cpuPercent,
            s.memUsage,
            s.memLimit,
            s.memPercent,
            s.netRx,
            s.netTx,
            s.rxDelta,
            s.txDelta,
          );
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      persistCount += 1;
      if (persistCount % 20 === 0) {
        const cutoff = now - RETENTION_MS;
        db.prepare('DELETE FROM container_metrics WHERE ts < ?').run(cutoff);
      }
    } catch (err) {
      console.error('[containerMetrics] 落库失败:', (err as Error)?.message);
    }
  } catch (err) {
    console.error('[containerMetrics] 采集失败:', (err as Error)?.message);
  }
}

/**
 * 重置容器指标采集器的内存状态（引擎切换后由 engines.ts 调用）。
 * 采集器每次 tick 现读当前引擎（resetDockerCache 后自动对准新引擎），无需重启定时器；
 * 此处仅清空按容器 id 缓存的网络增量基准，避免沿用旧引擎容器的字节计数。
 */
export function resetContainerMetricsState(): void {
  lastNetStats.clear();
  lastPersistTs = 0;
}

/**
 * 启动容器指标采集器（幂等）
 *
 * 立即执行一次采集，随后按 INTERVAL_MS 周期性采集。重复调用不会创建多个定时器。
 */
export function startContainerMetrics(): void {
  if (started) return;
  started = true;
  collectContainerMetrics();
  timer = setInterval(collectContainerMetrics, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log('[containerMetrics] 容器指标采集器已启动 (间隔 ' + INTERVAL_MS + 'ms)');
}

/**
 * 容器指标历史趋势查询返回的单个数据点
 */
export interface ContainerMetricPoint {
  /** 采样时间戳（毫秒） */
  timestamp: number;
  /** CPU 使用率（0-100） */
  cpuPercent: number;
  /** 内存使用量（字节） */
  memUsage: number;
  /** 内存上限（字节） */
  memLimit: number;
  /** 内存使用率（0-100） */
  memPercent: number;
  /** 累计接收字节 */
  netRx: number;
  /** 累计发送字节 */
  netTx: number;
  /** 本采样周期内接收增量（字节） */
  rxDelta: number;
  /** 本采样周期内发送增量（字节） */
  txDelta: number;
}

/** 历史趋势查询支持的时间范围 */
export type ContainerMetricsRange = '1h' | '24h' | '7d';

/** 各时间范围对应的回溯毫秒数 */
const RANGE_MS: Record<ContainerMetricsRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/** 各时间范围降采样桶大小（毫秒） */
const RANGE_BUCKET_MS: Record<ContainerMetricsRange, number> = {
  '1h': 60 * 1000,
  '24h': 600 * 1000,
  '7d': 1800 * 1000,
};

/** container_metrics 表行结构（仅供内部查询映射使用，字段与表定义一一对应） */
interface ContainerMetricRow {
  ts: number;
  cpu_percent: number;
  mem_usage: number;
  mem_limit: number;
  mem_percent: number;
  net_rx: number;
  net_tx: number;
  rx_delta: number;
  tx_delta: number;
}

/**
 * 将全量行按时间桶降采样，每个桶取最后一条（更贴近实时末值）
 *
 * 输入需按 ts 升序排列；输出的时间点为各桶内最后一条记录。
 * @param rows 已按 ts 升序排列的原始行
 * @param bucketMs 桶大小（毫秒）
 * @returns 降采样后的行数组
 */
function downsampleContainerRows(rows: ContainerMetricRow[], bucketMs: number): ContainerMetricRow[] {
  if (rows.length === 0) return [];
  const out: ContainerMetricRow[] = [];
  let currentBucket = Math.floor(rows[0].ts / bucketMs);
  let lastInBucket: ContainerMetricRow = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const bucket = Math.floor(rows[i].ts / bucketMs);
    if (bucket !== currentBucket) {
      out.push(lastInBucket);
      currentBucket = bucket;
      lastInBucket = rows[i];
    } else {
      lastInBucket = rows[i];
    }
  }
  out.push(lastInBucket);
  return out;
}

/**
 * 将 container_metrics 表行映射为对外暴露的数据点
 * @param r 数据库行
 * @returns 历史趋势数据点
 */
function mapContainerMetricRow(r: ContainerMetricRow): ContainerMetricPoint {
  return {
    timestamp: r.ts,
    cpuPercent: r.cpu_percent,
    memUsage: r.mem_usage,
    memLimit: r.mem_limit,
    memPercent: r.mem_percent,
    netRx: r.net_rx,
    netTx: r.net_tx,
    rxDelta: r.rx_delta,
    txDelta: r.tx_delta,
  };
}

/**
 * 查询指定容器在指定时间范围内的历史资源指标趋势
 *
 * 从 container_metrics 表读取原始记录并按桶降采样，避免返回过多点导致前端渲染压力。
 * @param containerId 容器 id（完整 64 字符）
 * @param range 时间范围，默认 1h
 * @returns 数据点数组（按时间升序）；查询失败时返回空数组
 */
export function getContainerMetricsHistory(
  containerId: string,
  range: ContainerMetricsRange = '1h',
): ContainerMetricPoint[] {
  const since = Date.now() - RANGE_MS[range];
  const bucketMs = RANGE_BUCKET_MS[range];
  let rows: ContainerMetricRow[] = [];
  try {
    rows = getDb()
      .prepare(
        `SELECT ts, cpu_percent, mem_usage, mem_limit, mem_percent,
                net_rx, net_tx, rx_delta, tx_delta
         FROM container_metrics
         WHERE container_id = ? AND ts >= ?
         ORDER BY ts ASC`,
      )
      .all(containerId, since) as unknown as ContainerMetricRow[];
  } catch (err) {
    console.error('[containerMetrics] 历史趋势查询失败:', (err as Error)?.message);
    return [];
  }
  return downsampleContainerRows(rows, bucketMs).map(mapContainerMetricRow);
}
