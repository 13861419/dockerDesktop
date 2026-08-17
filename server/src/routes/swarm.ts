/**
 * Docker Swarm 集群管理 API 路由（挂载路径 /api/swarm）
 *
 * 提供 Swarm 集群状态查询、服务列表/详情、服务删除与服务副本缩放能力。
 * 所有接口统一做容错：未启用 Swarm 时读接口返回空数据 + enabled:false，
 * 写接口返回 { ok:false, error:'swarm-not-enabled' }，不抛 4xx。
 * 写操作（删除/缩放）需 requireAdmin，读操作仅需登录（requireAuth 由 app.ts 统一挂载）。
 */
import { Router, Request, Response } from 'express';
import Dockerode from 'dockerode';
import { getDockerClient } from '../docker/client';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

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

/** Swarm 精简状态（前端 /api/swarm/status 返回结构） */
interface SwarmState {
  enabled: boolean;
  localNodeState: string;
  controlAvailable: boolean;
  nodes?: number;
  managers?: number;
  nodeID?: string;
}

/** Swarm 节点精简结构 */
interface SwarmNodeItem {
  id: string;
  hostname: string;
  role: string;
  availability: string;
  status: string;
  managerStatus?: { leader?: boolean; reachability?: string; addr?: string };
}

/**
 * 读取当前引擎的 Swarm 集群状态（基于 docker.info()）
 * @param docker dockerode 客户端实例
 * @returns Swarm 精简状态
 */
async function getSwarmState(docker: Dockerode): Promise<SwarmState> {
  // 拉取引擎信息；失败时视为未启用 Swarm
  const info = await docker.info();
  const swarm = info?.Swarm || {};
  const localNodeState = swarm.LocalNodeState || 'inactive';
  const state: SwarmState = {
    enabled: localNodeState === 'active',
    localNodeState,
    controlAvailable: !!swarm.ControlAvailable,
  };
  if (swarm.NodeID) state.nodeID = swarm.NodeID;
  if (typeof swarm.Nodes === 'number') state.nodes = swarm.Nodes;
  if (typeof swarm.Managers === 'number') state.managers = swarm.Managers;
  return state;
}

/**
 * GET /api/swarm/status
 * 返回当前引擎的 Swarm 状态与节点列表；未启用 Swarm 时节点列表为空数组
 */
router.get(
  '/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const state = await getSwarmState(docker);
    if (!state.enabled) {
      return res.json({ ...state, nodes: [] });
    }
    // 已启用 Swarm：拉取节点列表并精简
    let nodes: SwarmNodeItem[] = [];
    try {
      const list = (await docker.listNodes()) as any[];
      nodes = (list || []).map((n) => ({
        id: n.ID || n.Id || '',
        hostname: n.Description?.Hostname || n.Spec?.Name || '',
        role: n.Spec?.Role || '',
        availability: n.Spec?.Availability || '',
        status: n.Status?.State || '',
        managerStatus: n.ManagerStatus
          ? {
              leader: !!n.ManagerStatus.Leader,
              reachability: n.ManagerStatus.Reachability,
              addr: n.ManagerStatus.Addr,
            }
          : undefined,
      }));
    } catch {
      // 节点拉取失败不阻塞状态返回
      nodes = [];
    }
    res.json({ ...state, nodes });
  }),
);

/**
 * GET /api/swarm/services
 * 返回 Swarm 服务列表（精简字段）；未启用 Swarm 时返回 { ok:false, error:'swarm-not-enabled' }
 */
router.get(
  '/services',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const state = await getSwarmState(docker);
    if (!state.enabled) {
      return res.json({ ok: false, error: 'swarm-not-enabled' });
    }
    try {
      const list = (await docker.listServices()) as any[];
      const services = await Promise.all(
        (list || []).map(async (s) => {
          const id = s.ID || s.Id || '';
          const spec = s.Spec || {};
          const mode = spec.Mode || {};
          return {
            id,
            name: spec.Name || '',
            image: (spec.TaskTemplate?.ContainerSpec?.Image || ''),
            mode: mode.Replicated ? 'replicated' : 'global',
            desired:
              mode.Replicated && typeof mode.Replicated.Replicas === 'number'
                ? mode.Replicated.Replicas
                : null,
            runningTasks: await countRunningTasks(docker, id),
            updatedAt: s.UpdatedAt ? Date.parse(s.UpdatedAt) || 0 : 0,
          };
        }),
      );
      res.json({ ok: true, services });
    } catch (e: any) {
      res.json({ ok: false, error: e?.message || '获取服务列表失败' });
    }
  }),
);

