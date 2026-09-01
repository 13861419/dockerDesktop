/**
 * 安全策略模块：IP 白名单（全局 + 按用户 CIDR）与密码策略
 *
 * - IP 白名单：按用户列表优先，其次全局列表，均为 CIDR（IPv4）或精确 IP（含 IPv6 精确串）；空列表视为不限制
 * - 密码策略：最小长度与复杂度（须含大写 / 小写 / 数字），从 settings 读取（0/关闭 = 不限制）
 */
import { getSetting } from './settings';

/**
 * 从请求中提取客户端 IP（x-forwarded-for 首段优先，回退 req.ip / socket；剥离 IPv6 映射前缀）
 */
export function requestIp(req: { headers: Record<string, any>; ip?: string; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/** 用户安全信息（来自 users 表安全列） */
export interface UserSecurity {
  ipAllowlist: string;
}

/**
 * 判断单个 IP 是否命中 CIDR（IPv4）或精确相等
 * @param ip 请求 IP（支持 x-forwarded-for 已剥离端口的裸 IP）
 * @param cidr '192.168.1.10' | '192.168.1.0/24'；IPv6 仅支持精确相等
 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const ipTrim = (ip || '').trim();
  const cidrTrim = (cidr || '').trim();
  if (!ipTrim || !cidrTrim) return false;
  if (ipTrim === cidrTrim) return true;
  if (cidrTrim.includes(':')) return false; // IPv6 仅支持精确相等
  const [base, prefixRaw] = cidrTrim.split('/');
  const prefix = Number(prefixRaw ?? 32);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const toInt = (v: string): number | null => {
    const parts = v.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const p of parts) {
      const n = Number(p);
      if (!/^\d+$/.test(p) || n > 255) return null;
      out = out * 256 + n;
    }
    return out;
  };
  const ipInt = toInt(ipTrim);
  const baseInt = toInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/**
 * 解析 CSV/CRLF 白名单字符串为非空条目数组
 */
export function parseAllowlist(raw: string | undefined | null): string[] {
  return String(raw || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 判断请求 IP 是否通过白名单：
 * - 用户级白名单非空时以其为准（不再叠加全局）
 * - 用户级为空时使用全局白名单（为空 = 不限制）
 */
export function isIpAllowed(ip: string, userAllowlist?: string): boolean {
  const user = parseAllowlist(userAllowlist);
  if (user.length > 0) return user.some((c) => ipMatchesCidr(ip, c));
  const global = parseAllowlist(getSetting<string>('security.ipAllowlist'));
  if (global.length === 0) return true;
  return global.some((c) => ipMatchesCidr(ip, c));
}

/**
 * 校验密码是否符合策略（settings：security.passwordMinLength / security.passwordRequireComplex）
 * @throws 不符合时抛带提示的错误
 */
export function validatePasswordPolicy(password: string): void {
  const minLength = Number(getSetting<number>('security.passwordMinLength') ?? 6);
  if (password.length < minLength) {
    throw new Error(`密码长度不能少于 ${minLength} 位`);
  }
  const requireComplex = getSetting<boolean>('security.passwordRequireComplex') === true;
  if (requireComplex) {
    const ok = /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
    if (!ok) throw new Error('密码需同时包含大写字母、小写字母与数字');
  }
}

/**
 * 判断密码是否已过期
 * @param pwdChangedAt 最后一次密码修改时间（毫秒，null = 从未记录，视为不过期以兼容存量账号）
 */
export function isPasswordExpired(pwdChangedAt: number | null | undefined): boolean {
  const days = Number(getSetting<number>('security.passwordExpiryDays') ?? 0);
  if (!days || days <= 0) return false;
  if (!pwdChangedAt) return false; // 存量账号未记录时间，不强制过期
  return Date.now() - pwdChangedAt > days * 86400_000;
}
