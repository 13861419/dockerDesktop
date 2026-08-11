/**
 * 实时监控采集器
 *
 * 定期采集 Docker 引擎（Docker Desktop WSL2 虚拟机）的 CPU / 内存 / 磁盘 /
 * 网络使用率与容器运行情况，并在内存中维护一段历史数据，供首页曲线图使用。
 *
 * - 通过 docker info 获取 CPU 核数与内存总量
 * - 通过容器 stats 聚合得到 CPU / 内存 / 网络实际使用量
 * - 通过 docker system df 获取磁盘占用
 */
import Dockerode from 'dockerode';
import { getDockerClient, isWindows } from './client';

/** 单个磁盘分区信息 */
export interface DiskPartition {
  /** 盘符/挂载点，如 "C:" */
  mount: string;
  /** 分区总容量（字节） */
  total: number;
  /** 分区已用空间（字节） */
  used: number;
  /** 分区剩余空间（字节） */
  free: number;
  /** 分区使用率（0-100） */
  percent: number;
}

/**
 * 告警条目标注
 * @type 资源类型（cpu / mem / disk）
 * @level 告警级别（warn 警告 / danger 危险），与 message 文案对应
 */
export interface MonitorAlert {
  type: 'cpu' | 'mem' | 'disk';
  level: 'warn' | 'danger';
  message: string;
}

/** 单个监控数据点 */
export interface MonitorPoint {
  timestamp: number;
  cpu: { percent: number; cores: number };
  mem: { percent: number; used: number; total: number };
  disk: { percent: number; used: number; total: number };
  disks: DiskPartition[];
  net: { rx: number; tx: number }; // 累计字节
  containers: { running: number; total: number };
  images: number;
  alerts: MonitorAlert[];
}

/** 资源使用率高占用告警阈值（>= 该值触发对应级别，danger 优先于 warn） */
const ALERT_DANGER_THRESHOLD = 90;
const ALERT_WARN_THRESHOLD = 75;

/** 采集间隔（毫秒） */
const INTERVAL_MS = 2000;
/** 历史缓冲最大点数（2000ms * 900 = 30 分钟） */
const MAX_POINTS = 900;

/** 历史数据环形缓冲 */
const history: MonitorPoint[] = [];

// CPU 采样状态（需要两次采样计算使用率）
let lastCpu: { total: number; idle: number } | null = null;

/** 采集器是否已启动 */
let started = false;
/** 定时器句柄 */
let timer: NodeJS.Timeout | null = null;

/** 最近一次采集到的实时点 */
let latest: MonitorPoint | null = null;

/**
 * 计算系统 CPU 使用率（基于 os.cpus() 两次采样）
 * @returns 各核总计/空闲
 */
function sampleCpu(): { total: number; idle: number } {
  const cpus = require('os').cpus() as Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    idle += cpu.times.idle;
  }
  return { total, idle };
}

/**
 * 计算节点 CPU 使用率百分比（0-100）
 */
function cpuPercent(current: { total: number; idle: number }, prev: { total: number; idle: number }): number {
  const totalDelta = current.total - prev.total;
  const idleDelta = current.idle - prev.idle;
  if (totalDelta <= 0) return 0;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

/**
 * 聚合所有运行中容器的 CPU / 网络使用情况
 * @param docker dockerode 客户端
 */
async function aggregateContainerStats(docker: Dockerode): Promise<{
  cpuPercent: number;
  netRx: number;
  netTx: number;
}> {
  const containers = await docker.listContainers({ all: false });
  let cpuTotal = 0;
  let cpuCoresAcc = 0;
  let netRx = 0;
  let netTx = 0;

  // 并发抓取每个运行中容器的 stats
  const statsArr = await Promise.all(
    containers.map(async (c) => {
      try {
        const stats = await docker.getContainer(c.Id).stats({ stream: false });
        return stats as any;
      } catch {
        return null;
      }
    }),
  );

  for (const s of statsArr) {
    if (!s) continue;
    const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
    const onlineCpus = s.cpu_stats?.online_cpus || 1;
    cpuCoresAcc += onlineCpus;
    if (sysDelta > 0) {
      cpuTotal += (cpuDelta / sysDelta) * onlineCpus * 100;
    }
    for (const key of Object.keys(s.networks || {})) {
      netRx += s.networks[key].rx_bytes || 0;
      netTx += s.networks[key].tx_bytes || 0;
    }
  }

  return {
    cpuPercent: cpuCoresAcc > 0 ? cpuTotal / containers.length || 0 : 0,
    netRx,
    netTx,
  };
}

/**
 * 获取宿主机各固定磁盘分区信息（Windows：所有 DriveType=3 的本地分区）
 * @returns 各分区明细数组
 */
function getDiskPartitions(): DiskPartition[] {
  try {
    const cp = require('child_process');
    // 用 wmic 读取所有本地固定磁盘分区（DriveType=3，排除光驱/可移动盘等）的容量与剩余空间
    const out = cp.execSync(
      'wmic logicaldisk where DriveType=3 get DeviceID,Size,FreeSpace /value',
      { encoding: 'utf8' },
    );
    // wmic 输出存在 \r\r\n 等混合换行，统一按行拆分并去除空白，再用状态机解析
    const result: DiskPartition[] = [];
    let current: { mount: string; total: number; free: number } | null = null;
    for (const raw of out.split(/\r+\n?/)) {
      const line = raw.trim();
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'DeviceID') {
        // 新分区开始，若上一个分区有效则收尾
        if (current && current.total > 0) {
          result.push({
            mount: current.mount,
            total: current.total,
            free: current.free,
            used: current.total - current.free,
            percent: Number((((current.total - current.free) / current.total) * 100).toFixed(1)),
          });
        }
        current = { mount: value, total: 0, free: 0 };
      } else if (current) {
        if (key === 'Size') current.total = Number(value) || 0;
        else if (key === 'FreeSpace') current.free = Number(value) || 0;
      }
    }
    // 收尾最后一个分区
    if (current && current.total > 0) {
      result.push({
        mount: current.mount,
        total: current.total,
        free: current.free,
        used: current.total - current.free,
        percent: Number((((current.total - current.free) / current.total) * 100).toFixed(1)),
      });
    }
    return result;
  } catch {
    // ignore
  }
  return [];
}

