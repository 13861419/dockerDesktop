/**
 * 面板登录鉴权模块
 *
 * 采用内存 Token 方案（无需数据库与额外依赖）：
 *  - 登录成功后生成随机会话 Token，存入内存 Map 并带过期时间
 *  - requireAuth 中间件校验请求头 Authorization: Bearer <token>
 *  - 默认账号由环境变量 ADMIN_USER / ADMIN_PASS 提供，缺省 admin / admin888
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { verifyCredentials as usersVerifyCredentials, getUserRole } from './users';
import { getSetting } from './settings';

/** 会话过期时间（毫秒）：配置中心 auth.ttlHours（db > env > 默认 24h） */
function sessionTtlMs(): number {
  const hours = getSetting<number>('auth.ttlHours') ?? 24;
  return hours * 3600 * 1000;
}

/** 是否启用滑动续期：活跃用户每次访问自动刷新到期时间，避免活跃用户中途掉线（默认开启，AUTH_SLIDING=false 关闭） */
const SLIDING = process.env.AUTH_SLIDING !== 'false';

/** 默认管理员账号/密码（用于初始化用户存储，见 users.ts） */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin888';
void ADMIN_PASS;

interface Session {
  token: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

/** 会话存储 */
const sessions = new Map<string, Session>();

/** 定时清理过期会话 */
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(token);
  }
}, 10 * 60 * 1000);

/**
 * 校验用户名密码（委托给文件持久化的用户存储）
 * @param username 用户名
 * @param password 密码
 */
export function verifyCredentials(
  username: string,
  password: string,
): { ok: boolean; mustChangePassword: boolean } {
  return usersVerifyCredentials(username, password);
}

/**
 * 创建并返回一个会话 Token
 * @param username 用户名
 */
export function createSession(username: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    token,
    username,
    createdAt: now,
    expiresAt: now + sessionTtlMs(),
  });
  return token;
}

/**
 * 校验 Token 是否有效
 * @param token 会话 Token
 */
export function isValidToken(token: string): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  // 滑动续期：活跃用户每次访问刷新到期时间
  if (SLIDING) {
    s.expiresAt = Date.now() + sessionTtlMs();
  }
  return true;
}

/**
 * 销毁会话
 * @param token 会话 Token
 */
export function destroySession(token: string): void {
  sessions.delete(token);
}

/**
 * 根据 Token 获取会话对应的用户名
 * @param token 会话 Token
 * @returns 用户名，无效则返回 null
 */
export function getSessionUsername(token: string): string | null {
  const s = sessions.get(token);
  return s ? s.username : null;
}

/**
 * 从请求头中提取 Token
 * @param req 请求
 */
export function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * 鉴权中间件：保护需要登录的接口
 * 校验通过后会将当前登录用户信息写入 res.locals.user（含 username 与 role），
 * 供后续记录操作日志与权限校验使用。
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token || !isValidToken(token)) {
    return res.status(401).json({ error: '未登录或会话已过期，请重新登录' });
  }
  const username = getSessionUsername(token) as string;
  const role = getUserRole(username);
  // 审计员为只读角色：仅放行幂等读方法，其余一律 403
  if (role === 'auditor' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: '审计员为只读角色，不可执行写操作' });
  }
  res.locals.user = {
    username,
    role,
  };
  // 兼容旧代码：保留 res.locals.username
  res.locals.username = username;
  next();
}

/**
 * 管理员权限中间件：仅允许 admin 角色访问（须在 requireAuth 之后使用）
 * 用于保护删除 / 恢复 / 引擎切换 / 用户管理等破坏性操作。
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (res.locals.user?.role !== 'admin') {
    return res.status(403).json({ error: '该操作需要管理员权限' });
  }
  next();
}

/** 支持的角色类型 */
export type Role = 'admin' | 'operator' | 'user';

/**
 * 运维人员权限中间件：允许 admin 或 operator 角色访问（须在 requireAuth 之后使用）
 * 用于放宽需要「能管理容器等资源但不一定是系统管理员」的操作，
 * 而用户管理 / 系统恢复 / 引擎切换等仍保持 requireAdmin 不变。
 */
export function requireOperator(req: Request, res: Response, next: NextFunction) {
  const role = res.locals.user?.role;
  if (role !== 'admin' && role !== 'operator') {
    return res.status(403).json({ error: '该操作需要运维或管理员权限' });
  }
  next();
}
