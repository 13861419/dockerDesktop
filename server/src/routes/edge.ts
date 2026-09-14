/**
 * Edge 节点管理 API（/api/edge，1.63.0）
 *
 * MVP：节点注册 / 列表 / 删除 / 连通性测试 / Docker 只读透传。
 * 后续版本：写操作透传、每节点容器页、事件聚合。
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../auth';
import {
  createEdgeNode,
  deleteEdgeNode,
  listEdgeNodes,
} from '../edge/registry';
import {
  callEdgeNode,
  isEdgeNodeOnline,
  onlineEdgeNodeIds,
} from '../edge/tunnel';

const router = Router();

/** 与其他路由保持一致的异步错误转换 */
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

/** 只允许只读的 Docker API 透传路径前缀 */
const READONLY_PATHS = [
  '/version',
  '/info',
  '/containers/json',
  '/images/json',
  '/networks',
  '/volumes',
];

/** 允许的写操作（1.64.0）：容器生命周期 + 镜像拉取；（1.65.0）容器创建 / 日志 */
const WRITE_PATHS: Array<{ method: string; re: RegExp }> = [
  { method: 'POST', re: /^\/containers\/[^/]+\/(start|stop|restart)$/ },
  { method: 'DELETE', re: /^\/containers\/[^/]+$/ },
  { method: 'POST', re: /^\/containers\/prune$/ },
  { method: 'POST', re: /^\/images\/create$/ },
  { method: 'DELETE', re: /^\/images\/[^/]+$/ },
  { method: 'POST', re: /^\/containers\/create$/ },
  { method: 'GET', re: /^\/containers\/[^/]+\/logs$/ },
];

/** 校验透传路径（method 为大写 HTTP 方法；path 不含 query） */
function assertPassthroughPath(method: string, path: string): void {
  const clean = String(path || '').split('?')[0];
  if (READONLY_PATHS.some((p) => clean === p || clean.startsWith(p + '?')) && method === 'GET') {
    return;
  }
  if (WRITE_PATHS.some((w) => w.method === method && w.re.test(clean))) {
    return;
  }
  const err: any = new Error('该路径不允许透传（仅只读白名单与受控写操作）');
  err.statusCode = 400;
  throw err;
}

/** 长耗时操作（镜像拉取等）放宽超时 */
const LONG_PATHS = ['/images/create'];

/** 节点列表（含在线状态） */
router.get(
  '/nodes',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const nodes = listEdgeNodes(isEdgeNodeOnline);
    res.json({ items: nodes, onlineIds: onlineEdgeNodeIds() });
  }),
);

/** 新建节点（token 仅返回一次） */
router.post(
  '/nodes',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { name } = req.body || {};
    const { node, token } = createEdgeNode(name);
    res.status(201).json({ node, token });
  }),
);

/** 删除节点 */
router.delete(
  '/nodes/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const ok = deleteEdgeNode(req.params.id);
    if (!ok) {
      res.status(404).json({ error: '节点不存在' });
      return;
    }
    res.json({ ok: true });
  }),
);

/** 连通性测试：经隧道取远端 /version */
router.post(
  '/nodes/:id/ping',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const { data } = await callEdgeNode(req.params.id, 'GET', '/version');
      res.json({ ok: true, version: data });
    } catch (e: any) {
      res.status(e.statusCode || 500).json({ ok: false, error: e.message });
    }
  }),
);

/** 只读 Docker 透传（容器 / 镜像 / 网络 / 卷） */
router.get(
  '/nodes/:id/docker/*',
  requireAuth,
  asyncHandler(async (req, res: Response) => {
    // Express 通配符参数不含 query string，从 originalUrl 还原完整透传路径
    const rest = String(req.originalUrl || '').split('/docker/')[1] || '';
    assertPassthroughPath('GET', '/' + rest);
    try {
      const { status, data } = await callEdgeNode(req.params.id, 'GET', '/' + rest);
      res.status(status).json(data);
    } catch (e: any) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  }),
);

/** 受控写透传（容器 start/stop/restart/删除、镜像拉取/删除，1.64.0） */
router.post('/nodes/:id/docker/*', requireAuth, asyncHandler(edgeWrite));
router.delete('/nodes/:id/docker/*', requireAuth, asyncHandler(edgeWrite));

async function edgeWrite(req: Request, res: Response) {
  const parts = String(req.originalUrl || '').split('/docker/');
  const rest = parts[1] || '';
  const method = req.method.toUpperCase();
  assertPassthroughPath(method, '/' + rest.split('?')[0]);
  const isLong = LONG_PATHS.some((p) => ('/' + rest).startsWith(p));
  try {
    const { status, data } = await callEdgeNode(
      req.params.id,
      method,
      '/' + rest,
      req.body,
      isLong ? 300_000 : 30_000,
    );
    res.status(status).json(data);
  } catch (e: any) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
}

export default router;

/**
 * 公开路由（无需登录，1.64.0）：agent 安装文件下发
 * 挂载于 /api/edge（须先于需登录的 edgeRouter）。
 */
export const edgePublicRouter = Router();

const AGENT_DIR = path.resolve(__dirname, '../../agent');

edgePublicRouter.get('/agent.js', (_req: Request, res: Response) => {
  res.type('application/javascript').send(fs.readFileSync(path.join(AGENT_DIR, 'agent.js'), 'utf8'));
});

edgePublicRouter.get('/agent.sh', (_req: Request, res: Response) => {
  res.type('text/x-sh').send(fs.readFileSync(path.join(AGENT_DIR, 'install.sh'), 'utf8'));
});
