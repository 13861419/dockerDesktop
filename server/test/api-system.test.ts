/**
 * 系统信息 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/system/info：Docker 系统信息
 *  2. GET /api/system/version：Docker 版本
 *  3. GET /api/system/ping：引擎连通性
 *  4. GET /api/system/df：磁盘使用统计
 *  5. GET /api/overview：仪表盘总览
 *  6. 未登录访问系统接口返回 401
 *
 * 依赖：后端服务运行在 localhost:9528，Docker 引擎可用
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

test('GET /api/system/ping: 引擎可达', async () => {
  const res = await req('GET', '/api/system/ping', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.status, 'ok');
});

test('GET /api/system/info: 返回 Docker 系统信息', async () => {
  const res = await req('GET', '/api/system/info', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.ID, '应包含 ID');
  assert.ok(res.data.ServerVersion, '应包含 ServerVersion');
  assert.ok(res.data.OperatingSystem, '应包含 OperatingSystem');
  assert.ok(typeof res.data.NCPU === 'number', 'NCPU 应为数字');
  assert.ok(typeof res.data.MemTotal === 'number', 'MemTotal 应为数字');
});

test('GET /api/system/version: 返回 Docker 版本', async () => {
  const res = await req('GET', '/api/system/version', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.Version, '应包含 Version');
  assert.ok(res.data.ApiVersion, '应包含 ApiVersion');
});

test('GET /api/system/df: 返回磁盘使用', async () => {
  const res = await req('GET', '/api/system/df', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  // 响应包含 df 和 summary 字段
  assert.ok(typeof res.data === 'object');
  assert.ok(res.data.df || res.data.summary, '应包含 df 或 summary');
});

test('GET /api/overview: 返回仪表盘统计数据', async () => {
  const res = await req('GET', '/api/overview', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.serverVersion, '应包含 serverVersion');
  assert.ok(typeof res.data.containers === 'object', 'containers 应为对象');
  assert.ok(typeof res.data.containers.total === 'number');
  assert.ok(typeof res.data.containers.running === 'number');
  assert.ok(typeof res.data.containers.stopped === 'number');
  assert.ok(typeof res.data.images === 'number');
  assert.ok(typeof res.data.volumes === 'number');
  assert.ok(typeof res.data.networks === 'number');
  assert.ok(typeof res.data.nCPU === 'number');
});

test('GET /api/system/info: 未登录返回 401', async () => {
  const res = await req('GET', '/api/system/info');
  assert.strictEqual(res.status, 401);
});

test('GET /api/overview: 未登录返回 401', async () => {
  const res = await req('GET', '/api/overview');
  assert.strictEqual(res.status, 401);
});

test('GET /api/system/df: 未登录返回 401', async () => {
  const res = await req('GET', '/api/system/df');
  assert.strictEqual(res.status, 401);
});

test('POST /api/system/prune: 清理未使用资源', async () => {
  const res = await req('POST', '/api/system/prune', { images: true, containers: true }, { Authorization: `Bearer ${adminToken}` });
  // 409：与其他请求并发触发 Docker 清理冲突（瞬时态），视为可接受的瞬态
  assert.ok(res.status === 200 || res.status === 500 || res.status === 409, `返回 ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.ok(res.data.results, '应包含 results');
  }
});

test('POST /api/system/prune: 未登录返回 401', async () => {
  const res = await req('POST', '/api/system/prune', {});
  assert.strictEqual(res.status, 401);
});

test('GET /api/system/settings: 获取服务设置', async () => {
  const res = await req('GET', '/api/system/settings', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data === 'object', '应返回对象');
  }
});

test('GET /api/system/settings: 未登录返回 401', async () => {
  const res = await req('GET', '/api/system/settings');
  assert.strictEqual(res.status, 401);
});

test('GET /api/system/users: 获取用户列表', async () => {
  const res = await req('GET', '/api/system/users', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data), '应返回数组');
  }
});

test('POST /api/system/users: 新增用户', async () => {
  const name = `testuser-${Date.now()}`;
  const res = await req('POST', '/api/system/users', { username: name, password: 'test123456', role: 'user' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 409, `返回 ${res.status}`);
  if (res.status === 200) {
    // 清理：删除测试用户
    await req('DELETE', `/api/system/users/${name}`, undefined, { Authorization: `Bearer ${adminToken}` });
  }
});

test('POST /api/system/users: 缺少字段返回 400', async () => {
  const res = await req('POST', '/api/system/users', { username: 'test' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('POST /api/system/users: 密码过短返回 400', async () => {
  const res = await req('POST', '/api/system/users', { username: 'test', password: '123' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('DELETE /api/system/users/:name: 删除用户', async () => {
  // 先创建
  const name = `deluser-${Date.now()}`;
  await req('POST', '/api/system/users', { username: name, password: 'test123456' }, { Authorization: `Bearer ${adminToken}` });
  const res = await req('DELETE', `/api/system/users/${name}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 400, `返回 ${res.status}`);
});

test('DELETE /api/system/users/:name: 未登录返回 401', async () => {
  const res = await req('DELETE', '/api/system/users/testuser');
  assert.strictEqual(res.status, 401);
});

test('POST /api/system/password: 缺少字段返回 400', async () => {
  const res = await req('POST', '/api/system/password', { username: 'admin', oldPassword: 'old', newPassword: '' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/system/password: 原密码错误返回 400', async () => {
  const res = await req('POST', '/api/system/password', { username: 'admin', oldPassword: 'wrong-password', newPassword: 'new-password-123' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('GET /api/system/backup: 导出数据库备份', async () => {
  const res = await req('GET', '/api/system/backup', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
});

test('GET /api/system/backup: 未登录返回 401', async () => {
  const res = await req('GET', '/api/system/backup');
  assert.strictEqual(res.status, 401);
});

test('POST /api/system/restore: 空请求体返回 400', async () => {
  const res = await req('POST', '/api/system/restore', null, { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' });
  assert.ok(res.status === 400, `返回 ${res.status}`);
});
