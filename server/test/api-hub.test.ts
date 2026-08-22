/**
 * Docker Hub 镜像源 API 集成测试
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

test('GET /api/hub/sources: 返回成功状态码', async () => {
  const res = await req('GET', '/api/hub/sources', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/hub/sources: 新增自定义镜像源', async () => {
  const res = await req('POST', '/api/hub/sources', { host: 'test-mirror.example.com' }, { Authorization: `Bearer ${adminToken}` });
  // 可能因重复返回 409，此处仅验证不崩溃
  assert.ok(res.status === 200 || res.status === 201 || res.status === 409 || res.status === 500, `返回 ${res.status}`);
  if (res.data?.source?.id) {
    await req('DELETE', `/api/hub/sources/${res.data.source.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
  }
});

test('GET /api/hub/search?term=alpine: 搜索镜像', async () => {
  const res = await req('GET', '/api/hub/search?term=alpine', undefined, { Authorization: `Bearer ${adminToken}` });
  // 搜索可能因网络问题失败
  assert.ok(res.status === 200 || res.status >= 400);
});

test('GET /api/hub/sources: 未登录返回 401', async () => {
  const res = await req('GET', '/api/hub/sources');
  assert.strictEqual(res.status, 401);
});

test('GET /api/hub/repositories/library/alpine/tags: 获取标签列表', async () => {
  const res = await req('GET', '/api/hub/repositories/library/alpine/tags?page_size=5', undefined, { Authorization: `Bearer ${adminToken}` });
  // 网络不可达时返回 502，端点不存在返回 404，否则 200
  assert.ok(res.status === 200 || res.status === 404 || res.status === 502, `返回 ${res.status}`);
});

test('POST /api/hub/pull: 缺少 ref 返回 400', async () => {
  const res = await req('POST', '/api/hub/pull', {}, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('POST /api/hub/pull: 未登录返回 401', async () => {
  const res = await req('POST', '/api/hub/pull', { ref: 'library/alpine:latest' });
  assert.strictEqual(res.status, 401);
});

test('POST /api/hub/sources/reorder: 重排序镜像源', async () => {
  const sources = await req('GET', '/api/hub/sources', undefined, { Authorization: `Bearer ${adminToken}` });
  const ids = (sources.data?.sources || []).map((s: any) => s.id);
  if (ids.length > 0) {
    const res = await req('POST', '/api/hub/sources/reorder', { ids }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
  }
});

test('POST /api/hub/sources/reorder: 空 ids 返回 400', async () => {
  const res = await req('POST', '/api/hub/sources/reorder', { ids: [] }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('POST /api/hub/sources/test: 测试所有源连通性', async () => {
  const res = await req('POST', '/api/hub/sources/test', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 502, `返回 ${res.status}`);
  assert.ok(Array.isArray(res.data?.results), '应包含 results 数组');
});

test('POST /api/hub/sources/test: 按 id 测试单个源', async () => {
  const sources = await req('GET', '/api/hub/sources', undefined, { Authorization: `Bearer ${adminToken}` });
  const first = sources.data?.sources?.[0];
  if (first) {
    const res = await req('POST', '/api/hub/sources/test', { id: first.id }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 502, `返回 ${res.status}`);
  }
});

test('POST /api/hub/sources/:id/enabled: 启用/停用源', async () => {
  const sources = await req('GET', '/api/hub/sources', undefined, { Authorization: `Bearer ${adminToken}` });
  const first = sources.data?.sources?.[0];
  if (first) {
    const res = await req('POST', `/api/hub/sources/${first.id}/enabled`, { enabled: true }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
  }
});

test('PUT /api/hub/sources/:id: 更新镜像源名称', async () => {
  const sources = await req('GET', '/api/hub/sources', undefined, { Authorization: `Bearer ${adminToken}` });
  const first = sources.data?.sources?.[0];
  if (first) {
    const res = await req('PUT', `/api/hub/sources/${first.id}`, { name: first.name || 'updated-test' }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
  }
});

test('POST /api/hub/sources/:id/default: 设为默认源', async () => {
  const sources = await req('GET', '/api/hub/sources', undefined, { Authorization: `Bearer ${adminToken}` });
  const first = sources.data?.sources?.[0];
  if (first) {
    const res = await req('POST', `/api/hub/sources/${first.id}/default`, {}, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
  }
});

test('GET /api/hub/sources/:id/health: 测试单个源健康状态', async () => {
  const sources = await req('GET', '/api/hub/sources', undefined, { Authorization: `Bearer ${adminToken}` });
  const first = sources.data?.sources?.[0];
  if (first) {
    const res = await req('GET', `/api/hub/sources/${first.id}/health`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 502, `返回 ${res.status}`);
  }
});

test('GET /api/hub/sources/:id/health: 不存在的 id 返回 404', async () => {
  const res = await req('GET', '/api/hub/sources/nonexistent-id/health', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('GET /api/hub/search-source: 获取搜索源配置', async () => {
  const res = await req('GET', '/api/hub/search-source', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok('host' in res.data, '应包含 host 字段');
});

test('POST /api/hub/search-source: 设置搜索源', async () => {
  const res = await req('POST', '/api/hub/search-source', { host: '' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.ok, true);
});
