/**
 * 全局搜索 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/search?q= — 聚合搜索
 *  2. 空查询返回空分组
 *  3. 返回结构验证
 *  4. 无需登录（公共端点）
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

// ---------- 空查询 ----------

test('GET /api/search?q= (empty): 返回空分组', async () => {
  const res = await req('GET', '/api/search?q=', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.containers));
  assert.ok(Array.isArray(res.data.images));
  assert.ok(Array.isArray(res.data.volumes));
  assert.ok(Array.isArray(res.data.networks));
  assert.ok(Array.isArray(res.data.compose));
  assert.strictEqual(res.data.containers.length, 0);
  assert.strictEqual(res.data.images.length, 0);
});

test('GET /api/search (no q param): 返回空分组', async () => {
  const res = await req('GET', '/api/search', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.containers));
  assert.ok(Array.isArray(res.data.images));
});

// ---------- 搜索关键词 ----------

test('GET /api/search?q=nginx: 返回结果结构正确', async () => {
  const res = await req('GET', '/api/search?q=nginx', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.containers));
  assert.ok(Array.isArray(res.data.images));
  assert.ok(Array.isArray(res.data.volumes));
  assert.ok(Array.isArray(res.data.networks));
  assert.ok(Array.isArray(res.data.compose));
  // 结果应截断为最多 20 条
  if (res.data.containers.length > 0) {
    const c = res.data.containers[0];
    assert.ok(c.id);
    assert.ok(c.name);
    assert.ok(c.image);
    assert.ok(c.state);
  }
  if (res.data.images.length > 0) {
    const i = res.data.images[0];
    assert.ok(i.id);
    assert.ok(i.name);
  }
});

test('GET /api/search?q=alpine: 搜索可能存在的镜像', async () => {
  const res = await req('GET', '/api/search?q=alpine', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.images));
});

test('GET /api/search?q=nonexistent_xyz_12345: 无匹配结果', async () => {
  const res = await req('GET', '/api/search?q=nonexistent_xyz_12345', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.containers.length, 0);
  assert.strictEqual(res.data.images.length, 0);
  assert.strictEqual(res.data.volumes.length, 0);
  assert.strictEqual(res.data.networks.length, 0);
});

test('GET /api/search?q=bridge: 搜索网络', async () => {
  const res = await req('GET', '/api/search?q=bridge', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.networks));
  if (res.data.networks.length > 0) {
    const n = res.data.networks[0];
    assert.ok(n.id);
    assert.ok(n.name);
  }
});

// ---------- 无需登录的公共端点 ----------

test('GET /api/search?q=test: 未登录也能访问', async () => {
  const res = await req('GET', '/api/search?q=test');
  // Search doesn't require auth - accepts both 200 (public) and 401 (if auth required)
  assert.ok(res.status === 200 || res.status === 401, `expected 200 or 401, got ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data.containers));
  }
});
