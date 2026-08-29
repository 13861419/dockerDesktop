/**
 * 角色管理 API 路由（挂载路径 /api/roles）
 *
 *  - GET    /            列出全部角色（登录即可：用户页角色下拉需要）
 *  - GET    /permissions 权限目录（登录即可）
 *  - POST   /            创建自定义角色（管理员）
 *  - PUT    /:name       更新角色权限（管理员；内置角色仅 operator 可调）
 *  - DELETE /:name       删除自定义角色（管理员；有用户使用时阻止）
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../auth';
import { PERMISSIONS, listRoles, createRole, updateRole, deleteRole } from '../rbac';
import { logOperation } from '../operationLog';

const router = Router();

/** 统一兜底错误处理 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message = err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

router.get(
  '/',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ roles: listRoles() });
  }),
);

router.get(
  '/permissions',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ permissions: PERMISSIONS });
  }),
);

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { name, permissions } = req.body || {};
    const role = createRole(String(name || ''), permissions);
    logOperation(res.locals.username, '创建角色', '系统', name, `权限 ${role.permissions.length} 项`);
    res.json({ ok: true, role });
  }),
);

router.put(
  '/:name',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const role = updateRole(String(req.params.name), req.body?.permissions);
    logOperation(res.locals.username, '更新角色权限', '系统', req.params.name, `权限 ${role.permissions.length} 项`);
    res.json({ ok: true, role });
  }),
);

router.delete(
  '/:name',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    deleteRole(String(req.params.name));
    logOperation(res.locals.username, '删除角色', '系统', req.params.name, '');
    res.json({ ok: true });
  }),
);

export default router;
