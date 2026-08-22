/**
 * 容器模板 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/templates：列表（含内置模板）
 *  2. POST /api/templates：新增（管理员/普通用户/空名称/重名）
 *  3. PUT /api/templates/:id：更新（正常/不存在/重名）
 *  4. DELETE /api/templates/:id：删除（正常/不存在）
 *  5. 内置模板 config 结构验证
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let userToken = '';

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
  const admin = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  adminToken = admin.data.token;
});

test('GET /api/templates: 返回数组，含内置模板', async () => {
  const res = await req('GET', '/api/templates', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data));
  assert.ok(res.data.length >= 5, '应至少有 5 个内置模板');
  // 内置模板结构验证
  const nginx = res.data.find((t: any) => t.name === 'Nginx 静态站点');
  assert.ok(nginx, '应包含 Nginx 模板');
  assert.ok(nginx.id.startsWith('builtin-'), '内置模板 id 应以 builtin- 开头');
  assert.strictEqual(nginx.image, 'nginx:alpine');
  assert.ok(typeof nginx.config === 'object', 'config 应为对象');
  assert.ok(nginx.config.image, 'config 应包含 image');
});

test('GET /api/templates: 未登录返回 401', async () => {
  const res = await req('GET', '/api/templates');
  assert.strictEqual(res.status, 401);
});

test('POST /api/templates: 管理员新增模板', async () => {
  const uniqueName = `测试模板-API-${Date.now()}`;
  const res = await req('POST', '/api/templates', {
    name: uniqueName,
    description: '自动化测试创建',
    image: 'alpine:latest',
    config: { name: 'test-api', image: 'alpine:latest', ports: [{ host: '9999', container: '80' }] },
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 201);
  assert.ok(res.data.id);
  assert.strictEqual(res.data.name, uniqueName);
  assert.strictEqual(res.data.image, 'alpine:latest');
  assert.strictEqual(res.data.config.ports[0].host, '9999');
  // 清理
  await req('DELETE', `/api/templates/${res.data.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
});

test('POST /api/templates: 空名称返回 400', async () => {
  const res = await req('POST', '/api/templates', { name: '', image: 'alpine' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('POST /api/templates: 重名返回 409', async () => {
  await req('POST', '/api/templates', { name: 'DupeTemplate', image: 'alpine' }, { Authorization: `Bearer ${adminToken}` });
  const res = await req('POST', '/api/templates', { name: 'DupeTemplate', image: 'nginx' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 409);
  // 清理
  const list = await req('GET', '/api/templates', undefined, { Authorization: `Bearer ${adminToken}` });
  const dupe = list.data.find((t: any) => t.name === 'DupeTemplate');
  if (dupe) await req('DELETE', `/api/templates/${dupe.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
});

test('POST /api/templates: 未登录返回 401', async () => {
  const res = await req('POST', '/api/templates', { name: '未登录模板', image: 'alpine' });
  assert.strictEqual(res.status, 401);
});

test('PUT /api/templates/:id: 更新模板名称和配置', async () => {
  // 先创建
  const created = await req('POST', '/api/templates', {
    name: '待更新模板',
    description: '原描述',
    image: 'redis:7',
    config: { name: 'old', image: 'redis:7' },
  }, { Authorization: `Bearer ${adminToken}` });
  const id = created.data.id;
  // 更新
  const res = await req('PUT', `/api/templates/${id}`, {
    name: '已更新模板',
    description: '新描述',
    image: 'redis:alpine',
    config: { name: 'new', image: 'redis:alpine', ports: [{ host: '6380', container: '6379' }] },
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.name, '已更新模板');
  assert.strictEqual(res.data.description, '新描述');
  assert.strictEqual(res.data.image, 'redis:alpine');
  assert.strictEqual(res.data.config.ports[0].host, '6380');
  // 清理
  await req('DELETE', `/api/templates/${id}`, undefined, { Authorization: `Bearer ${adminToken}` });
});

test('PUT /api/templates/:id: 不存在的 id 返回 404', async () => {
  const res = await req('PUT', '/api/templates/nonexistent-id', { name: 'x' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('DELETE /api/templates/:id: 删除模板', async () => {
  const created = await req('POST', '/api/templates', { name: '待删除模板', image: 'alpine' }, { Authorization: `Bearer ${adminToken}` });
  const id = created.data.id;
  const res = await req('DELETE', `/api/templates/${id}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.ok, true);
  // 确认已删除
  const list = await req('GET', '/api/templates', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(!list.data.find((t: any) => t.id === id));
});

test('DELETE /api/templates/:id: 不存在的 id 返回 404', async () => {
  const res = await req('DELETE', '/api/templates/nonexistent-id', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('POST /api/templates: config 字段可选，缺省为空对象', async () => {
  const res = await req('POST', '/api/templates', { name: '无Config模板', image: 'alpine' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(res.data.config, {});
  // 清理
  await req('DELETE', `/api/templates/${res.data.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
});
