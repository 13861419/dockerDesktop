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
import { verifyCredentials as usersVerifyCredentials, getUserRole, getUserSecurity } from './users';
import { getSetting } from './settings';
import { isIpAllowed, requestIp } from './security';

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
  ip: string;
  userAgent: string;
}

/** 会话存储 */
const sessions = new Map<string, Session>();

/** 2FA 登录票据（第一步密码通过后签发，2 分钟单次有效） */
interface TotpTicket {
  username: string;
  expiresAt: number;
}
const totpTickets = new Map<string, TotpTicket>();
const TICKET_TTL = 2 * 60 * 1000;

/** 定时清理过期会话与票据 */
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(token);
  }
  for (const [id, t] of totpTickets) {
    if (t.expiresAt < now) totpTickets.delete(id);
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
 * @param ip 登录来源 IP（记录用）
 * @param userAgent 登录 User-Agent（展示用）
 */
export function createSession(username: string, ip = '', userAgent = ''): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  // 并发上限：auth.maxSessionsPerUser（0 = 不限制），超出时淘汰该用户最早创建的会话
  const maxSessions = Number(getSetting<number>('auth.maxSessionsPerUser') ?? 0);
  if (maxSessions > 0) {
    const mine = [...sessions.entries()]
      .filter(([, s]) => s.username === username)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (mine.length >= maxSessions) {
      const [oldest] = mine.shift()!;
      sessions.delete(oldest);
    }
  }
  sessions.set(token, {
    token,
    username,
    createdAt: now,
    expiresAt: now + sessionTtlMs(),
    ip,
    userAgent,
  });
  return token;
}

/** 对外展示的会话视图（token 仅暴露前 8 位前缀用于撤销定位） */
export interface SessionView {
  id: string;
  username: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
  userAgent: string;
  current: boolean;
}

/**
 * 列出会话（username 缺省 = 全部；管理员查看全局，普通用户仅看自己）
 */
export function listSessions(username?: string, currentToken = ''): SessionView[] {
  return [...sessions.values()]
    .filter((s) => !username || s.username === username)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => ({
      id: s.token.slice(0, 8),
      username: s.username,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.token === currentToken,
    }));
}

/**
 * 撤销会话：普通用户仅可撤销自己的会话；管理员传任意 username 可批量撤销该用户全部会话
 * @param opts.tokenPrefix 目标会话 ID（token 前 8 位）
 * @param opts.username 限定用户（管理员批量撤销用）
 * @param opts.currentToken 当前请求者的 token（current: true 的会话不可通过本接口撤销，登出请走 /logout）
 */
export function revokeSessions(opts: { tokenPrefix?: string; username?: string; currentToken?: string }): number {
  let n = 0;
  for (const [token, s] of sessions) {
    if (s.token === opts.currentToken) continue;
    if (opts.username && s.username !== opts.username) continue;
    const id = s.token.slice(0, 8);
    if (opts.tokenPrefix && id !== opts.tokenPrefix) continue;
    sessions.delete(token);
    n++;
  }
  return n;
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
 * 签发 2FA 登录票据（第一步密码验证通过后调用，2 分钟单次有效）
 * @param username 用户名
 */
export function createTotpTicket(username: string): string {
  const id = crypto.randomBytes(24).toString('hex');
  totpTickets.set(id, { username, expiresAt: Date.now() + TICKET_TTL });
  return id;
}

/**
 * 消费 2FA 登录票据（单次有效，取出对应用户名）
 * @returns 用户名；票据无效/过期返回 null
 */
export function consumeTotpTicket(ticket: string): string | null {
  const t = totpTickets.get(ticket);
  if (!t) return null;
  totpTickets.delete(ticket);
  if (t.expiresAt < Date.now()) return null;
  return t.username;
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
  // 每次请求执行 IP 白名单检查（用户级优先，其次全局；命中失败直接 403）
  try {
    const sec = getUserSecurity(username);
    if (!isIpAllowed(requestIp(req), sec.ipAllowlist)) {
      return res.status(403).json({ error: '当前 IP 不在允许访问的白名单内' });
    }
  } catch {
    // 用户不存在等异常交由后续流程处理
  }
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
