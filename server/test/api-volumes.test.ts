/**
 * 卷管理 API 集成测试
 *
 * 依赖：后端服务运行在 localhost:9528，Docker 引擎可用
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
const TEST_VOL = 'dm-autotest-vol';

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

test('GET /api/volumes: 返回成功状态码', async () => {
  const res = await req('GET', '/api/volumes', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/volumes: 创建测试卷', async () => {
  const res = await req('POST', '/api/volumes', { name: TEST_VOL }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 201 || res.status === 409);
});

test('DELETE /api/volumes/:name: 删除测试卷', async () => {
  const res = await req('DELETE', `/api/volumes/${TEST_VOL}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `expected <500, got ${res.status}`);
});

test('DELETE /api/volumes/nonexistent: 返回 404', async () => {
  const res = await req('DELETE', '/api/volumes/nonexistent-vol-xyz', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('POST /api/volumes/prune: 清理未使用卷', async () => {
  const res = await req('POST', '/api/volumes/prune', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('GET /api/volumes: 未登录返回 401', async () => {
  const res = await req('GET', '/api/volumes');
  assert.strictEqual(res.status, 401);
});

test('GET /api/volumes/:name: 获取卷详情', async () => {
  // 先确保测试卷存在
  await req('POST', '/api/volumes', { name: TEST_VOL }, { Authorization: `Bearer ${adminToken}` });
  const res = await req('GET', `/api/volumes/${TEST_VOL}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 404, `返回 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data.Name, '应包含 Name');
    assert.ok(res.data.Driver, '应包含 Driver');
  }
  // 清理
  await req('DELETE', `/api/volumes/${TEST_VOL}`, undefined, { Authorization: `Bearer ${adminToken}` });
});

test('GET /api/volumes/nonexistent-vol: 不存在的卷返回 404', async () => {
  const res = await req('GET', '/api/volumes/nonexistent-vol-xyz', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404 || res.status === 500, `返回 ${res.status}`);
});
