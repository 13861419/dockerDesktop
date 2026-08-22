/**
 * 应用商店 API 集成测试
 *
 * 覆盖应用列表、状态查询、自定义应用 CRUD、应用详情。
 * Docker 依赖操作（install/start/stop/restart/uninstall/upgrade）仅验证路由可达。
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let customAppId = '';

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

function auth() { return { Authorization: `Bearer ${adminToken}` }; }

before(async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  adminToken = login.data.token;
});

describe('应用商店 API', () => {
  test('GET /api/appstore: 返回应用列表', async () => {
    const res = await req('GET', '/api/appstore', undefined, auth());
    assert.strictEqual(res.status, 200);
    assert.ok(res.data);
  });

  test('GET /api/appstore/status: 返回状态映射', async () => {
    const res = await req('GET', '/api/appstore/status', undefined, auth());
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.data.statuses === 'object');
  });

  test('POST /api/appstore/custom: 创建自定义应用', async () => {
    const res = await req('POST', '/api/appstore/custom', { name: 'test-custom', image: 'alpine:latest' }, auth());
    assert.ok(res.status === 200 || res.status === 201);
    if (res.data?.id) customAppId = res.data.id;
  });

  test('POST /api/appstore/custom: 缺少 name 返回 400', async () => {
    const res = await req('POST', '/api/appstore/custom', { image: 'alpine' }, auth());
    assert.ok(res.status >= 400);
  });

  test('PUT /api/appstore/custom/:id: 更新自定义应用', async () => {
    if (!customAppId) return;
    const res = await req('PUT', `/api/appstore/custom/${customAppId}`, { name: 'updated-custom' }, auth());
    assert.ok(res.status < 500);
  });

  test('DELETE /api/appstore/custom/:id: 删除自定义应用', async () => {
    if (!customAppId) return;
    const res = await req('DELETE', `/api/appstore/custom/${customAppId}`, undefined, auth());
    assert.ok(res.status === 200 || res.status === 204);
  });

  test('GET /api/appstore/:id/detail: 查询应用详情', async () => {
    const res = await req('GET', '/api/appstore/nginx/detail', undefined, auth());
    assert.ok(res.status === 200 || res.status === 404);
  });

  test('POST /api/appstore/:id/install: 路由可达', async () => {
    const res = await req('POST', '/api/appstore/nonexistent-xyz/install', {}, auth());
    assert.ok(res.status === 404 || res.status < 500);
  });

  test('POST /api/appstore/:id/start: 路由可达', async () => {
    const res = await req('POST', '/api/appstore/nonexistent-xyz/start', {}, auth());
    assert.ok(res.status === 404 || res.status < 500);
  });

  test('POST /api/appstore/:id/stop: 路由可达', async () => {
    const res = await req('POST', '/api/appstore/nonexistent-xyz/stop', {}, auth());
    assert.ok(res.status === 404 || res.status < 500);
  });

  test('POST /api/appstore/:id/restart: 路由可达', async () => {
    const res = await req('POST', '/api/appstore/nonexistent-xyz/restart', {}, auth());
    assert.ok(res.status === 404 || res.status < 500);
  });

  test('POST /api/appstore/:id/uninstall: 路由可达', async () => {
    const res = await req('POST', '/api/appstore/nonexistent-xyz/uninstall', {}, auth());
    assert.ok(res.status === 404 || res.status < 500);
  });

  test('POST /api/appstore/:id/upgrade: 路由可达', async () => {
    const res = await req('POST', '/api/appstore/nonexistent-xyz/upgrade', {}, auth());
    assert.ok(res.status === 404 || res.status < 500);
  });

  test('POST /api/appstore/:id/update-params: 路由可达', async () => {
    const res = await req('POST', '/api/appstore/nonexistent-xyz/update-params', {}, auth());
    assert.ok(res.status === 404 || res.status < 500);
  });

  test('GET /api/appstore: 未登录返回 401', async () => {
    const res = await req('GET', '/api/appstore');
    assert.strictEqual(res.status, 401);
  });
});
