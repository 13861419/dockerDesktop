/**
 * 用户存储模块（SQLite 持久化）
 *
 * 用户账号与加盐密码哈希存储在 SQLite 的 users 表中，替代原有 JSON 文件存储。
 * 首次运行时若表中无任何用户，则用环境变量 ADMIN_USER / ADMIN_PASS（缺省 admin / admin888）创建初始管理员。
 */
import crypto from 'crypto';
import { getDb } from './storage';

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
export function listUsers(): Array<{ username: string; role: UserRecord['role']; createdAt: number }> {
  const rows = getDb()
    .prepare('SELECT username, role, created_at FROM users')
    .all() as unknown as Array<{ username: string; role: string; created_at: number }>;
  if (rows.length === 0) {
    // 空表时先触发默认管理员初始化，再重新查询
    loadUsers();
    return getDb()
      .prepare('SELECT username, role, created_at FROM users')
      .all()
      .map((r: any) => ({ username: r.username, role: r.role, createdAt: r.created_at }));
  }
  return rows.map((r) => ({ username: r.username, role: (r.role as UserRecord['role']) || 'user', createdAt: r.created_at }));
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
  if (password.length < 6) throw new Error('密码至少 6 位');
  if (userExists(name)) throw new Error('用户名已存在');
  const salt = crypto.randomBytes(16).toString('hex');
  getDb()
    .prepare('INSERT INTO users (username, salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, salt, hashPassword(password, salt), role, Date.now());
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
  if (newPassword.length < 6) throw new Error('新密码至少 6 位');
  const newSalt = crypto.randomBytes(16).toString('hex');
  // 修改密码成功后清除强制改密标记
  d.prepare(
    'UPDATE users SET salt = ?, password_hash = ?, must_change_password = 0 WHERE username = ?',
  ).run(newSalt, hashPassword(newPassword, newSalt), username);
}

/**
 * 重置缓存（SQLite 无内存缓存，保留空实现以兼容旧调用方）
 */
export function resetCache(): void {
  // no-op：SQLite 直接读写，无需清缓存
}
