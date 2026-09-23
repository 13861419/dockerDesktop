/**
 * Playwright 全局前置（1.89.0 起需要）：
 * 全新安装首次登录会被重定向到 /onboarding 首装向导（1.88.0），而冒烟用例
 * 默认断言「登录后进入总览」。这里经 API 将 onboarding.done 置 true，
 * 把 e2e 语义对齐为「跳过向导直接进面板」；已完成向导的库不做任何改动。
 * 登录失败（如使用自定义密码的既有环境）只警告不阻塞，交给用例自身暴露。
 *
 * 可用环境变量覆盖：E2E_API_URL（默认 http://localhost:9528）、E2E_USER、E2E_PASSWORD。
 */
import http from 'http';

const API = process.env.E2E_API_URL || 'http://localhost:9528';
const USER = process.env.E2E_USER || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'admin888';

/** 最小 HTTP 封装（Node 原生，零依赖） */
function req(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      new URL(path, API),
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data: any = null;
          try { data = JSON.parse(raw); } catch { /* 非 JSON 响应原样保留 */ }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

export default async function globalSetup(): Promise<void> {
  try {
    const login = await req('POST', '/api/auth/login', { username: USER, password: PASSWORD });
    const token = login.data?.token || login.data?.data?.token;
    if (!token) {
      console.warn(`[e2e globalSetup] 登录失败（${login.status}），跳过 onboarding 预置`);
      return;
    }
    const flag = await req('GET', '/api/settings/onboarding.done', undefined, token);
    if (flag.data?.value === true) return; // 向导已完成，无需预置
    const put = await req('PUT', '/api/settings/onboarding.done', { value: true }, token);
    console.log(`[e2e globalSetup] onboarding.done → true（${put.status}）`);
  } catch (e) {
    console.warn('[e2e globalSetup] 预置失败（不阻塞）:', (e as Error).message);
  }
}
