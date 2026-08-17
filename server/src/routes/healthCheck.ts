/**
 * 系统健康体检 API 路由
 *
 * 聚合 Docker 引擎状态、资源使用率（CPU / 内存 / 磁盘）、镜像 / 卷 / 网络
 * 的未使用情况与容器重启状态，计算一套 0-100 的健康评分与逐项体检结果，
 * 供前端"健康体检"页面展示。只读接口，普通登录用户即可访问。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { getCurrentMonitor } from '../docker/monitor';

const router = Router();

/** 健康级别类型：healthy 健康 / warning 警告 / danger 危险 */
type HealthLevel = 'healthy' | 'warning' | 'danger';

/** 单个体检条目 */
interface HealthItem {
  /** 条目唯一标识（供前端判断类型与跳转） */
  key: string;
  /** 条目标题（如 CPU / 内存 / 磁盘） */
  title: string;
  /** 健康级别 */
  level: HealthLevel;
  /** 概要描述 */
  message: string;
  /** 更详细的说明（可选） */
  detail?: string;
}

/** 使用率阈值：>= danger 为危险，>= warn 为警告 */
const DANGER_THRESHOLD = 90;
const WARN_THRESHOLD = 75;

/** 长期未使用镜像判定阈值（天） */
const UNUSED_DAYS = 30;

/** 镜像/卷/网络的未使用条数告警阈值（>0 即提示） */
const UNUSED_TRIGGER = 0;

/** 各健康级别对应的评分扣分（weight 归一化参考），数值越大扣分越多 */
const LEVEL_SCORE: Record<HealthLevel, number> = {
  healthy: 0,
  warning: 20,
  danger: 50,
};

/**
 * 统一兜底错误处理
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 根据数值落在区间内的健康级别（healthy < warn，warn <= v < danger，v >= danger 危险）
 * @param value 当前数值（百分比等）
 * @returns 健康级别
 */
function levelForPercent(value: number): HealthLevel {
  if (value >= DANGER_THRESHOLD) return 'danger';
  if (value >= WARN_THRESHOLD) return 'warning';
  return 'healthy';
}

/**
 * 汇总所有体检条目，计算总体健康评分与等级
 *
 * 评分方式：以满分 100 起步，对每个条目按其级别扣分（healthy 不扣、
 * warning 扣 20、danger 扣 50），并归一化到 0-100（受条目数量影响，
 * 条目越多单个 warning 对总分影响越小）。
 * 等级：存在 danger 则整体 danger，否则存在 warning 则整体 warning，否则 healthy。
 * @param items 全部体检条目
 * @returns 评分（0-100）与总体等级
 */
function summarize(items: HealthItem[]): { score: number; level: HealthLevel } {
  const total = items.length;
  if (total === 0) return { score: 100, level: 'healthy' };
  const lost = items.reduce((sum, item) => sum + LEVEL_SCORE[item.level], 0);
  // 归一化到 0-100：扣分总和按条目数取平均后从 100 扣除
  const score = Math.max(0, Math.min(100, Math.round(100 - lost / total)));
  // 等级：任一 danger -> danger，否则任一 warning -> warning，否则 healthy
  if (items.some((item) => item.level === 'danger')) return { score, level: 'danger' };
  if (items.some((item) => item.level === 'warning')) return { score, level: 'warning' };
  return { score, level: 'healthy' };
}

