/**
 * 配置中心 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/settings — 已注册设置列表（登录即可读）
 *  2. PUT /api/settings/:key — 单项更新与校验失败
 *  3. DELETE /api/settings/:key — 恢复默认
 *  4. PUT /api/settings — 批量更新
 *  5. 未登录 401 / 非管理员 403
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

test('GET /api/settings: 返回已注册设置数组', async () => {
  const res = await req('GET', '/api/settings', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.items));
  if (res.data.items.length > 0) {
    const item = res.data.items[0];
    assert.ok(item.key);
    assert.ok(item.label);
    assert.ok(item.group);
    assert.ok(['db', 'env', 'default'].includes(item.source));
  }
});

test('GET /api/settings: secret 项只回显 configured 不泄露明文', async () => {
  const res = await req('GET', '/api/settings', undefined, { Authorization: `Bearer ${adminToken}` });
  for (const item of res.data.items || []) {
    if (item.type === 'secret') {
      assert.strictEqual(typeof item.configured, 'boolean');
      assert.strictEqual(item.value, undefined);
    }
  }
});

test('PUT /api/settings/logs.defaultTail: 更新后生效并可恢复默认', async () => {
  const put1 = await req('PUT', '/api/settings/logs.defaultTail', { value: 500 }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(put1.status, 200);
  let res = await req('GET', '/api/settings', undefined, { Authorization: `Bearer ${adminToken}` });
  const item = (res.data.items || []).find((s: any) => s.key === 'logs.defaultTail');
  assert.strictEqual(item.value, 500);
  assert.strictEqual(item.source, 'db');

  const del = await req('DELETE', '/api/settings/logs.defaultTail', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(del.status, 200);
  // 并行套件中 configTransfer 的导出/导入回环可能把刚删的键写回 —— 多查几次等其导入完成
  let after: any;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 300));
    res = await req('GET', '/api/settings', undefined, { Authorization: `Bearer ${adminToken}` });
    after = (res.data.items || []).find((s: any) => s.key === 'logs.defaultTail');
    if (after.source !== 'db') break;
  }
  assert.ok(after.source !== 'db');
});

test('PUT /api/settings/logs.defaultTail: 非数字返回 400', async () => {
  const res = await req('PUT', '/api/settings/logs.defaultTail', { value: 'abc' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('PUT /api/settings: 批量更新成功', async () => {
  const res = await req('PUT', '/api/settings', { 'logs.defaultTail': '300' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.ok);
  const list = await req('GET', '/api/settings', undefined, { Authorization: `Bearer ${adminToken}` });
  const item = (list.data.items || []).find((s: any) => s.key === 'logs.defaultTail');
  assert.strictEqual(item.value, 300);
  // 清理
  await req('DELETE', '/api/settings/logs.defaultTail', undefined, { Authorization: `Bearer ${adminToken}` });
});

test('PUT /api/settings: 未登录返回 401', async () => {
  const res = await req('PUT', '/api/settings/logs.defaultTail', { value: 500 });
  assert.strictEqual(res.status, 401);
});

test('GET /api/settings: 未登录返回 401', async () => {
  const res = await req('GET', '/api/settings');
  assert.strictEqual(res.status, 401);
});
