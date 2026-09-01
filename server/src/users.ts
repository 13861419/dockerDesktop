/**
 * 用户存储模块（SQLite 持久化）
 *
 * 用户账号与加盐密码哈希存储在 SQLite 的 users 表中，替代原有 JSON 文件存储。
 * 首次运行时若表中无任何用户，则用环境变量 ADMIN_USER / ADMIN_PASS（缺省 admin / admin888）创建初始管理员。
 */
import crypto from 'crypto';
import { getDb } from './storage';
import { validatePasswordPolicy } from './security';
import { encryptSecret, decryptSecret } from './storage';

export interface UserRecord {
  username: string;
  salt: string;
  passwordHash: string;
  /** 角色名：内置 admin/operator/user/auditor 或自定义角色（roles 表） */
  role: string;
  createdAt: number;
}

/** 默认初始管理员账号（从环境变量读取） */
const DEFAULT_USER = process.env.ADMIN_USER || 'admin';
const DEFAULT_PASS = process.env.ADMIN_PASS || 'admin888';

/** 行结构（与表字段对应，snake_case 由 SQL 读取） */
interface UserRow {
  username: string;
  salt: string;
  password_hash: string;
  role: string;
  created_at: number;
  must_change_password?: number;
}

/**
 * 生成加盐密码哈希
 * @param password 明文密码
 * @param salt 盐值
 */
function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

/**
 * 读取 users 表并返回全部用户
 * @returns 用户记录数组
 */
function loadUsers(): UserRecord[] {
  const d = getDb();
  const rows = d
    .prepare('SELECT username, salt, password_hash, role, created_at FROM users')
    .all() as unknown as UserRow[];
  // 若表为空，则创建默认管理员（等价于原 JSON 方案首启初始化）
  if (rows.length === 0) {
    const salt = crypto.randomBytes(16).toString('hex');
    const createdAt = Date.now();
    d.prepare(
      'INSERT INTO users (username, salt, password_hash, role, created_at, must_change_password) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      DEFAULT_USER,
      salt,
      hashPassword(DEFAULT_PASS, salt),
      'admin',
      createdAt,
      1,
    );
    return [
      { username: DEFAULT_USER, salt, passwordHash: hashPassword(DEFAULT_PASS, salt), role: 'admin', createdAt },
    ];
  }
  return rows.map((r) => ({
    username: r.username,
    salt: r.salt,
    passwordHash: r.password_hash,
    role: (r.role as UserRecord['role']) || 'user',
    createdAt: r.created_at,
  }));
}

/**
 * 确保默认管理员存在（幂等）：
 * 显式触发 loadUsers()，当 users 表为空时按 ADMIN_USER / ADMIN_PASS（缺省 admin / admin888）创建初始管理员。
 * 供服务启动时调用，保证全新环境首次部署即可用默认账号登录（修复首次登录死锁 BUG）。
 */
export function ensureInitialUser(): void {
  loadUsers();
}

/**
 * 校验用户名密码
 * @param username 用户名
 * @param password 明文密码
 * @returns 校验结果；ok 为是否通过，mustChangePassword 标识是否需要强制改密
 */
export function verifyCredentials(
  username: string,
  password: string,
): { ok: boolean; mustChangePassword: boolean } {
  const d = getDb();
  const row = d
    .prepare('SELECT salt, password_hash, must_change_password FROM users WHERE username = ?')
    .get(username) as
    | { salt: string; password_hash: string; must_change_password: number | null }
    | undefined;
  if (!row) return { ok: false, mustChangePassword: false };
  const hash = hashPassword(password, row.salt);
  if (hash !== row.password_hash) return { ok: false, mustChangePassword: false };
  return { ok: true, mustChangePassword: !!row.must_change_password };
}

/**
 * 列出全部用户（不含敏感哈希）
 */
export function listUsers(): Array<{ username: string; role: UserRecord['role']; createdAt: number; ipAllowlist: string }> {
  const rows = getDb()
    .prepare('SELECT username, role, created_at, ip_allowlist FROM users')
    .all() as unknown as Array<{ username: string; role: string; created_at: number; ip_allowlist: string | null }>;
  if (rows.length === 0) {
    // 空表时先触发默认管理员初始化，再重新查询
    loadUsers();
    return getDb()
      .prepare('SELECT username, role, created_at, ip_allowlist FROM users')
      .all()
      .map((r: any) => ({ username: r.username, role: r.role, createdAt: r.created_at, ipAllowlist: String(r.ip_allowlist || '') }));
  }
  return rows.map((r) => ({ username: r.username, role: (r.role as UserRecord['role']) || 'user', createdAt: r.created_at, ipAllowlist: String(r.ip_allowlist || '') }));
}

/**
 * 判断用户名是否已存在
 * @param username 用户名
 */
export function userExists(username: string): boolean {
  const row = getDb().prepare('SELECT 1 AS x FROM users WHERE username = ?').get(username);
  return !!row;
}

/**
 * 获取用户角色
 * @param username 用户名
 * @returns 角色 'admin' | 'user'；用户不存在时视为普通用户（非管理员）
 */
