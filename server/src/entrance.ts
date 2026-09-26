/**
 * 安全入口（隐藏路径）中间件
 *
 * 通过环境变量 ENTRANCE_PATH 启用（如 /my-panel-9x7）。启用后：
 *  - 仅访问秘密路径会签发 HttpOnly Cookie 并进入面板，其余路径一律 404
 *  - 已持有效 Cookie 的请求（同源 API / WebSocket 升级自动携带）正常放行
 *  - 自带鉴权的机器入口（health / metrics / webhook / mcp / edge agent）保持豁免
 *
 * 未设置 ENTRANCE_PATH 时中间件直通，行为与未启用版本完全一致（向后兼容）。
 * 注意：WebSocket 升级请求不走 Express 中间件，终端类端点由自身会话 Token 鉴权。
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getCredentialKey } from './storage';

/** 入口凭证 Cookie 名 */
const COOKIE_NAME = 'dm_entrance';
/** Cookie 有效期（秒）：30 天，期间无需重访入口路径 */
const COOKIE_MAX_AGE = 30 * 24 * 3600;

/** 豁免前缀：自带鉴权（token）或监控存活探测依赖，保持可达 */
const EXEMPT_PREFIXES = ['/api/health', '/metrics', '/api/webhook', '/api/mcp', '/api/edge'];

/**
 * 规范化入口路径：确保以 / 开头、去多余尾部斜杠
 */
function normalizeEntrance(raw: string): string {
  let p = raw.trim();
  if (!p.startsWith('/')) p = '/' + p;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * 由服务器密钥派生入口 Cookie 值（HMAC）。
 * 密钥来自数据目录 .cred-secret（与敏感字段加密同源），重启后值稳定，
 * 已登录浏览器无需在服务重启后重新访问入口路径。
 */
function cookieValueOf(entrance: string): string {
  return crypto.createHmac('sha256', getCredentialKey()).update('entrance:' + entrance).digest('hex');
}

/** 常数时间字符串比较，防时序侧信道 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 解析 Cookie 头中的指定项（零依赖） */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * 创建安全入口中间件。
 * @param rawPath 入口路径（测试注入用）；缺省读取 process.env.ENTRANCE_PATH，
 *                为空时返回直通中间件（功能关闭）。
 */
export function entranceGate(rawPath?: string) {
  const raw = (rawPath ?? process.env.ENTRANCE_PATH ?? '').trim();
  if (!raw) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  const entrance = normalizeEntrance(raw);
  if (entrance.length < 8) {
    console.warn(`[安全入口] ENTRANCE_PATH 过短（${entrance.length} 字符），建议 ≥ 12 字符以提高隐蔽性`);
  }
  const expected = cookieValueOf(entrance);
  console.log(`[安全入口] 已启用，面板仅可通过 ${entrance} 访问，其余请求一律 404`);

  return (req: Request, res: Response, next: NextFunction) => {
    const pathname = req.path;
    // 机器入口豁免（前缀匹配 + 精确路径，避免 /api/healthX 之类误命中）
    if (EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return next();
    // 秘密路径本身：签发凭证 Cookie 后重写为根路径，交由静态托管 / SPA 回退处理
    if ((pathname === entrance || pathname === entrance + '/') && req.method === 'GET') {
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${expected}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
      );
      req.url = '/';
      return next();
    }
    // 已持有效凭证放行
    const got = readCookie(req.headers.cookie, COOKIE_NAME);
    if (got && timingSafeEqualStr(got, expected)) return next();
    // 其余一律 404（与真实 404 无差别，不泄露面板存在性）
    res.status(404).send('Not Found');
  };
}
