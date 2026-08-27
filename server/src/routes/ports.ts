/**
 * 跨引擎端口占用地图 API 路由（挂载路径 /api/ports）
 *
 * 遍历 docker_engines 表中的全部引擎，收集每个引擎上所有容器的端口映射
 * （hostPort <-> containerPort），聚合成"宿主端口 -> 占用容器"的地图，
 * 并检测两类问题：
 * - 冲突（conflict）：同一引擎上多个容器绑定了同一宿主端口（实际会互相争抢）
 * - 跨引擎重复（cross）：不同引擎绑定了相同宿主端口（通常无害，仅提示）
 *
 * 容错策略与 aggregate.ts 一致：单个引擎不可达时标记 offline，不影响其它引擎。
 */
import { Router, Request, Response } from 'express';
import { getDb } from '../storage';
import { getDockerClient, getDockerClientForEndpoint } from '../docker/client';

const router = Router();

/** 引擎端点行结构 */
interface EngineEndpointRow {
  id: string;
  name: string;
  endpoint: string;
  is_current: number;
}

/** 单条端口映射记录 */
export interface PortEntry {
  /** 宿主端口 */
  hostPort: number;
  /** 协议 tcp/udp */
  protocol: string;
  engineId: string;
  engineName: string;
  containerId: string;
  containerName: string;
  /** 容器内端口 */
  containerPort: number;
  /** 绑定的宿主 IP（0.0.0.0 表示全部网卡） */
  hostIp: string;
}

/** 同一端口的占用组 */
export interface PortGroup {
  hostPort: number;
  protocol: string;
  entries: PortEntry[];
  /** 同引擎多容器争抢同一端口 */
  conflict: boolean;
  /** 跨引擎重复绑定 */
  crossEngine: boolean;
}

/** 引擎在线状态摘要 */
interface EngineStatus {
  id: string;
  name: string;
  online: boolean;
  error?: string;
}

/**
 * 统一兜底错误处理（与 aggregate.ts 相同模式）
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message = err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 从 listContainers 输出中提取某容器的端口映射条目
 * @param c listContainers 返回的单个容器对象
 */
export function extractEntries(c: any, engine: EngineEndpointRow): PortEntry[] {
  const name = (c?.Names?.[0] || '').replace(/^\//, '') || c?.Id?.slice(0, 12) || '';
  const out: PortEntry[] = [];
  for (const p of c?.Ports || []) {
    // PublicPort 为宿主端口；仅记录宿主侧有映射的端口
    if (typeof p?.PublicPort !== 'number') continue;
    out.push({
      hostPort: p.PublicPort,
      protocol: p.Type || 'tcp',
      engineId: engine.id,
      engineName: engine.name,
      containerId: c.Id?.slice(0, 12) || '',
      containerName: name,
      containerPort: p.PrivatePort,
      hostIp: p.IP || '0.0.0.0',
    });
  }
  return out;
}

/**
 * GET /api/ports/map
 * 返回全部引擎的端口占用地图：映射条目 + 分组 + 冲突检测 + 摘要
 */
router.get(
  '/map',
  asyncHandler(async (_req: Request, res: Response) => {
    const d = getDb();
    const rows = d
      .prepare('SELECT id, name, endpoint, is_current FROM docker_engines ORDER BY created_at ASC')
      .all() as unknown as EngineEndpointRow[];

    const engines: EngineStatus[] = [];
    const entries: PortEntry[] = [];

    // 扫描列表：本机引擎（自动探测端点）+ 已注册引擎。
    // 若某注册引擎即当前引擎（is_current=1），本机与它重复，跳过该注册项以免双重计数。
    const currentEndpoint = rows.find((r) => r.is_current)?.endpoint || null;
    type ScanItem = { id: string; name: string; endpoint: string; local: boolean };
    const scanList: ScanItem[] = [{ id: 'local', name: '本机', endpoint: '', local: true }];
    for (const row of rows) {
      if (row.is_current || row.endpoint === currentEndpoint) continue;
      scanList.push({ id: row.id, name: row.name, endpoint: row.endpoint, local: false });
    }

    // 并行收集各引擎的端口映射，单个引擎失败不影响整体
    await Promise.all(
      scanList.map(async (item) => {
        try {
          const docker = item.local ? await getDockerClient() : getDockerClientForEndpoint(item.endpoint);
          const containers = await docker.listContainers({ all: true });
          engines.push({ id: item.id, name: item.name, online: true });
          for (const c of containers) {
            entries.push(...extractEntries(c, { id: item.id, name: item.name, endpoint: item.endpoint, is_current: item.local ? 1 : 0 }));
          }
        } catch (err: any) {
          engines.push({ id: item.id, name: item.name, online: false, error: err?.message || '无法连接该引擎' });
        }
      }),
    );

    // 按 宿主端口+协议 分组（保持端口升序展示）
    const groupMap = new Map<string, PortGroup>();
    for (const e of entries.sort((a, b) => a.hostPort - b.hostPort)) {
      const key = `${e.hostPort}/${e.protocol}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, { hostPort: e.hostPort, protocol: e.protocol, entries: [], conflict: false, crossEngine: false });
      }
      groupMap.get(key)!.entries.push(e);
    }

    // 冲突检测：同引擎同端口多容器 = 冲突；跨引擎同端口 = 跨引擎重复
    const conflicts: PortGroup[] = [];
    for (const g of groupMap.values()) {
      const byEngine = new Set(g.entries.map((e) => e.engineId));
      if (g.entries.length > 1) {
        if (byEngine.size < g.entries.length) {
          g.conflict = true;
          conflicts.push(g);
        } else if (byEngine.size > 1) {
          g.crossEngine = true;
        }
      }
    }

    const groups = [...groupMap.values()].sort((a, b) => a.hostPort - b.hostPort);

    res.json({
      engines: engines.sort((a, b) => a.name.localeCompare(b.name)),
      entries,
      groups,
      conflicts,
      summary: {
        entryCount: entries.length,
        hostPortCount: groups.length,
        conflictCount: conflicts.length,
      },
    });
  }),
);

export default router;
