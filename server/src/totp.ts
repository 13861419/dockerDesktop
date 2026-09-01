/**
 * TOTP 双因素认证模块（RFC 6238，零第三方依赖）
 *
 * - 密钥为 20 随机字节，Base32（RFC 4648 无填充）编码后供认证器 App 手动录入
 * - 算法 HMAC-SHA1，6 位数字，时间步长 30 秒，默认允许 ±1 步时钟漂移
 */
import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 生成随机 TOTP 密钥（Base32 编码，20 字节熵）
 */
export function generateSecret(): string {
  const buf = crypto.randomBytes(20);
  return base32Encode(buf);
}

/** Base32 编码（RFC 4648，无填充） */
function base32Encode(buf: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Base32 解码（大写化、去空格与填充；非法字符抛错）
 */
export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('非法的 Base32 字符');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * 计算指定时间步的 TOTP 码（HMAC-SHA1，动态截断，6 位）
 * @param secret Base32 密钥
 * @param counter 时间步计数（Unix 秒 / 30）
 */
export function totpAt(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0x7f) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * 校验 TOTP 验证码（允许 ±window 步时钟漂移，默认 ±1）
 * @param secret Base32 密钥
 * @param code 用户输入的 6 位验证码
 * @param window 容忍的时间步偏移
 * @param nowMs 当前时间（毫秒，测试注入用）
 */
export function verifyTotp(secret: string, code: string, window = 1, nowMs = Date.now()): boolean {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(nowMs / 1000 / 30);
  for (let drift = -window; drift <= window; drift++) {
    if (totpAt(secret, counter + drift) === clean) return true;
  }
  return false;
}

/**
 * 生成 otpauth:// URI（认证器 App 扫码或手动录入用）
 */
export function otpauthUri(username: string, secret: string, issuer = 'Docker Manager'): string {
  const label = encodeURIComponent(`DockerManager:${username}`);
  const params = new URLSearchParams({ secret, issuer: 'DockerManager', algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
