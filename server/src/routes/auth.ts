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
} from '../auth';
import { isLocked, getLockRemaining, registerFailure, resetFailures } from '../loginProtection';
import { getUserRole } from '../users';

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
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    const user = String(username);

    // 检查账号是否已被锁定
    const remaining = getLockRemaining(user);
    if (isLocked(user) || remaining > 0) {
      return res.status(429).json({
        error: `登录失败次数过多，账号已暂时锁定，请在 ${remaining} 秒后重试`,
        locked: true,
        remaining,
      });
    }

    const auth = verifyCredentials(user, String(password));
    if (!auth.ok) {
      // 记录一次失败，可能触发锁定
      registerFailure(user);
      const locked = getLockRemaining(user);
      res.status(401).json({
        error: locked > 0 ? `用户名或密码错误，连续失败已触发锁定，请在 ${locked} 秒后重试` : '用户名或密码错误',
        locked: locked > 0,
        remaining: locked,
      });
      return;
    }
    // 登录成功，清除失败记录
    resetFailures(user);
    const token = createSession(user);
    res.json({ token, username: user, role: getUserRole(user), mustChangePassword: auth.mustChangePassword });
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
    res.json({ authenticated: true, username, role: getUserRole(username) });
  }),
);

export default router;
