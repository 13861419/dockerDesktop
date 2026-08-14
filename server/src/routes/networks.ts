/**
 * 网络（Networks）管理 API 路由
 *
 * 提供网络的列表、创建、删除、详情、连接容器等接口。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

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
 * GET /api/networks
 * 获取网络列表，可通过 all=true 获取所有网络（含未活跃的）
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const all = req.query.all === 'true';
    const networks = await docker.listNetworks({ filters: all ? undefined : { dangling: ['false'] } });
    res.json(networks);
  }),
);

/**
 * GET /api/networks/:id
 * 获取单个网络详情（包含已连接的容器）
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const network = await docker.getNetwork(req.params.id).inspect();
    res.json(network);
  }),
);

/**
 * POST /api/networks
 * 创建网络
 * body: { name, driver, subnet, gateway, ipRange, internal, ipv6 }
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const b = req.body || {};
    const network = await docker.createNetwork({
      Name: b.name,
      Driver: b.driver || 'bridge',
      IPAM: b.subnet
        ? {
            Driver: 'default',
            Config: [
              {
                Subnet: b.subnet,
                Gateway: b.gateway || undefined,
                IPRange: b.ipRange || undefined,
              },
            ],
          }
        : undefined,
      Internal: !!b.internal,
      // 在创建接口顶层透传 EnableIPv6，启用 IPv6 需配合相应子网
      EnableIPv6: b.ipv6 === true,
    });
    logOperation(res.locals.username, '创建网络', 'network', b.name, `驱动: ${b.driver || 'bridge'}`);
    res.status(201).json(network);
  }),
);

/**
 * DELETE /api/networks/:id
 * 删除网络
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    await docker.getNetwork(req.params.id).remove();
    logOperation(res.locals.username, '删除网络', 'network', req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * 需要排除的系统内置网络名称，避免误删 Docker 系统网络
 */
const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none']);

/**
 * POST /api/networks/prune
 * 一键清理未使用网络：批量断开并删除未被任何容器连接的网络
 *
 * 判定未使用：在代码内判断 each 网络的 Containers 是否为空（未被任何容器连接），
 * 并额外排除内置的 bridge / host / none 系统网络。
 * 注意不能使用 listNetworks 的 usage filter（该 filter 不被 Docker 支持）。
 * 单个网络删除失败仅跳过并计入失败数，不中断整体流程。
 */
router.post(
  '/prune',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    // 列出全部网络，在代码内判断是否被容器使用（无需依赖无效的 usage filter）
    const networks = (await docker.listNetworks()) as any[];

    const deleted: string[] = [];
    let success = 0;
    let failed = 0;

    for (const net of networks || []) {
      const name = net?.Name;
      // 跳过系统内置网络，避免误删
      if (BUILT_IN_NETWORKS.has(name)) continue;
      // 若仍被任一容器连接（Containers 非空），视为使用中，跳过
      const containers = net?.Containers;
      const inUse = !!(containers && Object.keys(containers).length > 0);
      if (inUse) continue;
      try {
        await docker.getNetwork(net.Id).remove({});
        success += 1;
        deleted.push(name);
      } catch (e) {
        // 单个网络删除失败仅跳过并记录，不导致整体失败
        failed += 1;
      }
    }

    res.json({ ok: true, deleted, success, failed });
    logOperation(res.locals.username, '清理未使用网络', 'network', null, deleted.join(', ') || `成功 ${success} 个，失败 ${failed} 个`);
  }),
);

/**
 * POST /api/networks/:id/connect
 * 将容器连接到网络
 * body: { container, aliases?, ipv4Address? }
 */
router.post(
  '/:id/connect',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const { container, aliases, ipv4Address } = req.body || {};
    if (!container) {
      return res.status(400).json({ error: '缺少 container 参数' });
    }
    await docker.getNetwork(req.params.id).connect({
      Container: container,
      EndpointConfig: {
        Aliases: aliases || undefined,
        IPAMConfig: ipv4Address ? { IPv4Address: ipv4Address } : undefined,
      },
    });
    logOperation(res.locals.username, '连接容器到网络', 'network', req.params.id, `容器: ${container}`);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/networks/:id/disconnect
 * 将容器从网络断开
 * body: { container, force? }
 */
router.post(
  '/:id/disconnect',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const { container, force } = req.body || {};
    if (!container) {
      return res.status(400).json({ error: '缺少 container 参数' });
    }
    await docker.getNetwork(req.params.id).disconnect({ Container: container, Force: !!force });
    logOperation(res.locals.username, '断开容器网络', 'network', req.params.id, `容器: ${container}`);
    res.json({ ok: true });
  }),
);

export default router;
