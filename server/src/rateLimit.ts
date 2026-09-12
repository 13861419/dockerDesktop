/**
 * 轻量 IP 滑动窗口限速（1.45.0，零第三方依赖）
 *
 * - 写接口（POST/PUT/PATCH/DELETE）分两档：
 *   - 携带 Authorization 的请求（面板正常使用 / 批量操作）：默认 600 次/分钟/IP；
 *   - 匿名写请求（真正的滥用面）：默认 60 次/分钟/IP；
 * - 匿名 Webhook 入口单独 30 次/分钟/IP；
 * - 阈值 / 窗口可经环境变量调整；设为 0 关闭对应档位；
 * - 计数存内存（重启清零），定时清理防膨胀。
 */
import { Request, Response, NextFunction } from 'express';
import { requestIp } from './security';

/** 携带鉴权头的写请求阈值（次/窗口，默认 600，0 = 关闭） */
const AUTH_MAX = Number(process.env.API_AUTH_RATE_LIMIT ?? 600);
/** 匿名写请求阈值（次/窗口，默认 60，0 = 关闭） */
const ANON_MAX = Number(process.env.API_ANON_RATE_LIMIT ?? 60);
/** Webhook 入口阈值（次/窗口，默认 30，0 = 关闭） */
const WEBHOOK_MAX = Number(process.env.WEBHOOK_RATE_LIMIT ?? 30);
/** 滑动窗口毫秒数（默认 60 秒） */
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);

/** key -> 窗口内命中时间戳数组 */
const buckets = new Map<string, number[]>();

/** 记录一次命中；超出阈值返回 -1，否则返回当前计数 */
function hit(key: string, max: number, now: number): number {
  const arr = (buckets.get(key) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  buckets.set(key, arr);
  return arr.length > max ? -1 : arr.length;
}

// 定时清理过期计数，避免内存膨胀
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    const keep = arr.filter((t) => now - t < WINDOW_MS);
    if (keep.length) buckets.set(k, keep);
    else buckets.delete(k);
  }
}, 60_000).unref?.();

/**
 * 全局写接口限速中间件：仅拦截 POST/PUT/PATCH/DELETE，GET 不限。
 * 按是否携带 Authorization 分档：鉴权请求宽松（批量操作），匿名请求严格。
 * 挂载在 JSON 解析之后、业务路由之前。
 */
export function writeRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (ANON_MAX <= 0 && AUTH_MAX <= 0) return next();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // 登录接口有自己的防爆破保护，不走全局写限速（避免与登录锁定双重计数）
  if (req.path === '/api/auth/login') return next();
  const authed = Boolean(req.headers.authorization);
  const max = authed ? AUTH_MAX : ANON_MAX;
  if (max <= 0) return next();
  const ip = requestIp(req) || 'unknown';
  // 鉴权与匿名分桶计数，避免共享数组互相挤占配额
  const n = hit((authed ? 'api:auth:' : 'api:anon:') + ip, max, Date.now());
  if (n < 0) {
    res.status(429).json({ error: `请求过于频繁（写接口限速 ${max} 次/${Math.round(WINDOW_MS / 1000)} 秒/IP），请稍后再试` });
    return;
  }
  next();
}

/**
 * 匿名 Webhook 入口限速中间件（按 IP）
 */
export function webhookRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (WEBHOOK_MAX <= 0) return next();
  const ip = requestIp(req) || 'unknown';
  const n = hit('wh:' + ip, WEBHOOK_MAX, Date.now());
  if (n < 0) {
    res.status(429).json({ error: `请求过于频繁（Webhook 限速 ${WEBHOOK_MAX} 次/${Math.round(WINDOW_MS / 1000)} 秒/IP）` });
    return;
  }
  next();
}
