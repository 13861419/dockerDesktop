/**
 * 登录凭证（token）管理模块
 *
 * 负责 token 在 localStorage 中的统一读写，供登录页写入、请求封装注入、路由守卫与退出登录使用。
 */

/** token 在 localStorage 中使用的存储 key */
const TOKEN_KEY = 'docker_manager_token';

/** 用户角色在 localStorage 中使用的存储 key */
const ROLE_KEY = 'docker_manager_role';

/** 前端识别的用户角色 */
export type UserRole = 'admin' | 'operator' | 'user' | 'auditor';

/**
 * 读取本地存储的 token
 * @returns 当前 token，若未登录则为 null
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * 写入 token 到本地存储
 * @param token 登录接口返回的 token
 */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * 读取本地存储的用户角色
 * @returns 当前用户角色，未缓存时按普通用户处理
 */
export function getRole(): UserRole {
  const role = localStorage.getItem(ROLE_KEY);
  // 支持 admin / operator / auditor / user 四种角色的还原
  if (role === 'admin' || role === 'operator' || role === 'auditor') return role;
  return 'user';
}

/**
 * 写入用户角色到本地存储
 * @param role 登录接口或会话校验接口返回的用户角色
 */
export function setRole(role: UserRole): void {
  localStorage.setItem(ROLE_KEY, role);
}

/**
 * 判断当前本地缓存用户是否为管理员
 * @returns true 表示当前用户是 admin 角色
 */
export function isAdmin(): boolean {
  return getRole() === 'admin';
}

/**
 * 判断当前用户是否具备「运维操作」权限（admin 或 operator）
 * 用于控制容器等资源的创建 / 删除 / 重命名等生命周期管理能力。
 * @returns true 表示当前用户是 admin 或 operator
 */
export function canOperate(): boolean {
  const r = getRole();
  return r === 'admin' || r === 'operator';
}

/**
 * 清除本地存储的 token（退出登录时调用）
 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
}
