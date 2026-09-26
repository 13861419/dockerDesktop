/**
 * 容器回收站 API 路由
 *
 * 列出 / 恢复 / 删除 / 清空回收站快照。恢复 = 按快照配置重建容器
 * （默认启动，可用 body.start=false 仅创建；body.name 可覆盖原名）。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { asyncHandler } from '../composeUtil';
import { requireAuth, requireOperator } from '../auth';
import { logOperation } from '../operationLog';
import { buildCreateOptionsFromSnapshot, deleteRecycle, getRecycle, listRecycle, purgeRecycle } from '../recycle';

const router = Router();

/**
 * GET /api/recycle
 * 回收站列表（不含快照明文，按删除时间倒序）
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(listRecycle());
  }),
);

/**
 * POST /api/recycle/:id/restore
 * 按快照重建容器。body: { name?: string（缺省用原名）, start?: boolean（缺省 true） }
 * 名称冲突返回 409；镜像不存在返回 400。
 */
router.post(
  '/:id/restore',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const rec = getRecycle(id);
    if (!rec) return res.status(404).json({ error: '回收站记录不存在' });
    const docker = await getDockerClient();
    const name = String(req.body?.name || '').trim() || rec.name;
    const start = req.body?.start !== false;
    let cfg: any;
    try {
      cfg = JSON.parse(rec.config);
    } catch {
      return res.status(500).json({ error: '快照数据损坏' });
    }
    const opts = buildCreateOptionsFromSnapshot(cfg, name);
    try {
      const container = await docker.createContainer(opts);
      if (start) await container.start();
      deleteRecycle(id);
      logOperation(
        res.locals.username,
        '回收站恢复容器',
        'container',
        name,
        `原容器: ${rec.name}; 镜像: ${rec.image || '未知'}${start ? '' : '（未启动）'}`,
      );
      return res.status(201).json({ ok: true, id: container.id, name });
    } catch (err: any) {
      if (err?.statusCode === 409) {
        return res.status(409).json({ error: `容器名 "${name}" 已存在，请更换名称后重试` });
      }
      if (err?.statusCode === 404) {
        return res.status(400).json({ error: `镜像不存在（${opts.Image}），请先拉取镜像后再恢复` });
      }
      throw err;
    }
  }),
);

/**
 * DELETE /api/recycle/:id
 * 删除单条回收站记录
 */
router.delete(
  '/:id',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!getRecycle(id)) return res.status(404).json({ error: '回收站记录不存在' });
    deleteRecycle(id);
    logOperation(res.locals.username, '回收站删除记录', 'container', String(id));
    res.json({ ok: true });
  }),
);

/**
 * POST /api/recycle/purge
 * 清空回收站
 */
router.post(
  '/purge',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    purgeRecycle();
    logOperation(res.locals.username, '回收站清空', 'container', '');
    res.json({ ok: true });
  }),
);

export default router;
