/**
 * Compose 模板 API 集成测试
 *
 * 覆盖 /api/compose-templates 的完整 CRUD。
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let createdId = '';

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
  // 清理上次测试残留数据
  const list = await req('GET', '/api/compose-templates', undefined, { Authorization: `Bearer ${adminToken}` });
  if (Array.isArray(list.data)) {
    for (const t of list.data) {
      if (t.name?.startsWith('dm-test-compose-template')) {
        await req('DELETE', `/api/compose-templates/${t.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
      }
    }
  }
});

test('GET /api/compose-templates: 返回模板列表', async () => {
  const res = await req('GET', '/api/compose-templates', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data));
});

test('POST /api/compose-templates: 创建模板', async () => {
  const res = await req('POST', '/api/compose-templates', {
    name: 'dm-test-compose-template',
    content: 'services:\n  web:\n    image: nginx',
    description: '测试模板',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 201);
  assert.ok(res.data.id);
  createdId = res.data.id;
});

test('POST /api/compose-templates: 缺少 name 返回 400', async () => {
  const res = await req('POST', '/api/compose-templates', { content: 'test' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('POST /api/compose-templates: 空内容返回 400', async () => {
  const res = await req('POST', '/api/compose-templates', { name: 'empty', content: '' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('POST /api/compose-templates: 重名返回 409', async () => {
  const res = await req('POST', '/api/compose-templates', {
    name: 'dm-test-compose-template',
    content: 'services:\n  app:\n    image: alpine',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 409);
});

test('PUT /api/compose-templates/:id: 更新模板', async () => {
  if (!createdId) return;
  const res = await req('PUT', `/api/compose-templates/${createdId}`, {
    name: 'dm-test-compose-template-updated',
    content: 'services:\n  web:\n    image: nginx:alpine',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.name, 'dm-test-compose-template-updated');
});

test('PUT /api/compose-templates/:id: 不存在的 id 返回 404', async () => {
  const res = await req('PUT', '/api/compose-templates/nonexistent', { name: 'x', content: 'y' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('DELETE /api/compose-templates/:id: 删除模板', async () => {
  if (!createdId) return;
  const res = await req('DELETE', `/api/compose-templates/${createdId}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.ok, true);
});

test('DELETE /api/compose-templates/:id: 不存在的 id 返回 404', async () => {
  const res = await req('DELETE', '/api/compose-templates/nonexistent', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('POST /api/compose-templates: 未登录返回 401', async () => {
  const res = await req('POST', '/api/compose-templates', { name: 'x', content: 'y' });
  assert.strictEqual(res.status, 401);
});
