/**
 * 容器资源统计：将 dockerode 的原始 stats 数据解析为易读结构。
 *
 * 供单容器 stats 接口与批量 stats 接口复用。
 */

/** 单个容器解析后的资源统计 */
export interface ParsedStats {
  cpuPercent: number;
  memory: { usage: number; limit: number; percent: number };
  network: { rx: number; tx: number };
  blockRead?: number;
  blockWrite?: number;
  pids: number;
}

/**
 * 将 dockerode container.stats({ stream: false }) 的原始数据解析为易读结构
 * @param stats 原始统计
 */
export function parseStats(stats: any): ParsedStats {
  const cpuDelta = stats.cpu_stats?.cpu_usage?.total_usage - stats.precpu_stats?.cpu_usage?.total_usage || 0;
  const systemDelta = stats.cpu_stats?.system_cpu_usage - stats.precpu_stats?.system_cpu_usage || 0;
  const onlineCpus = stats.cpu_stats?.online_cpus || 1;
  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

  const memUsage = stats.memory_stats?.usage || 0;
  const memLimit = stats.memory_stats?.limit || 0;

  const net = (Object.values(stats.networks || {}) as any[]).reduce<{ rx: number; tx: number }>(
    (acc, v) => {
      acc.rx += v?.rx_bytes || 0;
      acc.tx += v?.tx_bytes || 0;
      return acc;
    },
    { rx: 0, tx: 0 },
  );

  return {
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memory: {
      usage: memUsage,
      limit: memLimit,
      percent: memLimit > 0 ? Number(((memUsage / memLimit) * 100).toFixed(2)) : 0,
    },
    network: net,
    blockRead: stats.blkio_stats?.io_service_bytes_recursive?.filter(
      (b: any) => b.op === 'Read',
    ).reduce((a: any, c: any) => a + c.value, 0),
    blockWrite: stats.blkio_stats?.io_service_bytes_recursive?.filter(
      (b: any) => b.op === 'Write',
    ).reduce((a: any, c: any) => a + c.value, 0),
    pids: stats.pids_stats?.current || 0,
  };
}
