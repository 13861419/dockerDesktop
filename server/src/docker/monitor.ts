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
import { getDb } from '../storage';

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

/** GPU 采集信息（基于 nvidia-smi，若未安装 NVIDIA 驱动则无） */
export interface GpuInfo {
  /** GPU 索引 */
  index: number;
  /** GPU 名称，如 "NVIDIA GeForce RTX 3060" */
  name: string;
  /** 计算利用率（0-100） */
  utilization: number;
  /** 已用显存（MiB） */
  memUsed: number;
  /** 显存总量（MiB） */
  memTotal: number;
  /** 核心温度（摄氏度） */
  temperature: number;
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
  gpu: GpuInfo[];
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

/** 落库降采样间隔（毫秒）：每 30 秒向 host_metrics 写入一条聚合记录，避免高频采集撑大数据库 */
const PERSIST_INTERVAL_MS = 30000;
/** 最近一次落库时间戳（毫秒） */
let lastPersistTs = 0;
/** 落库次数计数器，用于触发周期性旧数据清理（每 20 次约 10 分钟清一次） */
let persistCount = 0;
/** host_metrics 旧数据保留时长（毫秒）：7 天 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

/** GPU 采集最小间隔（毫秒），避免频繁调用 nvidia-smi 拖慢采集循环 */
const GPU_COLLECT_INTERVAL = 5000;
/** 最近一次 GPU 采集时间戳 */
let lastGpuAt = 0;
/** 最近一次 GPU 采集结果缓存 */
let gpuCache: GpuInfo[] = [];

/**
 * 采集 NVIDIA GPU 状态（基于 nvidia-smi，零第三方依赖）
 *
 * 仅在系统安装了 NVIDIA 驱动（存在 nvidia-smi）时返回数据，否则返回空数组。
 * 带 5 秒缓存，避免每个采集周期都启动外部进程。
 * @returns GPU 数组；未检测到或命令失败时返回空数组
 */
function collectGpu(): GpuInfo[] {
  const now = Date.now();
  if (now - lastGpuAt < GPU_COLLECT_INTERVAL) return gpuCache;
  lastGpuAt = now;
  try {
    const cp = require('child_process') as typeof import('child_process');
    const out = cp.execSync(
      'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
      { encoding: 'utf8' },
    );
    const list: GpuInfo[] = [];
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length < 6) continue;
      const index = Number(parts[0]);
      const name = parts[1];
      const utilization = Number(parts[2]);
      const memUsed = Number(parts[3]);
      const memTotal = Number(parts[4]);
      const temperature = Number(parts[5]);
      if (Number.isNaN(index) || !name) continue;
      list.push({
        index,
        name,
        utilization: Number.isNaN(utilization) ? 0 : utilization,
        memUsed: Number.isNaN(memUsed) ? 0 : memUsed,
        memTotal: Number.isNaN(memTotal) ? 0 : memTotal,
        temperature: Number.isNaN(temperature) ? 0 : temperature,
      });
    }
    gpuCache = list;
    return list;
  } catch {
    // nvidia-smi 不可用（未装 NVIDIA 驱动 / 非 NVIDIA 机器）时静默返回空
    gpuCache = [];
    return [];
  }
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
      gpu: collectGpu(),
      net: { rx: netRx, tx: netTx },
      containers: { running, total: containers.length },
      images: info.Images || 0,
      alerts,
    };

    latest = point;
    history.push(point);
    if (history.length > MAX_POINTS) history.shift();
    // 降采样落库：每 30 秒向 host_metrics 写入一条记录，供跨小时/跨天历史趋势查询
    persistPoint(point);
  } catch (err) {
    // 采集失败不中断（Docker 可能临时不可用）
    console.error('[monitor] 采集失败:', (err as Error)?.message);
  }
}

/**
 * 重置监控采集器的内存状态（引擎切换后由 engines.ts 调用）。
 * 采集器每次 tick 都现读当前引擎（getDockerClient + resetDockerCache 后自动对准新引擎），
 * 因此无需重启定时器；此处仅清空历史缓冲与采样点，避免跨引擎数据串扰，
 * 让下一个 tick 以新引擎重新采集。
 */
