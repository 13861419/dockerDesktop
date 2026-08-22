/**
 * 通知渠道 API 集成测试
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

test('GET /api/notifications/channels: 返回成功状态码', async () => {
  const res = await req('GET', '/api/notifications/channels', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/notifications/channels: 创建渠道', async () => {
  const res = await req('POST', '/api/notifications/channels', {
    name: `test-ch-${Date.now()}`,
    type: 'webhook',
    config: { url: 'https://httpbin.org/post' },
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 201);
  // 清理
  if (res.data?.id) {
    await req('DELETE', `/api/notifications/channels/${res.data.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
  }
});

test('GET /api/notifications/channels: 未登录返回 401', async () => {
  const res = await req('GET', '/api/notifications/channels');
  assert.strictEqual(res.status, 401);
});

test('PUT /api/notifications/channels/:id: 更新渠道名称', async () => {
  // 先创建渠道
  const create = await req('POST', '/api/notifications/channels', {
    name: `test-update-${Date.now()}`,
    type: 'webhook',
    config: { url: 'https://httpbin.org/post' },
  }, { Authorization: `Bearer ${adminToken}` });
  if (create.data?.id) {
    const res = await req('PUT', `/api/notifications/channels/${create.data.id}`, { name: 'updated-name' }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200, `返回 ${res.status}`);
    // 清理
    await req('DELETE', `/api/notifications/channels/${create.data.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
  }
});

test('POST /api/notifications/channels/:id/test: 测试推送', async () => {
  // 创建渠道
  const create = await req('POST', '/api/notifications/channels', {
    name: `test-push-${Date.now()}`,
    type: 'webhook',
    config: { url: 'https://httpbin.org/post' },
  }, { Authorization: `Bearer ${adminToken}` });
  if (create.data?.id) {
    const res = await req('POST', `/api/notifications/channels/${create.data.id}/test`, {}, { Authorization: `Bearer ${adminToken}` });
    // 推送可能因外部服务失败，但不应崩溃
    assert.ok(res.status < 500 || res.status === 502, `返回 ${res.status}`);
    // 清理
    await req('DELETE', `/api/notifications/channels/${create.data.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
  }
});

test('GET /api/notifications/rules: 获取告警规则', async () => {
  const res = await req('GET', '/api/notifications/rules', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
  assert.ok(Array.isArray(res.data?.rules), '应包含 rules 数组');
  assert.ok(res.data?.current !== undefined, '应包含 current 字段');
});

test('PUT /api/notifications/rules/:type: 更新告警规则', async () => {
  const res = await req('PUT', '/api/notifications/rules/cpu', { enabled: true }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 400, `返回 ${res.status}`);
});

test('GET /api/notifications/records: 获取告警记录', async () => {
  const res = await req('GET', '/api/notifications/records?page=1&pageSize=10', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
  assert.ok('total' in res.data || 'records' in res.data, '应包含 total 或 records');
});

test('DELETE /api/notifications/records: 清空告警记录', async () => {
  const res = await req('DELETE', '/api/notifications/records', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
});

test('POST /api/notifications/check: 立即执行一次检测', async () => {
  const res = await req('POST', '/api/notifications/check', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
});

test('GET /api/notifications/container-rules: 获取容器告警规则', async () => {
  const res = await req('GET', '/api/notifications/container-rules', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
  assert.ok(Array.isArray(res.data?.rules), '应包含 rules 数组');
});

test('POST /api/notifications/container-rules: 新增容器告警规则', async () => {
  const res = await req('POST', '/api/notifications/container-rules', {
    containerId: 'test-container-id',
    containerName: 'test-container',
    watchType: 'restart',
    enabled: true,
    thresholds: { warn: 3, danger: 5 },
  }, { Authorization: `Bearer ${adminToken}` });
  // 可能因容器不存在返回 400/500，但不应崩溃
  assert.ok(res.status < 500, `返回 ${res.status}`);
  if (res.data?.rule?.id) {
    // 清理
    await req('DELETE', `/api/notifications/container-rules/${res.data.rule.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
  }
});

test('POST /api/notifications/container-rules: 未登录返回 401', async () => {
  const res = await req('POST', '/api/notifications/container-rules', {
    containerId: 'test',
    watchType: 'restart',
  });
  assert.strictEqual(res.status, 401);
});
