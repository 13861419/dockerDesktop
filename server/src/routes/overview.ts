/**
 * 应用仪表盘总览 API 路由
 *
 * 聚合引擎信息、容器/镜像/卷/网络数量等，供前端总览页使用。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';

const router = Router();

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
 * GET /api/overview
 * 获取总览统计数据
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const [info, containers, images, volumes, networks] = await Promise.all([
      docker.info(),
      docker.listContainers({ all: true }),
      docker.listImages(),
      docker.listVolumes(),
      docker.listNetworks(),
    ]);

    const running = containers.filter((c) => c.State === 'running').length;
    const stopped = containers.length - running;

    res.json({
      serverVersion: info.ServerVersion,
      name: info.Name,
      id: info.ID,
      driver: info.Driver,
      dockerRootDir: info.DockerRootDir,
      operatingSystem: info.OperatingSystem,
      os: info.OperatingSystem,
      architecture: info.Architecture,
      kernelVersion: info.KernelVersion,
      nCPU: info.NCPU,
      memTotal: info.MemTotal,
      containers: {
        total: containers.length,
        running,
        stopped,
      },
      images: images.length,
      volumes: (volumes.Volumes || []).length,
      networks: networks.length,
      events: info.EventsListener,
      swarm: info.Swarm?.NodeID ? 'active' : 'inactive',
    });
  }),
);

export default router;
