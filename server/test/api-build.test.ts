/**
 * 镜像构建 API 集成测试
 *
 * 覆盖：
 *  1. GET  /api/build/history — 构建历史分页
 *  2. DELETE /api/build/history — 清空构建历史
 *  3. POST /api/build/image — 镜像构建
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

// ---------- GET /api/build/history ----------

test('GET /api/build/history: 返回构建历史列表', async () => {
  const res = await req('GET', '/api/build/history', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.list), '应返回 list 数组');
});

test('GET /api/build/history?limit=5&offset=0: 分页参数生效', async () => {
  const res = await req('GET', '/api/build/history?limit=5&offset=0', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.list));
  assert.ok(res.data.list.length <= 5);
});

// ---------- DELETE /api/build/history ----------

test('DELETE /api/build/history: 清空构建历史', async () => {
  const res = await req('DELETE', '/api/build/history', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(res.data.success);
});

// ---------- POST /api/build/image ----------

test('POST /api/build/image: 缺少 name 返回 400', async () => {
  const res = await req('POST', '/api/build/image', { context: 'C:\\' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/build/image: 缺少 context 返回 400', async () => {
  const res = await req('POST', '/api/build/image', { name: 'test-img' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/build/image: 不存在的构建上下文返回 400', async () => {
  const res = await req('POST', '/api/build/image', {
    name: 'test-img',
    context: 'C:\\nonexistent_dir_xyz',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

// ---------- POST /api/build/image/stream（SSE） ----------

test('POST /api/build/image/stream: 缺少参数时返回 done(失败) 帧并结束', async () => {
  const res = await req('POST', '/api/build/image/stream', { context: 'C:\\' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(String(res.data).includes('"type":"done"'), '应包含 done 帧');
  assert.ok(String(res.data).includes('"success":false'), 'done 帧应为失败');
});

test('POST /api/build/image/stream: 未登录返回 401', async () => {
  const res = await req('POST', '/api/build/image/stream', { name: 'x', context: 'C:\\' });
  assert.strictEqual(res.status, 401);
});

// ---------- 未登录测试 ----------

test('GET /api/build/history: 未登录返回 401', async () => {
  const res = await req('GET', '/api/build/history');
  assert.strictEqual(res.status, 401);
});

test('DELETE /api/build/history: 未登录返回 401', async () => {
  const res = await req('DELETE', '/api/build/history');
  assert.strictEqual(res.status, 401);
});

test('POST /api/build/image: 未登录返回 401', async () => {
  const res = await req('POST', '/api/build/image', { name: 'x', context: 'C:\\' });
  assert.strictEqual(res.status, 401);
});