export function resetMonitorState(): void {
  history.length = 0;
  lastCpu = null;
  latest = null;
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

// ==================== 监控数据持久化与历史趋势 ====================

/** host_metrics 表行结构（仅供内部查询映射使用，字段与表定义一一对应） */
interface HostMetricRow {
  ts: number;
  cpu_percent: number;
  cpu_cores: number;
  mem_percent: number;
  mem_used: number;
  mem_total: number;
  disk_percent: number;
  disk_used: number;
  disk_total: number;
  net_rx: number;
  net_tx: number;
  containers_running: number;
  containers_total: number;
  images: number;
}

/** 历史趋势查询返回的精简监控点（剔除 disks/gpu/alerts 等嵌套结构，便于前端复用渲染） */
export interface MetricPoint {
  /** 采样时间戳（毫秒） */
  timestamp: number;
  /** CPU 使用率与核数 */
  cpu: { percent: number; cores: number };
  /** 内存使用率与绝对值 */
  mem: { percent: number; used: number; total: number };
  /** 磁盘使用率与绝对值 */
  disk: { percent: number; used: number; total: number };
  /** 网络累计收发字节 */
  net: { rx: number; tx: number };
  /** 容器运行/总数 */
  containers: { running: number; total: number };
  /** 镜像数量 */
  images: number;
}

/** 历史趋势查询支持的时间范围 */
export type MetricsRange = '10m' | '1h' | '24h' | '7d';

/** 各时间范围对应的回溯毫秒数 */
const RANGE_MS: Record<MetricsRange, number> = {
  '10m': 10 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/** 各时间范围降采样桶大小（毫秒）；10m 直接用内存缓冲无需降采样 */
const RANGE_BUCKET_MS: Record<Exclude<MetricsRange, '10m'>, number> = {
  '1h': 60 * 1000, // 每 60 秒一点，最多 60 点
  '24h': 600 * 1000, // 每 600 秒一点，最多 144 点
  '7d': 1800 * 1000, // 每 1800 秒一点，最多 336 点
};

/**
 * 将采样点降采样落库到 host_metrics（每 30 秒一条）
 *
 * 同时维护落库计数器，每 20 次（约 10 分钟）清理一次 7 天前的旧数据，
 * 防止数据库无限膨胀。落库失败不中断采集。
 * @param point 当前采样点
 */
function persistPoint(point: MonitorPoint): void {
  const now = point.timestamp;
  if (now - lastPersistTs < PERSIST_INTERVAL_MS) return;
  lastPersistTs = now;
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO host_metrics
        (ts, cpu_percent, cpu_cores, mem_percent, mem_used, mem_total,
         disk_percent, disk_used, disk_total, net_rx, net_tx,
         containers_running, containers_total, images)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      point.timestamp,
      point.cpu.percent,
      point.cpu.cores,
      point.mem.percent,
      point.mem.used,
      point.mem.total,
      point.disk.percent,
      point.disk.used,
      point.disk.total,
      point.net.rx,
      point.net.tx,
      point.containers.running,
      point.containers.total,
      point.images,
    );
    persistCount += 1;
    // 每 20 次落库（约 10 分钟）清理一次 7 天前的旧数据
    if (persistCount % 20 === 0) {
      const cutoff = Date.now() - RETENTION_MS;
      db.prepare('DELETE FROM host_metrics WHERE ts < ?').run(cutoff);
    }
  } catch (err) {
    // 落库失败不中断采集（数据库可能临时不可用）
    console.error('[monitor] 落库失败:', (err as Error)?.message);
  }
}

/**
 * 将全量行按时间桶降采样，每个桶取最后一条（更贴近实时末值）
 *
 * 输入需按 ts 升序排列；输出的时间点为各桶内最后一条记录。
 * @param rows 已按 ts 升序排列的原始行
 * @param bucketMs 桶大小（毫秒）
 * @returns 降采样后的行数组
 */
function downsample(rows: HostMetricRow[], bucketMs: number): HostMetricRow[] {
  if (rows.length === 0) return [];
  const out: HostMetricRow[] = [];
  let currentBucket = Math.floor(rows[0].ts / bucketMs);
  let lastInBucket: HostMetricRow = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const bucket = Math.floor(rows[i].ts / bucketMs);
    if (bucket !== currentBucket) {
      // 进入新桶：提交上一桶的最后一条
      out.push(lastInBucket);
      currentBucket = bucket;
      lastInBucket = rows[i];
    } else {
      // 桶内持续覆盖，保留最后一条
      lastInBucket = rows[i];
    }
  }
  // 提交最后一桶
  out.push(lastInBucket);
  return out;
}

/**
 * 将内存 MonitorPoint 映射为精简 MetricPoint
 * @param p 内存监控点
 * @returns 精简监控点
 */
function mapMonitorPoint(p: MonitorPoint): MetricPoint {
  return {
    timestamp: p.timestamp,
    cpu: { percent: p.cpu.percent, cores: p.cpu.cores },
    mem: { percent: p.mem.percent, used: p.mem.used, total: p.mem.total },
    disk: { percent: p.disk.percent, used: p.disk.used, total: p.disk.total },
    net: { rx: p.net.rx, tx: p.net.tx },
    containers: { running: p.containers.running, total: p.containers.total },
    images: p.images,
  };
}

/**
 * 将 host_metrics 表行映射为精简 MetricPoint
 * @param r 数据库行
 * @returns 精简监控点
 */
function mapHostMetricRow(r: HostMetricRow): MetricPoint {
  return {
    timestamp: r.ts,
    cpu: { percent: r.cpu_percent, cores: r.cpu_cores },
    mem: { percent: r.mem_percent, used: r.mem_used, total: r.mem_total },
    disk: { percent: r.disk_percent, used: r.disk_used, total: r.disk_total },
    net: { rx: r.net_rx, tx: r.net_tx },
    containers: { running: r.containers_running, total: r.containers_total },
    images: r.images,
  };
}

/**
 * 查询指定时间范围的历史监控趋势
 *
 * - 10m：直接返回内存缓冲（与 getMonitorHistory(10) 一致，实时性好）
 * - 1h/24h/7d：从 host_metrics 查询并按桶降采样，避免返回过多点
 *
 * @param range 时间范围，默认 1h
 * @returns 精简监控点数组（按时间升序）
 */
export function getMetricsRange(range: MetricsRange = '1h'): MetricPoint[] {
  if (range === '10m') {
    return getMonitorHistory(10).map(mapMonitorPoint);
  }
  const since = Date.now() - RANGE_MS[range];
  const bucketMs = RANGE_BUCKET_MS[range];
  let rows: HostMetricRow[] = [];
  try {
    rows = getDb()
      .prepare(
        `SELECT ts, cpu_percent, cpu_cores, mem_percent, mem_used, mem_total,
                disk_percent, disk_used, disk_total, net_rx, net_tx,
                containers_running, containers_total, images
         FROM host_metrics
         WHERE ts >= ?
         ORDER BY ts ASC`,
      )
      .all(since) as unknown as HostMetricRow[];
  } catch (err) {
    console.error('[monitor] 历史趋势查询失败:', (err as Error)?.message);
    return [];
  }
  return downsample(rows, bucketMs).map(mapHostMetricRow);
}

/**
 * 判断是否 Windows（供路由复用）
 */
export { isWindows };
