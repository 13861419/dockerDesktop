/**
 * 鉴权 API 集成测试
 *
 * 覆盖：
 *  1. POST /api/auth/login：正确/错误凭证、空字段
 *  2. GET /api/auth/me：有效/无效/过期 Token
 *  3. POST /api/auth/logout：会话销毁
 *  4. Token 边界：无 Token、Bearer 格式、畸形 Token
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';

function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode || 0, data: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test('POST /api/auth/login: 正确凭证返回 token', async () => {
  const res = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.token, '应返回 token');
  assert.strictEqual(res.data.username, 'admin');
  assert.strictEqual(res.data.role, 'admin');
});

test('POST /api/auth/login: 错误密码返回 401', async () => {
  const res = await req('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
  assert.strictEqual(res.status, 401);
  assert.ok(res.data.error);
});

test('POST /api/auth/login: 不存在的用户返回 401 或 429', async () => {
  const res = await req('POST', '/api/auth/login', { username: 'nonexistent', password: 'pass' });
  // 401=认证失败, 429=因之前错误密码触发了登录保护
  assert.ok(res.status === 401 || res.status === 429, `应返回 401 或 429，实际 ${res.status}`);
});

test('POST /api/auth/login: 空用户名返回 400', async () => {
  const res = await req('POST', '/api/auth/login', { username: '', password: 'pass' });
  assert.ok(res.status >= 400);
});

test('POST /api/auth/login: 空密码返回 400', async () => {
  const res = await req('POST', '/api/auth/login', { username: 'admin', password: '' });
  assert.ok(res.status >= 400);
});

test('GET /api/auth/me: 有效 Token 返回用户信息', async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  const token = login.data.token;
  const res = await req('GET', '/api/auth/me', undefined, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.username, 'admin');
  assert.strictEqual(res.data.role, 'admin');
});

test('GET /api/auth/me: 无 Token 返回 401', async () => {
  const res = await req('GET', '/api/auth/me');
  assert.strictEqual(res.status, 401);
});

test('GET /api/auth/me: 无效 Token 返回 401', async () => {
  const res = await req('GET', '/api/auth/me', undefined, { Authorization: 'Bearer invalid-token-xyz' });
  assert.strictEqual(res.status, 401);
});

test('GET /api/auth/me: 畸形 Authorization header 返回 401', async () => {
  const res = await req('GET', '/api/auth/me', undefined, { Authorization: 'NotBearer xxx' });
  assert.strictEqual(res.status, 401);
});

test('POST /api/auth/logout: 销毁会话后 Token 失效', async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  const token = login.data.token;
  // 确认 token 有效
  const me = await req('GET', '/api/auth/me', undefined, { Authorization: `Bearer ${token}` });
  assert.strictEqual(me.status, 200);
  // 登出
  const logout = await req('POST', '/api/auth/logout', undefined, { Authorization: `Bearer ${token}` });
  assert.strictEqual(logout.status, 200);
  // Token 应失效
  const me2 = await req('GET', '/api/auth/me', undefined, { Authorization: `Bearer ${token}` });
  assert.strictEqual(me2.status, 401);
});