/**
 * 获取宿主机磁盘占用（Windows：所有固定磁盘分区的已用 / 总容量）
 * @param docker dockerode 客户端
 * @returns 磁盘已用、总容量（字节）
 */
async function getDiskUsage(docker: Dockerode): Promise<{ used: number; total: number }> {
  try {
    void docker; // docker 参数保留以兼容历史签名（磁盘数据取自宿主机而非 Docker）
    const partitions = getDiskPartitions();
    const total = partitions.reduce((acc, p) => acc + p.total, 0);
    if (total > 0) {
      const used = partitions.reduce((acc, p) => acc + p.used, 0);
      return { used, total };
    }
  } catch {
    // ignore
  }
  return { used: 0, total: 0 };
}

/**
 * 根据资源使用率生成告警条目
 * @param type 资源类型
 * @param resourceName 资源中文名（用于告警文案，如 "CPU" / "内存" / "磁盘"）
 * @param percent 当前使用率（0-100）
 * @returns 告警条目；使用率低于 warn 阈值时返回 null
 */
function buildAlert(
  type: 'cpu' | 'mem' | 'disk',
  resourceName: string,
  percent: number,
): MonitorAlert | null {
  if (percent >= ALERT_DANGER_THRESHOLD) {
    return { type, level: 'danger', message: `${resourceName}空间不足` };
  }
  if (percent >= ALERT_WARN_THRESHOLD) {
    return { type, level: 'warn', message: `${resourceName}空间偏高` };
  }
  return null;
}

/**
 * 单次采集并写入历史缓冲
 */
async function collect() {
  try {
    const docker = await getDockerClient();
    const info = await docker.info();

    // 统计容器数量
    const containers = await docker.listContainers({ all: true });
    const running = containers.filter((c) => c.State === 'running').length;

    // 容器资源聚合（CPU / 网络）
    let aggCpu = 0;
    let netRx = 0;
    let netTx = 0;

    try {
      const agg = await aggregateContainerStats(docker);
      aggCpu = agg.cpuPercent;
      netRx = agg.netRx;
      netTx = agg.netTx;
    } catch {
      // 聚合失败时静默处理
    }

    // 宿主机真实内存（Windows 物理内存）：已用 = 总量 - 空闲
    const osm = require('os') as typeof import('os');
    const memTotal = osm.totalmem();
    const memFree = osm.freemem();
    const memUsed = memTotal > 0 ? memTotal - memFree : 0;

    // 磁盘（含各分区明细与总和）
    let diskUsed = 0;
    let diskTotal = 0;
    let diskPartitions: DiskPartition[] = [];
    try {
      const disk = await getDiskUsage(docker);
      diskUsed = disk.used;
      diskTotal = disk.total;
      diskPartitions = getDiskPartitions();
    } catch {
      // ignore
    }

    const diskPercent = diskTotal > 0 ? Number(((diskUsed / diskTotal) * 100).toFixed(2)) : 0;
    const memPercent = memTotal > 0 ? Number(((memUsed / memTotal) * 100).toFixed(2)) : 0;
    const cpuPercent = Number(aggCpu.toFixed(2));

    // 依据当前使用率生成高占用告警（磁盘用 disks 总和的使用率，均以 90 / 75 为阈值）
    const alerts: MonitorAlert[] = [];
    const diskAlert = buildAlert('disk', '磁盘', diskPercent);
    if (diskAlert) alerts.push(diskAlert);
    const memAlert = buildAlert('mem', '内存', memPercent);
    if (memAlert) alerts.push(memAlert);
    const cpuAlert = buildAlert('cpu', 'CPU', cpuPercent);
    if (cpuAlert) alerts.push(cpuAlert);

    const point: MonitorPoint = {
      timestamp: Date.now(),
      cpu: { percent: cpuPercent, cores: info.NCPU || 0 },
      mem: {
        percent: memPercent,
        used: memUsed,
        total: memTotal,
      },
      disk: {
        percent: diskPercent,
        used: diskUsed,
        total: diskTotal,
      },
      disks: diskPartitions,
      net: { rx: netRx, tx: netTx },
      containers: { running, total: containers.length },
      images: info.Images || 0,
      alerts,
    };

    latest = point;
    history.push(point);
    if (history.length > MAX_POINTS) history.shift();
  } catch (err) {
    // 采集失败不中断（Docker 可能临时不可用）
    console.error('[monitor] 采集失败:', (err as Error)?.message);
  }
}

/**
 * 启动监控采集器（幂等）
 */
export function startMonitor(): void {
  if (started) return;
  started = true;
  collect();
  timer = setInterval(collect, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log('[monitor] 实时监控采集器已启动 (间隔 ' + INTERVAL_MS + 'ms)');
}

/**
 * 获取最近一次实时监控点
 */
export function getCurrentMonitor(): MonitorPoint | null {
  return latest;
}

/**
 * 获取指定分钟内的历史监控点
 * @param minutes 回溯分钟数
 */
export function getMonitorHistory(minutes = 10): MonitorPoint[] {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return history.filter((p) => p.timestamp >= cutoff);
}

/**
 * 判断是否 Windows（供路由复用）
 */
export { isWindows };
