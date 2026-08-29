/**
 * 自定义角色 RBAC 模块（0.4.0）
 *
 * 角色存储于 roles 表（name / permissions JSON / system），
 * 用户记录的 role 字段保存角色名（内置：admin / operator / user / auditor，
 * 以及任意自定义角色）。
 *
 * 权限目录仅覆盖「资源管理域」（容器 / 镜像 / 卷 / 网络 / 编排）；
 * 用户管理、系统设置、引擎切换、备份恢复等系统级操作仍为管理员专属（requireAdmin）。
 * admin 内置角色持有通配权限 '*'，不受目录约束。
 */
import { Request, Response, NextFunction } from 'express';
import { getDb } from './storage';

/** 权限键目录（key -> 展示信息） */
export const PERMISSIONS: Array<{ key: string; label: string; group: string }> = [
  { key: 'containers.run', label: '容器生命周期（创建/启动/停止/重启/重命名等）', group: '容器' },
  { key: 'containers.delete', label: '删除容器', group: '容器' },
  { key: 'images.pull', label: '拉取镜像', group: '镜像' },
  { key: 'images.write', label: '镜像管理（打标签/推送/导入）', group: '镜像' },
  { key: 'images.delete', label: '删除镜像（含批量）', group: '镜像' },
  { key: 'images.prune', label: '清理镜像（悬空/全部未使用）', group: '镜像' },
  { key: 'volumes.write', label: '卷管理（创建/克隆/导出）', group: '存储' },
  { key: 'volumes.delete', label: '删除卷', group: '存储' },
  { key: 'volumes.prune', label: '清理未使用卷', group: '存储' },
  { key: 'networks.write', label: '网络管理（创建/连接/断开/删除）', group: '网络' },
  { key: 'networks.prune', label: '清理网络', group: '网络' },
  { key: 'compose.write', label: '编排部署/重启/构建', group: '编排' },
  { key: 'compose.down', label: '停止编排项目', group: '编排' },
];

/** 内置角色默认权限 */
const BUILTIN_ROLES: Array<{ name: string; permissions: string[]; system: 0 | 1 }> = [
  { name: 'admin', permissions: ['*'], system: 1 },
  {
    name: 'operator',
    permissions: [
      'containers.run',
      'images.pull',
      'images.write',
      'volumes.write',
      'networks.write',
      'compose.write',
    ],
    system: 1,
  },
  { name: 'user', permissions: [], system: 1 },
  { name: 'auditor', permissions: [], system: 1 },
];

/** 角色行 */
export interface RoleRow {
  name: string;
  permissions: string[];
  system: boolean;
}

/** 权限缓存（角色名 -> 权限数组；写操作时失效） */
const cache = new Map<string, string[]>();

/** 启动时确保内置角色存在（幂等） */
export function ensureBuiltinRoles(): void {
  const d = getDb();
  const ins = d.prepare('INSERT OR IGNORE INTO roles (name, permissions, system, created_at) VALUES (?, ?, ?, ?)');
  for (const r of BUILTIN_ROLES) {
    ins.run(r.name, JSON.stringify(r.permissions), r.system, Date.now());
  }
  cache.clear();
}

/** 读取角色权限数组（带缓存；角色不存在返回 undefined） */
function loadPermissions(role: string | undefined): string[] | undefined {
  if (!role) return undefined;
  if (cache.has(role)) return cache.get(role);
  const row = getDb().prepare('SELECT permissions FROM roles WHERE name = ?').get(role) as
    | { permissions: string }
    | undefined;
  if (!row) return undefined;
  let perms: string[] = [];
  try {
    perms = JSON.parse(row.permissions) || [];
  } catch {
    perms = [];
  }
  cache.set(role, perms);
  return perms;
}

/**
 * 判断角色是否拥有某权限
 * @param role 角色名
 * @param perm 权限键（目录中的 key 或 '*'）
 */
export function hasPermission(role: string | undefined, perm: string): boolean {
  if (role === 'admin') return true; // 兼容：admin 角色名恒为全权（含 roles 表缺失时）
  const perms = loadPermissions(role);
  if (!perms) return false;
  return perms.includes('*') || perms.includes(perm);
}

/**
 * 权限中间件工厂：校验当前登录用户角色是否拥有指定权限
 * （须在 requireAuth 之后使用）
 */