/**
 * 统计某服务的当前运行副本数（Running 状态的任务数）
 * @param docker dockerode 客户端实例
 * @param serviceId 服务 id
 * @returns Running 状态任务数，异常时容错返回 0
 */
async function countRunningTasks(docker: Dockerode, serviceId: string): Promise<number> {
  try {
    const tasks = (await docker.listTasks({ filters: { service: [serviceId] } })) as any[];
    if (!Array.isArray(tasks)) return 0;
    return tasks.filter((t) => t.Status?.State === 'running').length;
  } catch {
    return 0;
  }
}

/**
 * GET /api/swarm/services/:id
 * 返回单个服务的精简详情（含任务统计）；未启用 Swarm 时返回 { ok:false, error:'swarm-not-enabled' }
 */
router.get(
  '/services/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const state = await getSwarmState(docker);
    if (!state.enabled) {
      return res.json({ ok: false, error: 'swarm-not-enabled' });
    }
    const id = String(req.params.id);
    try {
      const svc = (await docker.getService(id).inspect()) as any;
      const spec = svc.Spec || {};
      const mode = spec.Mode || {};
      const replicated = mode.Replicated ? Number(mode.Replicated.Replicas) : null;
      res.json({
        ok: true,
        service: {
          id: svc.ID || id,
          name: spec.Name || '',
          image: spec.TaskTemplate?.ContainerSpec?.Image || '',
          mode: replicated !== null ? 'replicated' : 'global',
          replicas: replicated,
          ports: (spec.EndpointSpec?.Ports || []).map((p: any) => ({
            target: p.TargetPort,
            published: p.PublishedPort,
            protocol: p.Protocol,
          })),
          updateConfig: spec.UpdateConfig || null,
          runningTasks: await countRunningTasks(docker, id),
        },
      });
    } catch (e: any) {
      return res.status(404).json({ error: `服务不存在或已删除：${e?.message || ''}` });
    }
  }),
);

/**
 * DELETE /api/swarm/services/:id
 * 删除指定 Swarm 服务（管理员操作）；未启用 Swarm 时返回 { ok:false, error:'swarm-not-enabled' }
 */
router.delete(
  '/services/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const state = await getSwarmState(docker);
    if (!state.enabled) {
      return res.json({ ok: false, error: 'swarm-not-enabled' });
    }
    const id = String(req.params.id);
    try {
      const svc = (await docker.getService(id).inspect()) as any;
      await docker.getService(id).remove();
      const name = svc?.Spec?.Name || id;
      logOperation(res.locals.username, '删除Swarm服务', 'swarm-service', name);
      res.json({ ok: true });
    } catch (e: any) {
      logOperation(
        res.locals.username,
        '删除Swarm服务（失败）',
        'swarm-service',
        id,
        e?.message || '未知错误',
        false,
      );
      res.json({ ok: false, error: e?.message || '删除服务失败' });
    }
  }),
);

/**
 * POST /api/swarm/services/:id/scale
 * 缩放指定 Swarm 服务到指定副本数（管理员操作，仅对 replicated 模式生效）
 * @body replicas 目标副本数（非负整数）
 */
router.post(
  '/services/:id/scale',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const state = await getSwarmState(docker);
    if (!state.enabled) {
      return res.json({ ok: false, error: 'swarm-not-enabled' });
    }
    const id = String(req.params.id);
    const replicas = Number(req.body?.replicas);
    // 校验副本数：需为非负整数
    if (!Number.isInteger(replicas) || replicas < 0) {
      return res.json({ ok: false, error: '副本数必须为非负整数' });
    }
    try {
      const svc = (await docker.getService(id).inspect()) as any;
      const name = svc?.Spec?.Name || id;
      const spec = svc?.Spec || {};
      // 仅支持复制模式缩放
      if (!spec.Mode?.Replicated) {
        return res.json({ ok: false, error: '该服务为 global 模式，不支持缩放副本数' });
      }
      // 构造更新体：携带当前 Version.Index 进行乐观并发控制，Spec 继承原配置仅覆盖副本数
      const updateSpec = {
        Version: { Index: svc?.Version?.Index ?? 0 },
        Spec: {
          ...spec,
          Mode: { Replicated: { Replicas: replicas } },
        },
      };
      await (docker.getService(id) as any).update(undefined, updateSpec);
      logOperation(res.locals.username, '缩放Swarm服务', 'swarm-service', name, `→ ${replicas} 副本`);
      res.json({ ok: true, replicas });
    } catch (e: any) {
      logOperation(
        res.locals.username,
        '缩放Swarm服务（失败）',
        'swarm-service',
        id,
        e?.message || '未知错误',
        false,
      );
      res.json({ ok: false, error: e?.message || '缩放服务失败' });
    }
  }),
);

export default router;
