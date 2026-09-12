/**
 * 日志聚合中心 API 路由（挂 /api/logs）
 *
 * 提供跨容器统一日志检索：
 *  - GET /containers   ：可作为检索源的容器候选
 *  - GET /query        ：跨容器并发拉取日志，合并排序 + 关键字过滤 + 流过滤
 *  - GET /query/download：导出当前过滤结果（.txt）
 *
 * 只读：全链路仅 container.logs，无任何写操作。
 * 资源限制：容器数 ≤20、tailPer ≤5000、since/until 校验，防超大响应。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { fetchContainerLogLines, stripAnsi } from '../docker/logUtil';
import { queryLogHistory, getLogIndexStatus, pruneLogIndex } from '../docker/logIndexer';
import { logOperation } from '../operationLog';
import { allowlistFilterFor } from '../containerAuth';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      res.status(err?.statusCode || 500).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/** 参数安全解析 */
function num(v: any, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** 容器候选 */
router.get(
  '/containers',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const list = (await docker.listContainers({ all: true }).catch(() => [])) as any[];
    // 容器资源级授权（1.41.0）：名单外容器不作为日志检索源
    const allowFilter = allowlistFilterFor(res.locals.username);
    const visible = allowFilter
      ? list.filter((c: any) =>
          allowFilter((c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12) || '', c.Id || ''),
        )
      : list;
    res.json(
      visible.map((c: any) => ({
        id: c.Id,
        name: (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12),
        image: c.Image || '',
        status: c.Status || c.State || '',
      })),
    );
  }),
);

/** 白名单守卫：校验请求的容器 id 全部在名单内（1.41.0，防按 id 越权拉日志） */
async function assertIdsAllowed(req: Request, res: Response, containerIds: string[]): Promise<boolean> {
  const allowFilter = allowlistFilterFor(res.locals.username);
  if (!allowFilter) return true;
  const docker = await getDockerClient();
  const list = (await docker.listContainers({ all: true }).catch(() => [])) as any[];
  const nameById = new Map<string, string>();
  for (const c of list) {
    const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12) || '';
    nameById.set(c.Id, name);
    nameById.set(String(c.Id || '').slice(0, 12), name);
  }
  const ok = containerIds.every((id) => {
    const name = nameById.get(id) || nameById.get(id.slice(0, 12)) || '';
    if (!name) return false;
    return allowFilter(name, id);
  });
  if (!ok) res.status(403).json({ error: '无权访问该容器的日志（不在资源级授权名单内）' });
  return ok;
}

/** 核心聚合查询 */
router.get(
  '/query',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();

    const idsRaw = String(req.query.containerIds || '');
    const containerIds = idsRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (containerIds.length === 0) {
      return res.status(400).json({ error: '缺少 containerIds' });
    }
    if (!(await assertIdsAllowed(req, res, containerIds))) return res;

    const tailPer = num(req.query.tailPer, 500, 1, 5000);
    const since = num(req.query.since, 0, 0);
    const until = num(req.query.until, 0, 0);
    const keyword = String(req.query.keyword || '').trim();
    const streamsRaw = String(req.query.streams || 'stdout,stderr');
    const streams = new Set(streamsRaw.split(',').map((s) => s.trim()).filter(Boolean) as Array<'stdout' | 'stderr'>);

    // 并发拉取各容器日志（timestamps 打开便于排序）
    const fetched = await Promise.all(
      containerIds.map((id) =>
        fetchContainerLogLines(docker, id, {
          tail: tailPer,
          since: since || undefined,
          until: until || undefined,
          timestamps: true,
        }).catch(() => ({ name: id.slice(0, 12), lines: [] as any[] })),
      ),
    );

    // 合并、过滤、排序
    let lines = fetched.flatMap((f) =>
      f.lines.map((l) => ({
        ts: l.ts,
        container: f.name,
        stream: l.stream,
        text: stripAnsi(l.text),
      })),
    );
    if (streams.size > 0) lines = lines.filter((l) => streams.has(l.stream));
    if (keyword) {
      const kw = keyword.toLowerCase();
      lines = lines.filter((l) => l.text.toLowerCase().includes(kw));
    }
    // 排序：有 ts 按 ts，否则保持原始顺序
    lines = lines
      .map((l, i) => ({ ...l, __i: i }))
      .sort((a, b) => {
        if (a.ts !== undefined && b.ts !== undefined) return a.ts - b.ts;
        if (a.ts !== undefined) return -1;
        if (b.ts !== undefined) return 1;
        return a.__i - b.__i;
      })
      .map(({ __i, ...l }) => l);

    res.json({ lines, total: lines.length, truncated: lines.length > 10000, matched: keyword ? lines.length > 0 : true });
  }),
);

