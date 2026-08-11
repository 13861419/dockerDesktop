/**
 * 前端 API 请求封装
 *
 * 统一处理 fetch 请求、JSON 序列化与错误抛出，供各页面调用后端接口。
 * 若本地存在登录 token，会自动携带 Authorization: Bearer <token> 请求头。
 */
import { getToken } from './auth';

/** 请求报错时的错误对象 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

/**
 * 轻量 fetch 封装，自动处理 JSON、错误与超时
 * @param url 接口路径（以 /api 开头）
 * @param options fetch 配置
 */
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // 构建请求头：默认 JSON 类型，合并业务自定义 headers，再注入鉴权 token
    const headers = new Headers(options?.headers);
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const token = getToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    res = await fetch(url, {
      headers,
      ...options,
    });
  } catch {
    throw new ApiError(0, '无法连接后端服务，请确认服务已启动');
  }

  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message = data?.error || data?.message || `请求失败 (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

/** GET 请求 */
export const get = <T = any>(url: string, params?: Record<string, any>) => {
  const qs = params
    ? '?' +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  return request<T>(url + qs);
};

/** POST 请求 */
export const post = <T = any>(url: string, body?: any) =>
  request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/** DELETE 请求 */
export const del = <T = any>(url: string, params?: Record<string, any>) => {
  const qs = params
    ? '?' +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  return request<T>(url + qs, { method: 'DELETE' });
};

/**
 * 带鉴权的文件下载：请求返回 Blob 后触发浏览器另存为下载
 * @param url 接口路径（以 /api 开头，可含 query）
 * @param fallbackName 无法从响应头解析文件名时使用的默认文件名
 */
export const download = async (url: string, fallbackName = 'download.csv') => {
  const headers = new Headers();
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new ApiError(0, '无法连接后端服务，请确认服务已启动');
  }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const data = await res.json();
      msg = data?.error || msg;
    } catch {
      // 非 JSON 响应，保留默认错误信息
    }
    throw new ApiError(res.status, msg);
  }
  const blob = await res.blob();
  // 尝试从 Content-Disposition 响应头解析服务器指定的文件名
  const cd = res.headers.get('Content-Disposition');
  let name = fallbackName;
  const m = cd ? cd.match(/filename="?([^";]+)"?/) : null;
  if (m?.[1]) name = m[1];
  // 创建临时 <a> 触发浏览器下载
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
};
