/**
 * 面板数据库备份 API 路由（挂载路径 /api/sqlite-backups，仅管理员）
 *
 * - GET    /                  备份列表（按时间倒序）
 * - POST   /                  立即创建一次备份（body: { reason? }）
 * - POST   /:file/restore     用指定备份恢复（恢复后建议重启面板）
 * - DELETE /:file             删除备份文件
 * - GET    /:file/download    下载备份文件
 */
import { Router, Request, Response } from 'express';
import {
  listSqliteBackups,
  createSqliteBackup,
  deleteSqliteBackup,
  restoreSqliteBackup,
  resolveSqliteBackupFile,
} from '../sqliteBackup';
import { requireAdmin } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message = err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/** GET /api/sqlite-backups */
router.get(
  '/',
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ items: listSqliteBackups() });
  }),
);

/** POST /api/sqlite-backups */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const info = createSqliteBackup(String(req.body?.reason || 'manual'));
    logOperation(res.locals.username, '创建面板数据库备份', 'system', info.file, `（${(info.size / 1024).toFixed(0)} KB）`);
    res.status(201).json(info);
  }),
);

/** POST /api/sqlite-backups/:file/restore */
router.post(
  '/:file/restore',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const r = restoreSqliteBackup(String(req.params.file));
    logOperation(res.locals.username, '恢复面板数据库', 'system', String(req.params.file), r.message);
    res.json({ ok: true, ...r });
  }),
);

/** DELETE /api/sqlite-backups/:file */
router.delete(
  '/:file',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    deleteSqliteBackup(String(req.params.file));
    logOperation(res.locals.username, '删除面板数据库备份', 'system', String(req.params.file), '');
    res.json({ ok: true });
  }),
);

/** GET /api/sqlite-backups/:file/download */
router.get(
  '/:file/download',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const full = resolveSqliteBackupFile(String(req.params.file));
    res.download(full);
  }),
);

export default router;
