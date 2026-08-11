/**
 * 登录凭证（token）管理模块
 *
 * 负责 token 在 localStorage 中的统一读写，供登录页写入、请求封装注入、路由守卫与退出登录使用。
 */

/** token 在 localStorage 中使用的存储 key */
const TOKEN_KEY = 'docker_manager_token';

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
 * 清除本地存储的 token（退出登录时调用）
 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
