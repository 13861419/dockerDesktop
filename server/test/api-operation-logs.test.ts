/**
 * 操作审计日志 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/operation-logs：分页查询
 *  2. GET /api/operation-logs/stats：统计汇总
 *  3. GET /api/operation-logs/stats/by-user：按用户统计
 *  4. GET /api/operation-logs/export?format=csv：CSV 导出
 *  5. GET /api/operation-logs/export?format=json：JSON 导出
 *  6. 过滤参数：username、targetType、success
 *  7. 未登录 / 非管理员访问控制
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<{ status: number; data: any; headers: any }> {
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
        resolve({ status: res.statusCode || 0, data: parsed, headers: res.headers });
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
});

test('GET /api/operation-logs: 返回分页结果', async () => {
  const res = await req('GET', '/api/operation-logs?page=1&pageSize=10', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.data.total === 'number');
  assert.ok(Array.isArray(res.data.items));
  assert.ok(res.data.items.length <= 10);
});

test('GET /api/operation-logs: 过滤 username', async () => {
  const res = await req('GET', '/api/operation-logs?username=admin', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  for (const item of res.data.items) {
    assert.strictEqual(item.username, 'admin');
  }
});

test('GET /api/operation-logs: 过滤 targetType', async () => {
  const res = await req('GET', '/api/operation-logs?targetType=container', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  for (const item of res.data.items) {
    assert.strictEqual(item.targetType, 'container');
  }
});

test('GET /api/operation-logs/stats: 返回统计结构', async () => {
  const res = await req('GET', '/api/operation-logs/stats', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.data === 'object');
});

test('GET /api/operation-logs/stats/by-user: 按用户统计', async () => {
  const res = await req('GET', '/api/operation-logs/stats/by-user', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data));
});

test('GET /api/operation-logs/export?format=csv: 返回 CSV', async () => {
  const res = await req('GET', '/api/operation-logs/export?format=csv', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers['content-type']?.includes('text/csv'));
  assert.ok(typeof res.data === 'string');
  // CSV 应有逗号分隔
  assert.ok(res.data.includes(','), 'CSV 应包含逗号分隔符');
});

test('GET /api/operation-logs/export?format=json: 返回 JSON', async () => {
  const res = await req('GET', '/api/operation-logs/export?format=json', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers['content-type']?.includes('application/json'));
  // res.data 可能是字符串或已解析对象
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  assert.ok(Array.isArray(data));
});

test('GET /api/operation-logs: 未登录返回 401', async () => {
  const res = await req('GET', '/api/operation-logs');
  assert.strictEqual(res.status, 401);
});

test('GET /api/operation-logs/stats: 未登录返回 401', async () => {
  const res = await req('GET', '/api/operation-logs/stats');
  assert.strictEqual(res.status, 401);
});

test('GET /api/operation-logs/export: 未登录返回 401', async () => {
  const res = await req('GET', '/api/operation-logs/export');
  assert.strictEqual(res.status, 401);
});
