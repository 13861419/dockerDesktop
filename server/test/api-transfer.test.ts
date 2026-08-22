/**
 * 镜像跨引擎迁移 API 集成测试
 *
 * 覆盖：
 *  1. POST /api/transfer/images — 单镜像迁移
 *  2. POST /api/transfer/batch — 批量分发
 *  3. POST /api/transfer/container — 容器迁移
 *  4. 参数校验与边界条件
 *  5. 未登录返回 401
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

// ---------- POST /api/transfer/images ----------

test('POST /api/transfer/images: 缺少 image 返回 400', async () => {
  const res = await req('POST', '/api/transfer/images', {
    sourceEngineId: 'eng-1',
    targetEngineId: 'eng-2',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/transfer/images: 缺少引擎返回 400', async () => {
  const res = await req('POST', '/api/transfer/images', {
    image: 'nginx:latest',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/transfer/images: 相同引擎返回 400', async () => {
  const res = await req('POST', '/api/transfer/images', {
    image: 'nginx:latest',
    sourceEngineId: 'eng-1',
    targetEngineId: 'eng-1',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/transfer/images: 不存在的源引擎返回 400', async () => {
  const res = await req('POST', '/api/transfer/images', {
    image: 'nginx:latest',
    sourceEngineId: 'nonexistent-engine',
    targetEngineId: 'eng-2',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

// ---------- POST /api/transfer/batch ----------

test('POST /api/transfer/batch: 缺少 image 返回 400', async () => {
  const res = await req('POST', '/api/transfer/batch', {
    sourceEngineId: 'eng-1',
    targetEngineIds: ['eng-2'],
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/transfer/batch: 缺少 sourceEngineId 返回 400', async () => {
  const res = await req('POST', '/api/transfer/batch', {
    image: 'nginx:latest',
    targetEngineIds: ['eng-2'],
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/transfer/batch: 空目标列表返回 400', async () => {
  const res = await req('POST', '/api/transfer/batch', {
    image: 'nginx:latest',
    sourceEngineId: 'eng-1',
    targetEngineIds: [],
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/transfer/batch: 非数组 targetEngineIds 返回 400', async () => {
  const res = await req('POST', '/api/transfer/batch', {
    image: 'nginx:latest',
    sourceEngineId: 'eng-1',
    targetEngineIds: 'eng-2',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

// ---------- POST /api/transfer/container ----------

test('POST /api/transfer/container: 缺少 containerId 返回 400', async () => {
  const res = await req('POST', '/api/transfer/container', {
    sourceEngineId: 'eng-1',
    targetEngineId: 'eng-2',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/transfer/container: 缺少引擎返回 400', async () => {
  const res = await req('POST', '/api/transfer/container', {
    containerId: 'abc123',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/transfer/container: 相同引擎返回 400', async () => {
  const res = await req('POST', '/api/transfer/container', {
    containerId: 'abc123',
    sourceEngineId: 'eng-1',
    targetEngineId: 'eng-1',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

// ---------- 未登录测试 ----------

test('POST /api/transfer/images: 未登录返回 401', async () => {
  const res = await req('POST', '/api/transfer/images', { image: 'x', sourceEngineId: 'a', targetEngineId: 'b' });
  assert.strictEqual(res.status, 401);
});

test('POST /api/transfer/batch: 未登录返回 401', async () => {
  const res = await req('POST', '/api/transfer/batch', { image: 'x', sourceEngineId: 'a', targetEngineIds: ['b'] });
  assert.strictEqual(res.status, 401);
});

test('POST /api/transfer/container: 未登录返回 401', async () => {
  const res = await req('POST', '/api/transfer/container', { containerId: 'x', sourceEngineId: 'a', targetEngineId: 'b' });
  assert.strictEqual(res.status, 401);
});
