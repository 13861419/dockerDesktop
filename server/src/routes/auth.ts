/**
 * 登录鉴权 API 路由
 *
 * 提供登录、登出、获取当前登录用户三个接口。
 */
import { Router, Request, Response } from 'express';
import {
  verifyCredentials,
  createSession,
  destroySession,
  extractToken,
  isValidToken,
  getSessionUsername,
  createTotpTicket,
  consumeTotpTicket,
  listSessions,
  revokeSessions,
} from '../auth';
import { isLocked, getLockRemaining, registerFailure, registerIpFailure, isIpLocked, getIpLockRemaining, resetFailures } from '../loginProtection';
import { getUserRole, getUserSecurity, setMustChangePassword, userExists } from '../users';
import { listRoles } from '../rbac';
import { isIpAllowed, isPasswordExpired, requestIp } from '../security';
import { logOperation } from '../operationLog';
import { verifyTotp } from '../totp';

const router = Router();

/**
 * 统一兜底错误处理
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      res.status(500).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/**
 * POST /api/auth/login
 * 登录，成功返回 token。
 * 带登录失败保护：连续失败达到阈值后锁定该账号一段时间（默认 5 次 / 10 分钟）。
 */
router.post(
  '/login',
  asyncHandler(async (req: Request, res: Response) => {
    const ip = requestIp(req);
    const { username, password, ticket, code } = req.body || {};

    // 2FA 第二步：消费票据并校验验证码
    if (ticket) {
      const ticketUser = consumeTotpTicket(String(ticket));
      if (!ticketUser) {
        return res.status(401).json({ error: '2FA 验证已超时，请重新登录', totpExpired: true });
      }
      const sec = getUserSecurity(ticketUser);
      if (!sec.totpEnabled || !verifyTotp(sec.totpSecret, String(code || ''))) {
        logOperation(ticketUser, '登录失败', 'auth', ticketUser, `IP: ${ip}; 2FA 验证码错误`, false);
        return res.status(401).json({ error: '2FA 验证码不正确', totpRequired: true, ticket, totpUser: ticketUser });
      }
      const token = createSession(ticketUser, ip, String(req.headers['user-agent'] || ''));
      logOperation(ticketUser, '登录成功', 'auth', ticketUser, `IP: ${ip}`, true);
      return res.json({ token, username: ticketUser, role: getUserRole(ticketUser), mustChangePassword: false });
    }

    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    const user = String(username);

    // 检查账号（用户名维度）与来源 IP 是否已被锁定
    const remaining = getLockRemaining(user);
    if (isLocked(user) || remaining > 0) {
      logOperation(user, '登录被拒', 'auth', user, `IP: ${ip}; 账号锁定中`, false);
      return res.status(429).json({
        error: `登录失败次数过多，账号已暂时锁定，请在 ${remaining} 秒后重试`,
        locked: true,
        remaining,
      });
    }
    const ipRemaining = getIpLockRemaining(ip);
    if (isIpLocked(ip) || ipRemaining > 0) {
      logOperation(user, '登录被拒', 'auth', user, `IP: ${ip}; IP 锁定中`, false);
      return res.status(429).json({
        error: `该 IP 登录失败次数过多，已暂时锁定，请在 ${ipRemaining} 秒后重试`,
        locked: true,
        remaining: ipRemaining,
      });
    }

    // IP 白名单检查（用户级优先，其次全局；用户不存在时仅应用全局白名单）
    let sec: ReturnType<typeof getUserSecurity> | null = null;
    try {
      sec = getUserSecurity(user);
    } catch {
      // 用户不存在：交给下方密码校验返回 401
    }
    if (sec && !isIpAllowed(ip, sec.ipAllowlist)) {
      logOperation(user, '登录被拒', 'auth', user, `IP: ${ip}; 不在 IP 白名单内`, false);
      return res.status(403).json({ error: '当前 IP 不在允许访问的白名单内' });
    }

    const auth = verifyCredentials(user, String(password));
    if (!auth.ok) {
      // 记录一次失败（用户名 + IP 双维度，可能触发锁定）
      registerFailure(user, userExists(user));
      registerIpFailure(ip);
      logOperation(user, '登录失败', 'auth', user, `IP: ${ip}; 用户名或密码错误`, false);
      const locked = getLockRemaining(user);
      const ipLocked = getIpLockRemaining(ip);
      const effLocked = Math.max(locked, ipLocked);
      res.status(401).json({
        error: effLocked > 0 ? `用户名或密码错误，连续失败已触发锁定，请在 ${effLocked} 秒后重试` : '用户名或密码错误',
        locked: effLocked > 0,
        remaining: effLocked,
      });
      return;
    }

    // 密码过期策略：过期时置强制改密标记，登录响应提示
    const mustChange = auth.mustChangePassword || isPasswordExpired(sec?.pwdChangedAt);
    if (isPasswordExpired(sec?.pwdChangedAt)) {
      setMustChangePassword(user, true);
    }

    // 2FA 第一步：密码通过后签发票据，等待验证码
    if (sec?.totpEnabled) {
      const t = createTotpTicket(user);
      return res.json({ totpRequired: true, ticket: t, username: user, mustChangePassword: mustChange });
    }

    // 登录成功，清除失败记录（含 IP 维度）
    resetFailures(user, ip);
    const token = createSession(user, ip, String(req.headers['user-agent'] || ''));
    logOperation(user, '登录成功', 'auth', user, `IP: ${ip}; UA: ${String(req.headers['user-agent'] || '').slice(0, 120)}`, true);
    res.json({ token, username: user, role: getUserRole(user), mustChangePassword: mustChange });
  }),
);

