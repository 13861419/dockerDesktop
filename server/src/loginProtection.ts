/**
 * 登录失败保护：连续失败 N 次后锁定该账号一段时间，防止暴力破解。
 *
 * 双维度：
 *  - 用户名维度：失败计数与锁定时间**持久化到 users 表**（failed_attempts / locked_until），
 *    面板重启后锁定状态不丢（1.43.0）；不存在的用户名仅走内存/IP 维度。
 *  - IP 维度（1.43.0）：滑动窗口（默认 10 分钟）内同一 IP 失败 20 次锁定 5 分钟，
 *    防止换用户名绕过；阈值高于用户维度以兼容 NAT 多用户场景。
 *    IP 计数保留在内存（重启清零，作为轻量补充层）。
 *
 * 阈值 / 锁定时间可通过环境变量覆盖：
 *  - LOGIN_MAX_ATTEMPTS   连续失败最大次数（默认 5）
 *  - LOGIN_LOCK_MINUTES   达到阈值后的锁定分钟数（默认 10）
 *  - LOGIN_IP_MAX_ATTEMPTS  IP 维度失败阈值（默认 20）
 *  - LOGIN_IP_LOCK_MINUTES  IP 维度锁定分钟数（默认 5）
 *  - LOGIN_IP_WINDOW_MS     IP 维度滑动窗口毫秒数（默认 600000）
 */
import { getDb } from './storage';

/** 连续失败最大次数 */
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
/** 锁定分钟数 */
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 10);
/** 锁定毫秒数 */
const LOCK_MS = LOCK_MINUTES * 60 * 1000;

/** IP 维度阈值（同一 IP 滑动窗口内失败次数，默认 20，兼容 NAT 多用户场景） */
const IP_MAX_FAILURES = Number(process.env.LOGIN_IP_MAX_ATTEMPTS || 20);
/** IP 维度锁定分钟数（默认 5） */
const IP_LOCK_MINUTES = Number(process.env.LOGIN_IP_LOCK_MINUTES || 5);
/** IP 维度滑动窗口毫秒数（默认 10 分钟） */
const IP_WINDOW_MS = Number(process.env.LOGIN_IP_WINDOW_MS || 10 * 60 * 1000);
const IP_LOCK_MS = IP_LOCK_MINUTES * 60 * 1000;

interface LoginRecord {
  failures: number;
  lockedUntil: number;
  /** IP 维度滑动窗口起始时间 */
  firstAt?: number;
}

/** 用户名维度的内存记录（与 DB 持久层并行，覆盖不存在的用户名） */
const records = new Map<string, LoginRecord>();
/** IP 维度的内存记录（key = IP） */
const ipRecords = new Map<string, LoginRecord>();

/** 定时清理过期记录，避免内存膨胀 */
setInterval(() => {
  const now = Date.now();
  for (const m of [records, ipRecords]) {
    for (const [key, r] of m) {
      // 锁定期已过的记录整体删除，便于重新计数
      if (r.lockedUntil > 0 && r.lockedUntil <= now) {
        m.delete(key);
      }
    }
  }
}, 10 * 60 * 1000).unref?.();

/** 读取 users 表中该账号的持久化失败计数与锁定截止时间 */
function persistedRecord(username: string): LoginRecord {
  try {
    const row = getDb()
      .prepare('SELECT failed_attempts, locked_until FROM users WHERE username = ?')
      .get(username) as { failed_attempts: number; locked_until: number | null } | undefined;
    return {
      failures: row?.failed_attempts || 0,
      lockedUntil: row?.locked_until || 0,
    };
  } catch {
    return { failures: 0, lockedUntil: 0 };
  }
}

/** 计算某条记录当前剩余锁定秒数（未锁定返回 0） */
function remainingOf(r: LoginRecord): number {
  if (r.lockedUntil > 0) {
    const remain = Math.ceil((r.lockedUntil - Date.now()) / 1000);
    if (remain > 0) return remain;
  }
  return 0;
}

/**
 * 该账号当前是否处于锁定状态（持久化 + 内存记录任一命中即锁定）
 * @param username 用户名
 */
