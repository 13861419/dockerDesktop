/**
 * 网络拓扑 API 路由（挂 /api/topology）
 *
 * 聚合当前/指定引擎的容器与网络，输出拓扑节点与边（纯数据，渲染在前端）。
 *  - 节点：容器（含状态/健康/所属项目）+ 网络
 *  - 边：容器 → 所属网络
 * 只读：仅 listContainers / listNetworks / inspect。
 * 资源限制：最大容器数 200（超限 truncated）。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient, getDockerClientForEndpoint } from '../docker/client';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      res.status(err?.statusCode || 500).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

const MAX_CONTAINERS = 200;

/** 容器 inspect 网络归集（供前端连线） */
export interface TopoContainer {
  id: string;
  name: string;
  status: string;
  health?: string;
  image?: string;
  projectName?: string;
  networks: string[];
  ports: Array<{ target: string; protocol: string; published?: string }>;
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const engineParam = typeof req.query.engine === 'string' && req.query.engine ? req.query.engine : '';
    const docker = engineParam ? getDockerClientForEndpoint(engineParam) : await getDockerClient();

    const [containersRaw, networksRaw] = await Promise.all([
      docker.listContainers({ all: true }).catch(() => [] as any[]),
      docker.listNetworks().catch(() => [] as any[]),
    ]);

    const containers = containersRaw as any[];
    const truncated = containers.length > MAX_CONTAINERS;
    const slice = containers.slice(0, MAX_CONTAINERS);

    const nodes: any[] = [];
    const edges: any[] = [];

    // 网络节点
    for (const net of networksRaw as any[]) {
      const name: string = net?.Name || net?.Id?.slice(0, 12) || '';
      if (!name) continue;
      nodes.push({
        id: 'net:' + (net?.Id || name),
        kind: 'network',
        label: name,
        driver: net?.Driver,
      });
    }

    // 容器节点 + 网络边（并发 inspect）
    const inspResults = await Promise.allSettled(
      slice.map(async (c: any) => {
        const info: any = await docker.getContainer(c.Id).inspect();
        return { c, info };
      }),
    );

    for (const r of inspResults) {
      if (r.status !== 'fulfilled') continue;
      const { c, info } = r.value;
      const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12);
      const labels = info?.Config?.Labels || {};
      const projectName = labels['com.docker.compose.project'];
      const networks: string[] = [];
      const netSettings = info?.NetworkSettings?.Networks;
      if (netSettings && typeof netSettings === 'object') {
        for (const n of Object.keys(netSettings)) {
          if (['bridge', 'host', 'none', 'default', 'null', 'container'].includes(n)) continue;
          networks.push(n);
        }
      } else {
        const mode = info?.HostConfig?.NetworkMode;
        if (mode && !['bridge', 'host', 'none', 'default', 'null'].includes(mode)) networks.push(mode);
      }
      // 端口
      const ports: Array<{ target: string; protocol: string; published?: string }> = [];
      const portBindings = info?.HostConfig?.PortBindings || {};
      for (const [key, bindings] of Object.entries(portBindings) as any) {
        const m = String(key).match(/^(\d+)\/(\w+)$/);
        const target = m ? m[1] : String(key).split('/')[0];
        const protocol = m ? m[2] : 'tcp';
        const b = Array.isArray(bindings) && bindings[0] ? bindings[0] : null;
        ports.push({ target, protocol, published: b?.HostPort });
      }

      const health = info?.State?.Health?.Status;

      nodes.push({
        id: c.Id,
        kind: 'container',
        label: name,
        name,
        status: c.State || c.Status,
        health,
        image: c.Image,
        projectName,
        networks,
        ports,
      });

      for (const n of networks) {
        const netNode = nodes.find((nd) => nd.kind === 'network' && nd.label === n);
        if (netNode) {
          edges.push({ from: c.Id, to: netNode.id, kind: 'network' });
        }
      }
    }

    res.json({ nodes, edges, counts: { containers: slice.length, networks: nodes.length }, truncated });
  }),
);

export default router;
