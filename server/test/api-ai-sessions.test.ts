/**
 * AI 会话管理 API 集成测试
 *
 * 覆盖：
 *  1. POST /api/ai/sessions：创建会话
 *  2. PUT /api/ai/sessions/:id/pin：收藏/取消收藏
 *  3. POST /api/ai/sessions/batch-delete：批量删除（用户隔离）
 *  4. DELETE /api/ai/sessions/clear：清空全部会话
 *  5. GET /api/ai/inspection/list：巡检记录列表
 *  6. GET /api/ai/usage/chat-stats：聊天统计
 *  7. 未登录访问控制
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<{ status: number; data: any; headers: any }> {
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
        resolve({ status: res.statusCode || 0, data: parsed, headers: res.headers });
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

test('POST /api/ai/sessions: 创建测试会话', async () => {
  const res = await req('POST', '/api/ai/sessions', { title: 'api-test-session' }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.id > 0);
  assert.strictEqual(res.data.pinned, false);
});

test('PUT /api/ai/sessions/:id/pin: 收藏后置顶优先', async () => {
  const s1 = await req('POST', '/api/ai/sessions', { title: 'pin-me' }, { Authorization: `Bearer ${adminToken}` });
  const s2 = await req('POST', '/api/ai/sessions', { title: 'normal' }, { Authorization: `Bearer ${adminToken}` });
  // 收藏 s1
  const pin = await req('PUT', `/api/ai/sessions/${s1.data.id}/pin`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(pin.status, 200);
  assert.strictEqual(pin.data.pinned, true);
  // 列表中 s1 应排在 s2 前面（置顶优先）
  const list = await req('GET', '/api/ai/sessions', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(list.status, 200);
  const ids = list.data.sessions.map((x: any) => x.id);
  assert.ok(ids.indexOf(s1.data.id) < ids.indexOf(s2.data.id));
  // 再次调用取消收藏
  const unpin = await req('PUT', `/api/ai/sessions/${s1.data.id}/pin`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(unpin.data.pinned, false);
});

test('POST /api/ai/sessions/batch-delete: 批量删除', async () => {
  const a = await req('POST', '/api/ai/sessions', { title: 'batch-a' }, { Authorization: `Bearer ${adminToken}` });
  const b = await req('POST', '/api/ai/sessions', { title: 'batch-b' }, { Authorization: `Bearer ${adminToken}` });
  const del = await req('POST', '/api/ai/sessions/batch-delete', { ids: [a.data.id, b.data.id] }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.data.deleted, 2);
  // 删除后不存在
  const got = await req('GET', `/api/ai/sessions/${a.data.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(got.status, 404);
});

test('POST /api/ai/sessions/batch-delete: 空数组返回 400', async () => {
  const del = await req('POST', '/api/ai/sessions/batch-delete', { ids: [] }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(del.status, 400);
});

test('DELETE /api/ai/sessions/clear: 清空全部会话', async () => {
  // 先创建几个会话
  await req('POST', '/api/ai/sessions', { title: 'clear-1' }, { Authorization: `Bearer ${adminToken}` });
  await req('POST', '/api/ai/sessions', { title: 'clear-2' }, { Authorization: `Bearer ${adminToken}` });
  const res = await req('DELETE', '/api/ai/sessions/clear', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.deleted >= 2);
  // 清空后列表为空
  const list = await req('GET', '/api/ai/sessions', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(list.data.sessions.length, 0);
});

test('GET /api/ai/inspection/list: 返回列表结构', async () => {
  const res = await req('GET', '/api/ai/inspection/list', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.items));
});

test('GET /api/ai/usage/chat-stats: 返回统计结构', async () => {
  const res = await req('GET', '/api/ai/usage/chat-stats', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.data.stats));
});

test('AI 会话端点未登录返回 401', async () => {
  const a = await req('POST', '/api/ai/sessions');
  assert.strictEqual(a.status, 401);
  const b = await req('POST', '/api/ai/sessions/batch-delete', { ids: [1] });
  assert.strictEqual(b.status, 401);
  const c = await req('DELETE', '/api/ai/sessions/clear');
  assert.strictEqual(c.status, 401);
  const d = await req('GET', '/api/ai/inspection/list');
  assert.strictEqual(d.status, 401);
});
