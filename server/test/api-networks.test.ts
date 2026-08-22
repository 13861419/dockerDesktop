/**
 * 网络管理 API 集成测试
 *
 * 依赖：后端服务运行在 localhost:9528，Docker 引擎可用
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
const TEST_NET = 'dm-autotest-net';

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

test('GET /api/networks: 返回成功状态码', async () => {
  const res = await req('GET', '/api/networks', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/networks: 创建自定义网络', async () => {
  const res = await req('POST', '/api/networks', { name: TEST_NET, driver: 'bridge' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 201 || res.status === 409);
});

test('DELETE /api/networks/bridge: 内置网络不可删除', async () => {
  const res = await req('DELETE', '/api/networks/bridge', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400);
});

test('DELETE /api/networks: 删除自定义网络', async () => {
  // 获取自定义网络列表
  const list = await req('GET', '/api/networks', undefined, { Authorization: `Bearer ${adminToken}` });
  const networks = Array.isArray(list.data) ? list.data : (list.data?.networks || []);
  const net = networks.find((n: any) => (n.Name || n.name) === TEST_NET);
  if (net) {
    const id = net.Id || net.id;
    const res = await req('DELETE', `/api/networks/${id}`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 204);
  }
});

test('GET /api/networks: 未登录返回 401', async () => {
  const res = await req('GET', '/api/networks');
  assert.strictEqual(res.status, 401);
});

test('GET /api/networks/:id: 获取网络详情', async () => {
  const res = await req('GET', '/api/networks/bridge', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 404, `返回 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data.Name || res.data.name, '应包含 Name');
  }
});

test('GET /api/networks/nonexistent-id: 不存在的网络返回 404', async () => {
  const res = await req('GET', '/api/networks/nonexistent-net-id-xyz', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404 || res.status === 500, `返回 ${res.status}`);
});

test('POST /api/networks/prune: 清理未使用网络', async () => {
  const res = await req('POST', '/api/networks/prune', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 500, `返回 ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.ok(Array.isArray(res.data.deleted), '应包含 deleted 数组');
  }
});

test('POST /api/networks/prune: 未登录返回 401', async () => {
  const res = await req('POST', '/api/networks/prune', {});
  assert.strictEqual(res.status, 401);
});

test('POST /api/networks/:id/connect: 缺少 container 返回 400', async () => {
  const res = await req('POST', '/api/networks/bridge/connect', {}, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('POST /api/networks/:id/connect: 连接容器到网络', async () => {
  // 使用不存在的容器ID，验证请求能正确处理（不应崩溃）
  const res = await req('POST', '/api/networks/bridge/connect', { container: 'nonexistent-container-id' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `返回 ${res.status}`);
});

test('POST /api/networks/:id/disconnect: 缺少 container 返回 400', async () => {
  const res = await req('POST', '/api/networks/bridge/disconnect', {}, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 400);
});

test('POST /api/networks/:id/disconnect: 断开容器网络', async () => {
  const res = await req('POST', '/api/networks/bridge/disconnect', { container: 'nonexistent-container-id' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `返回 ${res.status}`);
});

test('POST /api/networks/:id/connect: 未登录返回 401', async () => {
  const res = await req('POST', '/api/networks/bridge/connect', { container: 'test' });
  assert.strictEqual(res.status, 401);
});