export function requirePermission(perm: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = res.locals.user?.role as string | undefined;
    if (!hasPermission(role, perm)) {
      const label = PERMISSIONS.find((p) => p.key === perm)?.label || perm;
      return res.status(403).json({ error: `缺少权限：${label}（请联系管理员在角色管理中分配）` });
    }
    next();
  };
}

/** 角色名合法性：2-40 位中英文/数字/下划线/连字符 */
function validName(name: string): boolean {
  return /^[\w\u4e00-\u9fa5-]{2,40}$/.test(name);
}

/** 列出全部角色（按内置优先、名称排序） */
export function listRoles(): RoleRow[] {
  const rows = getDb()
    .prepare('SELECT name, permissions, system FROM roles')
    .all() as Array<{ name: string; permissions: string; system: number }>;
  return rows
    .map((r) => {
      let perms: string[] = [];
      try {
        perms = JSON.parse(r.permissions) || [];
      } catch {
        perms = [];
      }
      return { name: r.name, permissions: perms, system: r.system === 1 };
    })
    .sort((a, b) => (a.system === b.system ? a.name.localeCompare(b.name) : a.system ? -1 : 1));
}

/** 角色是否存在 */
export function roleExists(name: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM roles WHERE name = ?').get(name);
}

/**
 * 创建自定义角色
 * @throws 名称非法/已存在/权限键未知时抛 400
 */
export function createRole(name: string, permissions: string[]): RoleRow {
  if (!validName(name)) throw Object.assign(new Error('角色名需为 2-40 位中英文、数字、下划线或连字符'), { statusCode: 400 });
  if (roleExists(name)) throw Object.assign(new Error('角色已存在'), { statusCode: 409 });
  const perms = validatePermissions(permissions);
  getDb()
    .prepare('INSERT INTO roles (name, permissions, system, created_at) VALUES (?, ?, 0, ?)')
    .run(name, JSON.stringify(perms), Date.now());
  cache.clear();
  return { name, permissions: perms, system: false };
}

/**
 * 更新角色权限（内置角色仅允许调整 operator 的权限集；admin/user/auditor 锁定）
 * @throws 角色不存在/权限键未知/内置角色锁定时抛错
 */
export function updateRole(name: string, permissions: string[]): RoleRow {
  if (!roleExists(name)) throw Object.assign(new Error('角色不存在'), { statusCode: 404 });
  const row = getDb().prepare('SELECT system FROM roles WHERE name = ?').get(name) as { system: number };
  if (row.system === 1 && name !== 'operator') {
    throw Object.assign(new Error('内置角色权限固定，不可修改'), { statusCode: 400 });
  }
  const perms = validatePermissions(permissions);
  getDb().prepare('UPDATE roles SET permissions = ? WHERE name = ?').run(JSON.stringify(perms), name);
  cache.clear();
  return { name, permissions: perms, system: row.system === 1 };
}

/**
 * 删除自定义角色（有用户在用时阻止，避免悬挂引用）
 * @throws 内置角色/仍有用户使用时抛错
 */
export function deleteRole(name: string): void {
  const row = getDb().prepare('SELECT system FROM roles WHERE name = ?').get(name) as { system: number } | undefined;
  if (!row) throw Object.assign(new Error('角色不存在'), { statusCode: 404 });
  if (row.system === 1) throw Object.assign(new Error('内置角色不可删除'), { statusCode: 400 });
  const used = getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(name) as { n: number };
  if (used.n > 0) {
    throw Object.assign(new Error(`仍有 ${used.n} 个用户使用该角色，请先调整其角色`), { statusCode: 400 });
  }
  getDb().prepare('DELETE FROM roles WHERE name = ?').run(name);
  cache.clear();
}

/** 校验权限键数组：只允许目录内合法键（'*' 仅限内置 admin，不接受提交） */
function validatePermissions(permissions: unknown): string[] {
  const valid = new Set(PERMISSIONS.map((p) => p.key));
  const list = Array.isArray(permissions) ? permissions.map(String) : [];
  for (const p of list) {
    if (!valid.has(p)) throw Object.assign(new Error(`未知权限键: ${p}`), { statusCode: 400 });
  }
  return Array.from(new Set(list));
}