/**
 * POST /api/auth/logout
 * 登出，销毁当前会话
 */
router.post(
  '/logout',
  asyncHandler(async (req: Request, res: Response) => {
    const token = extractToken(req);
    if (token) destroySession(token);
    res.json({ status: 'ok' });
  }),
);

/**
 * GET /api/auth/me
 * 获取当前登录用户信息（用于前端校验会话是否有效）
 */
router.get(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    const token = extractToken(req);
    if (!token || !isValidToken(token)) {
      return res.status(401).json({ error: '未登录或会话已过期' });
    }
    const username = getSessionUsername(token) || 'admin';
    const role = getUserRole(username);
    // 权限数组：admin 恒为全权（'*'）；其余角色读取 roles 表权限数组（角色缺失视为无权限）
    const permissions = role === 'admin' ? ['*'] : listRoles().find((r) => r.name === role)?.permissions ?? [];
    res.json({ authenticated: true, username, role, permissions });
  }),
);

/**
 * GET /api/auth/sessions
 * 会话管理：管理员查看全局会话，其他用户仅查看自己的；当前会话以 current 标记
 */
router.get(
  '/sessions',
  asyncHandler(async (req: Request, res: Response) => {
    const token = extractToken(req);
    if (!token || !isValidToken(token)) {
      return res.status(401).json({ error: '未登录或会话已过期' });
    }
    const me = getSessionUsername(token) || '';
    const isAdmin = getUserRole(me) === 'admin';
    const sessions = listSessions(isAdmin ? undefined : me, token);
    res.json({ sessions, isAdmin });
  }),
);

/**
 * POST /api/auth/sessions/revoke
 * 撤销会话：body { id? , username? }
 * - 普通用户：仅可撤销自己的会话（传 id 撤销单条；省略 id 撤销除当前外的全部）
 * - 管理员：可撤销任意用户的会话（传 username 批量撤销该用户）
 */
router.post(
  '/sessions/revoke',
  asyncHandler(async (req: Request, res: Response) => {
    const token = extractToken(req);
    if (!token || !isValidToken(token)) {
      return res.status(401).json({ error: '未登录或会话已过期' });
    }
    const me = getSessionUsername(token) || '';
    const isAdmin = getUserRole(me) === 'admin';
    const { id, username } = req.body || {};
    let n = 0;
    if (isAdmin && username) {
      n = revokeSessions({ username: String(username), currentToken: token });
    } else {
      n = revokeSessions({ tokenPrefix: id ? String(id) : undefined, username: me, currentToken: token });
    }
    res.json({ ok: true, revoked: n });
  }),
);

export default router;
