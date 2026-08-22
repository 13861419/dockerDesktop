/**
 * 实时监控 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/monitor/now — 当前监控点
 *  2. GET /api/monitor/history — 历史监控点
 *  3. GET /api/monitor/history/range — 时间范围趋势
 *  4. 未登录返回 401
 *  5. 参数校验
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

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
});

// ---------- GET /api/monitor/now ----------

test('GET /api/monitor/now: 返回当前监控数据或 503', async () => {
  const res = await req('GET', '/api/monitor/now', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 503, `应返回 200 或 503，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data === 'object');
  } else {
    assert.ok(res.data.error);
  }
});

// ---------- GET /api/monitor/history ----------

test('GET /api/monitor/history: 返回历史监控点', async () => {
  const res = await req('GET', '/api/monitor/history', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.points), '应返回 points 数组');
});

test('GET /api/monitor/history?minutes=5: 指定分钟参数', async () => {
  const res = await req('GET', '/api/monitor/history?minutes=5', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.points));
});

// ---------- GET /api/monitor/history/range ----------

test('GET /api/monitor/history/range: 默认返回 1h 数据', async () => {
  const res = await req('GET', '/api/monitor/history/range', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.points));
});

test('GET /api/monitor/history/range?range=10m: 10m 范围', async () => {
  const res = await req('GET', '/api/monitor/history/range?range=10m', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.points));
});

test('GET /api/monitor/history/range?range=1h: 1h 范围', async () => {
  const res = await req('GET', '/api/monitor/history/range?range=1h', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.points));
});

test('GET /api/monitor/history/range?range=24h: 24h 范围', async () => {
  const res = await req('GET', '/api/monitor/history/range?range=24h', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.points));
});

test('GET /api/monitor/history/range?range=7d: 7d 范围', async () => {
  const res = await req('GET', '/api/monitor/history/range?range=7d', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.points));
});

test('GET /api/monitor/history/range?range=invalid: 无效范围回退到默认', async () => {
  const res = await req('GET', '/api/monitor/history/range?range=invalid', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.points));
});

// ---------- 需要登录的端点 ----------

test('GET /api/monitor/now: 未登录返回 401', async () => {
  const res = await req('GET', '/api/monitor/now');
  assert.strictEqual(res.status, 401);
});

test('GET /api/monitor/history: 未登录返回 401', async () => {
  const res = await req('GET', '/api/monitor/history');
  assert.strictEqual(res.status, 401);
});

test('GET /api/monitor/history/range: 未登录返回 401', async () => {
  const res = await req('GET', '/api/monitor/history/range');
  assert.strictEqual(res.status, 401);
});