export function isLocked(username: string): boolean {
  return getLockRemaining(username) > 0;
}

/**
 * 获取剩余锁定秒数（未锁定返回 0）
 * @param username 用户名
 */
export function getLockRemaining(username: string): number {
  const now = Date.now();
  // 内存记录
  const mem = records.get(username);
  if (mem?.lockedUntil && mem.lockedUntil > now) {
    return Math.ceil((mem.lockedUntil - now) / 1000);
  }
  // 持久化记录（重启后仍生效）
  const persistedRemaining = remainingOf(persistedRecord(username));
  if (persistedRemaining > 0) return persistedRemaining;
  return 0;
}

/**
 * 记录一次登录失败（用户名维度）。若已达到阈值则触发锁定（内存 + 持久化双写）。
 * @param username 用户名
 * @param exists 该用户名是否存在（不存在的用户仅记录内存，无法落库）
 */
export function registerFailure(username: string, exists: boolean): void {
  const now = Date.now();
  let r = records.get(username);
  // 若锁定期已过，重置为全新记录
  if (!r || (r.lockedUntil > 0 && r.lockedUntil <= now)) {
    r = { failures: 0, lockedUntil: 0 };
    records.set(username, r);
  }
  r.failures += 1;
  if (r.failures >= MAX_ATTEMPTS && r.lockedUntil === 0) {
    r.lockedUntil = now + LOCK_MS;
  }
  if (!exists) return;
  try {
    const p = persistedRecord(username);
    // 锁定期已过则从零计数
    const base = p.lockedUntil > 0 && p.lockedUntil <= now ? 0 : p.failures;
    const failures = base + 1;
    const lockedUntil = failures >= MAX_ATTEMPTS && !(p.lockedUntil > now) ? now + LOCK_MS : p.lockedUntil > now ? p.lockedUntil : null;
    getDb()
      .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE username = ?')
      .run(failures, lockedUntil, username);
  } catch {
    // 持久化失败退化为纯内存计数
  }
}

/**
 * 记录一次登录失败（IP 维度，内存计数）。滑动窗口内失败达到阈值后锁定该 IP。
 * @param ip 客户端 IP
 */
export function registerIpFailure(ip: string): void {
  if (!ip) return;
  const now = Date.now();
  let r = ipRecords.get(ip);
  if (!r || (r.lockedUntil > 0 && r.lockedUntil <= now)) {
    r = { failures: 0, lockedUntil: 0 };
    ipRecords.set(ip, r);
  }
  // 固定窗口：窗口过期后从零计数
  if (r.firstAt && now - r.firstAt > IP_WINDOW_MS) {
    r.failures = 0;
    r.firstAt = 0;
  }
  if (!r.firstAt) r.firstAt = now;
  r.failures += 1;
  if (r.failures >= IP_MAX_FAILURES && r.lockedUntil === 0) {
    r.lockedUntil = now + IP_LOCK_MS;
  }
}

/**
 * 该 IP 当前是否处于锁定状态（连续失败达到阈值）
 * @param ip 客户端 IP
 */
export function isIpLocked(ip: string): boolean {
  return getIpLockRemaining(ip) > 0;
}

/**
 * 获取 IP 维度剩余锁定秒数（未锁定返回 0）
 * @param ip 客户端 IP
 */
export function getIpLockRemaining(ip: string): number {
  const r = ipRecords.get(ip);
  if (!r) return 0;
  return remainingOf(r);
}

/**
 * 登录成功后清除该账号与来源 IP 的失败记录
 * @param username 用户名
 * @param ip 来源 IP（可选，同时清除 IP 维度计数）
 */
export function resetFailures(username: string, ip?: string): void {
  records.delete(username);
  if (ip) ipRecords.delete(ip);
  try {
    getDb()
      .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = ?')
      .run(username);
  } catch {
    // 清理失败不影响登录主流程
  }
}

/** 导出配置（供调试/展示） */
export function getLoginPolicy(): { maxAttempts: number; lockMinutes: number } {
  return { maxAttempts: MAX_ATTEMPTS, lockMinutes: LOCK_MINUTES };
}
