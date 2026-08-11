/**
 * 登录失败保护：连续失败 N 次后锁定该账号一段时间，防止暴力破解。
 *
 * 采用内存 Map（key = username），无需数据库。
 * 阈值 / 锁定时间可通过环境变量覆盖：
 *  - LOGIN_MAX_ATTEMPTS   连续失败最大次数（默认 5）
 *  - LOGIN_LOCK_MINUTES   达到阈值后的锁定分钟数（默认 10）
 */

/** 连续失败最大次数 */
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
/** 锁定分钟数 */
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 10);
/** 锁定毫秒数 */
const LOCK_MS = LOCK_MINUTES * 60 * 1000;

interface LoginRecord {
  failures: number;
  lockedUntil: number;
}

/** 登录失败记录 */
const records = new Map<string, LoginRecord>();

/** 定时清理过期记录，避免内存膨胀 */
setInterval(() => {
  const now = Date.now();
  for (const [key, r] of records) {
    // 锁定期已过的记录整体删除，便于重新计数
    if (r.lockedUntil > 0 && r.lockedUntil <= now) {
      records.delete(key);
    }
  }
}, 10 * 60 * 1000);

/**
 * 该 key（用户名）当前是否处于锁定状态
 * @param key 用户名
 */
export function isLocked(key: string): boolean {
  const r = records.get(key);
  if (!r) return false;
  if (r.lockedUntil > 0 && r.lockedUntil > Date.now()) return true;
  return false;
}

/**
 * 获取剩余锁定秒数（未锁定返回 0）
 * @param key 用户名
 */
export function getLockRemaining(key: string): number {
  const r = records.get(key);
  if (!r) return 0;
  if (r.lockedUntil > 0) {
    const remain = Math.ceil((r.lockedUntil - Date.now()) / 1000);
    if (remain > 0) return remain;
  }
  return 0;
}

/**
 * 记录一次登录失败。若已达到阈值则触发锁定。
 * @param key 用户名
 */
export function registerFailure(key: string): void {
  const now = Date.now();
  let r = records.get(key);
  // 若锁定期已过，重置为全新记录
  if (!r || (r.lockedUntil > 0 && r.lockedUntil <= now)) {
    r = { failures: 0, lockedUntil: 0 };
    records.set(key, r);
  }
  r.failures += 1;
  if (r.failures >= MAX_ATTEMPTS && r.lockedUntil === 0) {
    r.lockedUntil = now + LOCK_MS;
  }
}

/**
 * 登录成功后清除该账号的失败记录
 * @param key 用户名
 */
export function resetFailures(key: string): void {
  records.delete(key);
}

/** 导出配置（供调试/展示） */
export function getLoginPolicy(): { maxAttempts: number; lockMinutes: number } {
  return { maxAttempts: MAX_ATTEMPTS, lockMinutes: LOCK_MINUTES };
}
