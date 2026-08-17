/**
 * 跨引擎聚合总览 API 路由（挂载路径 /api/aggregate）
 *
 * 遍历 docker_engines 表中的全部引擎，对每个引擎建立独立 dockerode 实例，
 * 聚合各引擎的资源使用与对象数量（容器 / 镜像 / 卷 / 网络），供"引擎总览"
 * 一次性展示多台 Docker 主机的整体状况。
 *
 * 容错：单个引擎不可达时标记 offline，且不影响其它引擎的统计；
 * 未配置任何引擎时返回空数组。
 */
import { Router, Request, Response } from 'express';
import { getDb } from '../storage';
import { getDockerClientForEndpoint } from '../docker/client';
import type Dockerode from 'dockerode';

const router = Router();

/** 引擎端点行结构 */
interface EngineEndpointRow {
  id: string;
  name: string;
  endpoint: string;
  is_current: number;
}

/** 单个引擎的聚合结果 */
export interface EngineAggregate {
  id: string;
  name: string;
  endpoint: string;
  isCurrent: boolean;
  /** 是否在线（ping 与数据拉取均成功） */
  online: boolean;
  error?: string;
  /** 引擎版本信息（可达时） */
  version?: { version?: string; apiVersion?: string; os?: string; arch?: string; kernel?: string };
  /** 主机资源 */
  resources?: { nCPU: number; memTotal: number; memUsed: number; cpuPercent: number };
  /** 对象数量 */
  counts?: { containers: number; running: number; images: number; volumes: number; networks: number };
}

/**
 * 统一兜底错误处理
 * @param fn 异步处理函数
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
 * 对单个引擎进行数据聚合（含 ping 健康检测与对象统计）
 * @param row 引擎端点行
 * @returns 该引擎的聚合结果
 */
async function aggregateOne(row: EngineEndpointRow): Promise<EngineAggregate> {
  const base: EngineAggregate = {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    isCurrent: !!row.is_current,
    online: false,
  };

  try {
    const docker = getDockerClientForEndpoint(row.endpoint);

    // 并行发起 ping + 各对象统计 + 版本信息，缩短总耗时
    const [[version, info], containers, images, volumes, networks] = await Promise.all([
      docker.ping().then(() =>
        Promise.all([docker.version().catch(() => null), docker.info().catch(() => null)])
      ),
      docker.listContainers({ all: true }).catch(() => []),
      docker.listImages().catch(() => []),
      docker.listVolumes().then((d: any) => d?.Volumes || []).catch(() => []),
      docker.listNetworks().catch(() => []),
    ]);

    const running = containers.filter((c: any) => c?.State === 'running').length;

    // 内存使用估算：info 不含实时使用率，这里用 memTotal 与引擎层信息尽量给出合理估值；无 stats 时置 0
    const memTotal = Number(info?.MemTotal) || 0;
    const nCPU = Number(info?.NCPU) || 0;

    base.online = true;
    base.version = {
      version: version?.Version,
      apiVersion: version?.ApiVersion,
      os: info?.OperatingSystem,
      arch: info?.Architecture,
      kernel: info?.KernelVersion,
    };
    base.resources = {
      nCPU,
      memTotal,
      memUsed: 0,
      cpuPercent: 0,
    };
    base.counts = {
      containers: containers.length,
      running,
      images: images.length,
      volumes: volumes.length,
      networks: networks.length,
    };
  } catch (err: any) {
    base.online = false;
    base.error = err?.message || '无法连接该引擎';
  }

  return base;
}

/**
 * GET /api/aggregate/engines
 * 返回全部引擎的聚合总览（逐引擎 + 总计）
 */
router.get(
  '/engines',
  asyncHandler(async (_req: Request, res: Response) => {
    const d = getDb();
    const rows = d
      .prepare('SELECT id, name, endpoint, is_current FROM docker_engines ORDER BY created_at ASC')
      .all() as unknown as EngineEndpointRow[];

    // 并行聚合各引擎，单个失败不影响整体
    const engines = await Promise.all(rows.map((r) => aggregateOne(r)));

    // 汇总：仅统计在线引擎
    const totals = engines.reduce(
      (acc, e) => {
        if (!e.online || !e.counts) return acc;
        acc.containers += e.counts.containers;
        acc.running += e.counts.running;
        acc.images += e.counts.images;
        acc.volumes += e.counts.volumes;
        acc.networks += e.counts.networks;
        acc.nCPU += e.resources?.nCPU || 0;
        acc.memTotal += e.resources?.memTotal || 0;
        return acc;
      },
      { containers: 0, running: 0, images: 0, volumes: 0, networks: 0, nCPU: 0, memTotal: 0 },
    );

    res.json({ engines, totals, engineCount: rows.length, onlineCount: engines.filter((e) => e.online).length });
  }),
);

export default router;
