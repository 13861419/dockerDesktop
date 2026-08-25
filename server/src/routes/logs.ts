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
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const list = (await docker.listContainers({ all: true }).catch(() => [])) as any[];
    res.json(
      list.map((c: any) => ({
        id: c.Id,
        name: (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12),
        image: c.Image || '',
        status: c.Status || c.State || '',
      })),
    );
  }),
);

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

export default router;
