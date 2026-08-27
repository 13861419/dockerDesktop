/**
 * 标签体系 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/labels — 聚合容器/镜像/卷标签
 *  2. 返回结构与排序
 *  3. kind 参数过滤
 *  4. 未登录 401
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

test('GET /api/labels: 返回聚合数组，结构正确且按 count 降序', async () => {
  const res = await req('GET', '/api/labels', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.items));
  for (const item of res.data.items) {
    assert.ok(typeof item.key === 'string' && item.key.length > 0);
    assert.ok(typeof item.value === 'string');
    assert.ok(typeof item.count === 'number' && item.count >= 1);
    assert.ok(typeof item.kinds.container === 'number');
    assert.ok(typeof item.kinds.image === 'number');
    assert.ok(typeof item.kinds.volume === 'number');
  }
  // 排序校验：count 非升序
  for (let i = 1; i < res.data.items.length; i++) {
    assert.ok(res.data.items[i - 1].count >= res.data.items[i].count);
  }
});

test('GET /api/labels?kind=container: 仅统计容器标签', async () => {
  const res = await req('GET', '/api/labels?kind=container', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.items));
  for (const item of res.data.items) {
    assert.ok(item.kinds.container >= 1);
    assert.strictEqual(item.kinds.image, 0);
    assert.strictEqual(item.kinds.volume, 0);
  }
});

test('GET /api/labels: 未登录返回 401', async () => {
  const res = await req('GET', '/api/labels');
  assert.strictEqual(res.status, 401);
});
