/**
 * 数据卷（Volumes）管理 API 路由
 *
 * 提供数据卷的列表、创建、删除、详情等接口。
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
 * GET /api/volumes
 * 获取数据卷列表
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const data = await docker.listVolumes();
    res.json({ volumes: data.Volumes || [] });
  }),
);

/**
 * GET /api/volumes/:name
 * 获取单个数据卷详情
 */
router.get(
  '/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const volume = await docker.getVolume(req.params.name).inspect();
    res.json(volume);
  }),
);

/**
 * POST /api/volumes
 * 创建数据卷
 * body: { name, driver, driverOpts, labels }
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const b = req.body || {};
    const volume = await docker.createVolume({
      Name: b.name,
      Driver: b.driver || 'local',
      DriverOpts: b.driverOpts || undefined,
      Labels: b.labels || undefined,
    });
    logOperation(res.locals.username, '创建数据卷', 'volume', b.name, `驱动: ${b.driver || 'local'}`);
    res.status(201).json(volume);
  }),
);

/**
 * DELETE /api/volumes/:name?force=true
 * 删除数据卷，force 忽略使用中的卷
 */
router.delete(
  '/:name',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const force = req.query.force === 'true';
    const volume = docker.getVolume(req.params.name);
    try {
      await volume.remove();
    } catch (err: any) {
      // 若卷正在使用且未强制，返回 409 冲突
      if (err?.statusCode === 409 && force) {
        // 已忽略冲突
      } else {
        throw err;
      }
    }
    res.json({ ok: true });
    logOperation(res.locals.username, '删除数据卷', 'volume', req.params.name, force ? '强制删除' : undefined);
  }),
);

/**
 * POST /api/volumes/prune
 * 清理未被使用的数据卷
 */
router.post(
  '/prune',
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const result = await docker.pruneVolumes();
    const deleted = (result?.VolumesDeleted || []).join(', ');
    logOperation(res.locals.username, '清理未使用卷', 'volume', null, deleted || undefined);
    res.json(result);
  }),
);

export default router;