/**
 * GET /api/health-check
 * 执行一次系统健康体检并返回评分、等级、汇总统计与逐项体检结果
 *
 * 内部并行采集引擎信息、容器 / 镜像 / 卷 / 网络列表、磁盘统计与实时监控数据，
 * 对 docker.df 与实时监控采集的非就绪情况做容错处理。
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const items: HealthItem[] = [];
    const summary: {
      containers: number;
      images: number;
      volumes: number;
      networks: number;
      reclaimable: number;
    } = {
      containers: 0,
      images: 0,
      volumes: 0,
      networks: 0,
      reclaimable: 0,
    };

    /**
     * 并行采集基础数据：
     * - info：引擎状态（版本、CPU 核数、内存总量）
     * - containers：全部容器（含已停止），用于统计重启/退出状态
     * - images：镜像列表（含悬空镜像），配合容器引用判断未用镜像
     * - volumes：数据卷列表，用于判断孤儿卷
     * - networks：网络列表，用于判断未用网络
     * - monitor：实时监控点（CPU / 内存 / 磁盘使用率，可能尚未就绪）
     * docker.df 可能被引擎禁用，单独 try/catch 容错
     */
    const [info, containers, images, volumes, networks, monitor, df] = await Promise.all([
      docker.info(),
      docker.listContainers({ all: true }) as Promise<any[]>,
      docker.listImages() as Promise<any[]>,
      docker.listVolumes(),
      docker.listNetworks(),
      Promise.resolve(getCurrentMonitor()),
      // df 可能被引擎禁用（如某些远端引擎），做容错，失败时返回 null
      docker.df().catch(() => null),
    ]);

    // ---------- 汇总统计（供页面顶部数据条展示） ----------
    const infoAny = info as any;
    summary.containers = containers.length;
    summary.images = images.length;
    summary.volumes = (volumes.Volumes || []).length;
    summary.networks = networks.length;
    const dfAny = df as any;
    summary.reclaimable = Number(dfAny?.summary?.totalReclaimable) || 0;

    // ---------- 1. 引擎可达性 / 版本 ----------
    try {
      const version = infoAny?.ServerVersion || infoAny?.serverVersion || '未知';
      items.push({
        key: 'engine',
        title: 'Docker 引擎',
        level: 'healthy',
        message: `引擎运行正常（版本 ${version}）`,
        detail: `CPU ${infoAny?.NCPU ?? 0} 核，内存 ${fmtBytes(infoAny?.MemTotal || 0)}，Swarm ${infoAny?.Swarm?.NodeID ? '启用' : '未启用'}`,
      });
    } catch {
      items.push({
        key: 'engine',
        title: 'Docker 引擎',
        level: 'danger',
        message: 'Docker 引擎不可达',
        detail: '请确认 Docker Desktop 已启动或引擎端点配置正确',
      });
    }

    // ---------- 2. CPU 使用率 ----------
    const cpuPercent = monitor?.cpu?.percent ?? 0;
    const cpuLevel = levelForPercent(cpuPercent);
    items.push({
      key: 'cpu',
      title: 'CPU 使用率',
      level: cpuLevel,
      message:
        cpuLevel === 'healthy'
          ? `使用率 ${cpuPercent.toFixed(1)}%，处于健康区间`
          : cpuLevel === 'warning'
            ? `使用率 ${cpuPercent.toFixed(1)}%，偏高`
            : `使用率 ${cpuPercent.toFixed(1)}%，严重偏高`,
      detail: monitor ? `共 ${monitor.cpu.cores} 核` : '实时监控数据尚未就绪，暂以 0% 计',
    });

    // ---------- 3. 内存使用率 ----------
    const memPercent = monitor?.mem?.percent ?? 0;
    const memLevel = levelForPercent(memPercent);
    items.push({
      key: 'memory',
      title: '内存使用率',
      level: memLevel,
      message:
        memLevel === 'healthy'
          ? `使用率 ${memPercent.toFixed(1)}%，处于健康区间`
          : memLevel === 'warning'
            ? `使用率 ${memPercent.toFixed(1)}%，偏高`
            : `使用率 ${memPercent.toFixed(1)}%，严重偏高`,
      detail: monitor ? `${fmtBytes(monitor.mem.used)} / ${fmtBytes(monitor.mem.total)}` : '实时监控数据尚未就绪',
    });

    // ---------- 4. 磁盘使用率 + 可回收空间 ----------
    const diskPercent = monitor?.disk?.percent ?? 0;
    const diskLevel = levelForPercent(diskPercent);
    const diskDetailParts: string[] = [];
    if (monitor) {
      diskDetailParts.push(`${fmtBytes(monitor.disk.used)} / ${fmtBytes(monitor.disk.total)}`);
    }
    if (summary.reclaimable > 0) {
      diskDetailParts.push(`可回收约 ${fmtBytes(summary.reclaimable)}`);
    }
    items.push({
      key: 'disk',
      title: '磁盘使用率',
      level: diskLevel,
      message:
        diskLevel === 'healthy'
          ? `使用率 ${diskPercent.toFixed(1)}%，处于健康区间`
          : diskLevel === 'warning'
            ? `使用率 ${diskPercent.toFixed(1)}%，偏高`
            : `使用率 ${diskPercent.toFixed(1)}%，严重偏高`,
      detail: diskDetailParts.length ? diskDetailParts.join('；') : '实时监控数据尚未就绪',
    });

    // ---------- 5. 悬空镜像 ----------
    const danglingImages = (images as any[]).filter(
      (img) => !img.RepoTags || img.RepoTags.length === 0,
    ).length;
    items.push({
      key: 'danglingImages',
      title: '悬空镜像',
      level: danglingImages > UNUSED_TRIGGER ? 'warning' : 'healthy',
      message:
        danglingImages > UNUSED_TRIGGER
          ? `存在 ${danglingImages} 个悬空镜像`
          : '未发现悬空镜像',
      detail: danglingImages > UNUSED_TRIGGER ? '悬空镜像是无标签、未被引用的镜像，可在存储页清理' : '所有镜像均有有效标签',
    });

    // ---------- 6. 长期未使用镜像（>30 天且无容器引用） ----------
    const usedImageIds = new Set<string>();
    const usedImageNames = new Set<string>();
    for (const c of containers) {
      if (c.ImageID) usedImageIds.add(c.ImageID);
      if (c.Image) usedImageNames.add(c.Image);
    }
    const now = Math.floor(Date.now() / 1000);
    const isUsed = (img: any): boolean => {
      if (img.Id && usedImageIds.has(img.Id)) return true;
      const tags = img.RepoTags || [];
      return tags.some((t: string) => usedImageNames.has(t));
    };
    const unusedImages = (images as any[]).filter((img) => {
      if (!isUsed(img)) {
        // 无容器引用且构建时间在 30 天前视为长期未使用
        const created = img.Created || 0;
        return now - created > UNUSED_DAYS * 86400;
      }
      return false;
    });
    items.push({
      key: 'unusedImages',
      title: '长期未使用镜像',
      level: unusedImages.length > UNUSED_TRIGGER ? 'warning' : 'healthy',
      message:
        unusedImages.length > UNUSED_TRIGGER
          ? `存在 ${unusedImages.length} 个超过 ${UNUSED_DAYS} 天未使用的镜像`
          : '未发现长期未使用的镜像',
      detail: unusedImages.length > UNUSED_TRIGGER ? '可在镜像页或存储页进行清理以释放空间' : '所有镜像均近期使用或仍被引用',
    });

    // ---------- 7. 孤儿卷（未被任何容器引用的卷） ----------
    const allVolumes = (volumes.Volumes || []) as any[];
    const orphanVolumes = allVolumes.filter((v) => {
      const refCount = Number(v?.UsageData?.RefCount ?? 0);
      return refCount === 0;
    });
    items.push({
      key: 'orphanVolumes',
      title: '孤儿数据卷',
      level: orphanVolumes.length > UNUSED_TRIGGER ? 'warning' : 'healthy',
      message:
        orphanVolumes.length > UNUSED_TRIGGER
          ? `存在 ${orphanVolumes.length} 个未被使用的数据卷`
          : '未发现孤儿数据卷',
      detail: orphanVolumes.length > UNUSED_TRIGGER ? '未被任何容器引用的数据卷，可在数据卷页删除' : '所有数据卷均被容器引用',
    });

    // ---------- 8. 未使用的自定义网络 ----------
    const unusedNetworks = (networks as any[]).filter((n) => {
      // 仅关注 user 驱动的自定义网络（排除内置 bridge/host/none 等系统网络）
      const driver = n.Driver || '';
      const isUserNetwork = driver === 'bridge' || driver === 'overlay';
      const containers = n.Containers;
      const hasContainer = containers && (Array.isArray(containers) ? containers.length > 0 : Object.keys(containers).length > 0);
      return isUserNetwork && !hasContainer;
    });
    items.push({
      key: 'unusedNetworks',
      title: '未使用网络',
      level: unusedNetworks.length > UNUSED_TRIGGER ? 'warning' : 'healthy',
      message:
        unusedNetworks.length > UNUSED_TRIGGER
          ? `存在 ${unusedNetworks.length} 个未被使用的自定义网络`
          : '未发现未使用的网络',
      detail: unusedNetworks.length > UNUSED_TRIGGER ? '未被任何容器连接的网络，可在网络页删除' : '所有自定义网络均被使用',
    });

    // ---------- 9. 正在重启的容器 ----------
    const restarting = (containers as any[]).filter((c) => c.State === 'restarting');
    items.push({
      key: 'restartingContainers',
      title: '正在重启的容器',
      level: restarting.length > UNUSED_TRIGGER ? 'warning' : 'healthy',
      message:
        restarting.length > UNUSED_TRIGGER
          ? `检测到 ${restarting.length} 个容器处于重启中`
          : '没有容器处于重启中',
      detail:
        restarting.length > UNUSED_TRIGGER
          ? restarting.map((c) => (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12)).join(', ')
          : undefined,
    });

    // ---------- 汇总评分与等级 ----------
    const { score, level } = summarize(items);

    res.json({ score, level, summary, items });
  }),
);

/**
 * 将字节数格式化为人类可读大小（B/KB/MB/GB/TB）
 * @param bytes 字节数
 * @returns 格式化后的字符串
 */
function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default router;