export function getUserRole(username: string): UserRecord['role'] {
  const row = getDb()
    .prepare('SELECT role FROM users WHERE username = ?')
    .get(username) as { role: string } | undefined;
  return (row?.role as UserRecord['role']) || 'user';
}

/**
 * 新增用户
 * @param username 用户名
 * @param password 明文密码
 * @param role 角色
 * @throws 用户名已存在或非法时抛错
 */
export function addUser(username: string, password: string, role: UserRecord['role'] = 'user'): void {
  const name = username.trim();
  if (!name) throw new Error('用户名不能为空');
  validatePasswordPolicy(password);
  if (userExists(name)) throw new Error('用户名已存在');
  const salt = crypto.randomBytes(16).toString('hex');
  getDb()
    .prepare('INSERT INTO users (username, salt, password_hash, role, created_at, pwd_changed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, salt, hashPassword(password, salt), role, Date.now(), Date.now());
}

/**
 * 删除用户（不允许删除最后一个管理员）
 * @param username 用户名
 * @throws 目标不存在或无法删除时抛错
 */
export function deleteUser(username: string): void {
  const d = getDb();
  const row = d.prepare('SELECT role FROM users WHERE username = ?').get(username) as { role: string } | undefined;
  if (!row) throw new Error('用户不存在');
  const adminCount = (d.prepare("SELECT count(*) AS c FROM users WHERE role = 'admin'").get() as { c: number }).c;
  if (row.role === 'admin' && adminCount <= 1) throw new Error('不能删除最后一个管理员');
  d.prepare('DELETE FROM users WHERE username = ?').run(username);
}

/**
 * 修改密码
 * @param username 用户名
 * @param oldPassword 旧密码（必填，需校验，防止任意已登录用户篡改他人密码）
 * @param newPassword 新密码
 * @throws 校验失败或用户不存在时抛错
 */
export function changePassword(username: string, oldPassword: string, newPassword: string): void {
  const d = getDb();
  const current = d.prepare('SELECT salt, password_hash FROM users WHERE username = ?').get(username) as
    | { salt: string; password_hash: string }
    | undefined;
  if (!current) throw new Error('用户不存在');
  if (!oldPassword) throw new Error('请输入原密码');
  const ok = hashPassword(oldPassword, current.salt) === current.password_hash;
  if (!ok) throw new Error('原密码不正确');
  validatePasswordPolicy(newPassword);
  const newSalt = crypto.randomBytes(16).toString('hex');
  // 修改密码成功后清除强制改密标记并刷新密码修改时间（供密码过期策略使用）
  d.prepare(
    'UPDATE users SET salt = ?, password_hash = ?, must_change_password = 0, pwd_changed_at = ? WHERE username = ?',
  ).run(newSalt, hashPassword(newPassword, newSalt), Date.now(), username);
}

/**
 * 读取用户安全信息（2FA 启停、按用户 IP 白名单）
 */
export function getUserSecurity(username: string): {
  totpEnabled: boolean;
  totpSecret: string;
  ipAllowlist: string;
  pwdChangedAt: number | null;
} {
  const row = getDb()
    .prepare('SELECT totp_secret, totp_enabled, ip_allowlist, pwd_changed_at FROM users WHERE username = ?')
    .get(username) as
    | { totp_secret: string | null; totp_enabled: number | null; ip_allowlist: string | null; pwd_changed_at: number | null }
    | undefined;
  if (!row) throw new Error('用户不存在');
  let totpSecret = '';
  if (row.totp_secret) {
    try {
      totpSecret = row.totp_secret.startsWith('enc:') ? decryptSecret(row.totp_secret.slice(4)) : row.totp_secret;
    } catch {
      totpSecret = '';
    }
  }
  return {
    totpEnabled: !!row.totp_enabled,
    totpSecret,
    ipAllowlist: String(row.ip_allowlist || ''),
    pwdChangedAt: row.pwd_changed_at ?? null,
  };
}

/**
 * 设置 TOTP 密钥（传 null = 关闭 2FA；密钥以密文存储）
 */
export function setTotpSecret(username: string, secret: string | null): void {
  if (secret) {
    const enc = 'enc:' + encryptSecret(secret);
    getDb()
      .prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE username = ?')
      .run(enc, username);
  } else {
    getDb()
      .prepare("UPDATE users SET totp_secret = '', totp_enabled = 0 WHERE username = ?")
      .run(username);
  }
}

/**
 * 设置按用户 IP 白名单（空串 = 不限制，回退全局白名单）
 */
export function setIpAllowlist(username: string, allowlist: string): void {
  getDb()
    .prepare('UPDATE users SET ip_allowlist = ? WHERE username = ?')
    .run(String(allowlist || ''), username);
}

/**
 * 设置强制改密标记（密码过期策略触发时调用）
 */
export function setMustChangePassword(username: string, flag: boolean): void {
  getDb()
    .prepare('UPDATE users SET must_change_password = ? WHERE username = ?')
    .run(flag ? 1 : 0, username);
}

/**
 * 重置缓存（SQLite 无内存缓存，保留空实现以兼容旧调用方）
 */
export function resetCache(): void {
  // no-op：SQLite 直接读写，无需清缓存
}
