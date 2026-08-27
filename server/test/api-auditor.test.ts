/**
 * 只读审计角色（auditor）API 集成测试
 *
 * 覆盖：
 *  1. 管理员创建审计员账号
 *  2. 审计员可读取（GET）
 *  3. 审计员写操作被拒绝（403）
 *  4. /api/auth/me 返回 auditor 角色
 *  5. 清理测试账号
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let auditorToken = '';
const AUDIT_USER = 'audit-test-user';

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

before(async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  adminToken = login.data.token;
  // 清理历史残留（幂等）
  await req('DELETE', `/api/system/users/${AUDIT_USER}`, undefined, { Authorization: `Bearer ${adminToken}` });
  // 创建审计员并登录
  await req('POST', '/api/system/users', { username: AUDIT_USER, password: 'audit-pass-123', role: 'auditor' }, { Authorization: `Bearer ${adminToken}` });
  const auditLogin = await req('POST', '/api/auth/login', { username: AUDIT_USER, password: 'audit-pass-123' });
  auditorToken = auditLogin.data.token;
});

after(async () => {
  await req('DELETE', `/api/system/users/${AUDIT_USER}`, undefined, { Authorization: `Bearer ${adminToken}` });
});

test('管理员可创建 auditor 角色账号并登录', async () => {
  assert.ok(auditorToken, '审计员应能成功登录');
});

test('GET /api/auth/me: 审计员角色被正确返回', async () => {
  const res = await req('GET', '/api/auth/me', undefined, { Authorization: `Bearer ${auditorToken}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.role, 'auditor');
});

test('审计员可以读取（GET /api/overview）', async () => {
  const res = await req('GET', '/api/overview', undefined, { Authorization: `Bearer ${auditorToken}` });
  assert.strictEqual(res.status, 200);
});

test('审计员写操作被拒绝（POST 返回 403）', async () => {
  const res = await req('POST', '/api/system/users', { username: 'x-audit', password: '123456' }, { Authorization: `Bearer ${auditorToken}` });
  assert.strictEqual(res.status, 403);
});

test('审计员更新设置被拒绝（PUT 返回 403）', async () => {
  const res = await req('PUT', '/api/settings/logs.defaultTail', { value: 500 }, { Authorization: `Bearer ${auditorToken}` });
  assert.strictEqual(res.status, 403);
});

test('审计员删除操作被拒绝（DELETE 返回 403）', async () => {
  const res = await req('DELETE', '/api/system/users/admin', undefined, { Authorization: `Bearer ${auditorToken}` });
  assert.strictEqual(res.status, 403);
});
