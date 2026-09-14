/**
 * Edge 节点管理 API（/api/edge，1.63.0）
 *
 * MVP：节点注册 / 列表 / 删除 / 连通性测试 / Docker 只读透传。
 * 后续版本：写操作透传、每节点容器页、事件聚合。
 */
import { Router, Request, Response } from 'express';
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

function assertReadonlyPath(path: string): void {
  const clean = String(path || '');
  if (!READONLY_PATHS.some((p) => clean === p || clean.startsWith(p + '?'))) {
    const err: any = new Error('该路径不允许透传（仅只读白名单）');
    err.statusCode = 400;
    throw err;
  }
}

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
    const path = decodeURIComponent(rest.split('?')[0]);
    assertReadonlyPath('/' + path);
    try {
      const { status, data } = await callEdgeNode(req.params.id, 'GET', '/' + rest);
      res.status(status).json(data);
    } catch (e: any) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  }),
);

export default router;