/** 导出当前过滤结果（.txt） */
router.get(
  '/query/download',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const idsRaw = String(req.query.containerIds || '');
    const containerIds = idsRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (containerIds.length === 0) {
      return res.status(400).json({ error: '缺少 containerIds' });
    }
    if (!(await assertIdsAllowed(req, res, containerIds))) return res;
    const tailPer = num(req.query.tailPer, 500, 1, 5000);
    const since = num(req.query.since, 0, 0);
    const until = num(req.query.until, 0, 0);
    const keyword = String(req.query.keyword || '').trim();
    const streamsRaw = String(req.query.streams || 'stdout,stderr');
    const streams = new Set(streamsRaw.split(',').map((s) => s.trim()).filter(Boolean) as Array<'stdout' | 'stderr'>);

    const fetched = await Promise.all(
      containerIds.map((id) =>
        fetchContainerLogLines(docker, id, {
          tail: tailPer,
          since: since || undefined,
          until: until || undefined,
          timestamps: true,
        }).catch(() => ({ name: id.slice(0, 12), lines: [] as any[] })),
      ),
    );

    let lines = fetched.flatMap((f) =>
      f.lines.map((l) => ({ ts: l.ts, container: f.name, stream: l.stream, text: stripAnsi(l.text) })),
    );
    if (streams.size > 0) lines = lines.filter((l) => streams.has(l.stream));
    if (keyword) {
      const kw = keyword.toLowerCase();
      lines = lines.filter((l) => l.text.toLowerCase().includes(kw));
    }
    lines = lines
      .map((l, i) => ({ ...l, __i: i }))
      .sort((a, b) => {
        if (a.ts !== undefined && b.ts !== undefined) return a.ts - b.ts;
        if (a.ts !== undefined) return -1;
        if (b.ts !== undefined) return 1;
        return a.__i - b.__i;
      })
      .map(({ __i, ...l }) => l);

    const body = lines
      .map((l) => {
        const ts = l.ts ? new Date(l.ts).toISOString() : '';
        return `${ts}\t[${l.container}]\t(${l.stream})\t${l.text}`;
      })
      .join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="logs-aggregated.txt"');
    res.send(body);
  }),
);

/** 历史检索：查持久化日志索引（logs.indexEnabled 开启后有数据） */
router.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const containerIds = String(req.query.containerIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    const keyword = String(req.query.keyword || '').trim();
    const since = num(req.query.since, 0, 0);
    const until = num(req.query.until, 0, 0);
    const limit = num(req.query.limit, 500, 1, 5000);
    res.json(queryLogHistory({ containerIds, keyword, since, until, limit }));
  }),
);

/** 历史检索：索引状态 */
router.get('/history/status', asyncHandler(async (_req: Request, res: Response) => {
  res.json(getLogIndexStatus());
}));

/** 历史检索：手动清理（管理员） */
router.post(
  '/history/prune',
  asyncHandler(async (req: Request, res: Response) => {
    const result = pruneLogIndex();
    logOperation(res.locals.username, '手动清理日志索引', 'logs', '', `expired=${result.expired} overflow=${result.overflow}`, true);
    res.json({ ok: true, ...result });
  }),
);

export default router;
