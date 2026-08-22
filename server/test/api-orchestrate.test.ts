/**
 * 容器启动依赖编排 API 集成测试
 *
 * 覆盖：
 *   - GET  /dependencies
 *   - PUT  /dependencies/:containerId
 *   - DELETE /dependencies/:containerId
 *   - POST /start
 *   - POST /stop
 *   - POST /restart
 *   - POST /retry
 *   - GET  /history
 *
 * 对依赖 Docker 环境的操作采用宽松断言：任何非 5xx 即视为可接受。
 *
 * 依赖：后端服务运行在 localhost:9528，Docker 引擎可用
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

/* ---------- helpers ---------- */

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

function auth(headers: Record<string, string> = {}) {
  return { Authorization: `Bearer ${adminToken}`, ...headers };
}

/* ---------- setup ---------- */

before(async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  adminToken = login.data?.token || '';
  assert.ok(adminToken, '登录应返回 token');
});

/* ---------- dependencies ---------- */

test('GET /api/orchestrate/dependencies: 返回依赖列表', async () => {
  const res = await req('GET', '/api/orchestrate/dependencies', undefined, auth({}));
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(Array.isArray(res.data?.dependencies), '应包含 dependencies 数组');
  assert.ok(typeof res.data?.containers === 'object', '应包含 containers 映射');
});

test('PUT /api/orchestrate/dependencies/:id: 不存在的容器返回 404', async () => {
  const res = await req('PUT', '/api/orchestrate/dependencies/000000000000', { deps: [], enabled: true }, auth({}));
  assert.strictEqual(res.status, 404, `应返回 404，实际 ${res.status}`);
});

test('DELETE /api/orchestrate/dependencies/:id: 清除不存在的依赖配置', async () => {
  const res = await req('DELETE', '/api/orchestrate/dependencies/000000000000', undefined, auth({}));
  // DELETE 不校验容器存在性，直接返回 ok
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
});

/* ---------- start ---------- */

test('POST /api/orchestrate/start: 一键编排启动（空参与者列表）', async () => {
  const res = await req('POST', '/api/orchestrate/start', { containerIds: [] }, auth({}));
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.action === 'string', '应包含 action 字段');
    assert.ok(Array.isArray(res.data?.rounds), '应包含 rounds 数组');
  }
});

test('POST /api/orchestrate/start: 无 containerIds 参数', async () => {
  const res = await req('POST', '/api/orchestrate/start', {}, auth({}));
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

/* ---------- stop ---------- */

test('POST /api/orchestrate/stop: 一键编排停止（空参与者列表）', async () => {
  const res = await req('POST', '/api/orchestrate/stop', { containerIds: [] }, auth({}));
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.action === 'string', '应包含 action 字段');
  }
});

test('POST /api/orchestrate/stop: 无 containerIds 参数', async () => {
  const res = await req('POST', '/api/orchestrate/stop', {}, auth({}));
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

/* ---------- restart ---------- */

test('POST /api/orchestrate/restart: 一键编排重启（空参与者列表）', async () => {
  const res = await req('POST', '/api/orchestrate/restart', { containerIds: [] }, auth({}));
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.action === 'string', '应包含 action 字段');
  }
});

/* ---------- retry ---------- */

test('POST /api/orchestrate/retry: action 缺失返回 400', async () => {
  const res = await req('POST', '/api/orchestrate/retry', { containerIds: ['abc'] }, auth({}));
  assert.strictEqual(res.status, 400);
  assert.ok(res.data?.error?.includes('action'), '错误信息应提示 action');
});

test('POST /api/orchestrate/retry: action 非法返回 400', async () => {
  const res = await req('POST', '/api/orchestrate/retry', { action: 'invalid', containerIds: ['abc'] }, auth({}));
  assert.strictEqual(res.status, 400);
});

test('POST /api/orchestrate/retry: containerIds 为空返回 400', async () => {
  const res = await req('POST', '/api/orchestrate/retry', { action: 'start', containerIds: [] }, auth({}));
  assert.strictEqual(res.status, 400);
  assert.ok(res.data?.error?.includes('容器'), '错误信息应提示容器');
});

test('POST /api/orchestrate/retry: action=start 传入不存在容器', async () => {
  const res = await req('POST', '/api/orchestrate/retry', { action: 'start', containerIds: ['nonexistent-id'] }, auth({}));
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data?.items), '应包含 items 数组');
    assert.ok(typeof res.data?.ok === 'boolean', '应包含 ok 字段');
  }
});

test('POST /api/orchestrate/retry: action=stop 传入不存在容器', async () => {
  const res = await req('POST', '/api/orchestrate/retry', { action: 'stop', containerIds: ['nonexistent-id'] }, auth({}));
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data?.items), '应包含 items 数组');
  }
});

/* ---------- history ---------- */

test('GET /api/orchestrate/history: 默认分页', async () => {
  const res = await req('GET', '/api/orchestrate/history', undefined, auth({}));
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(Array.isArray(res.data?.items), '应包含 items 数组');
  assert.ok(typeof res.data?.total === 'number', '应包含 total');
  assert.ok(typeof res.data?.limit === 'number', '应包含 limit');
  assert.ok(typeof res.data?.offset === 'number', '应包含 offset');
});

test('GET /api/orchestrate/history?limit=5&offset=0: 自定义分页', async () => {
  const res = await req('GET', '/api/orchestrate/history?limit=5&offset=0', undefined, auth({}));
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(res.data.items.length <= 5, '返回条目数不应超过 limit');
});

/* ---------- auth ---------- */

test('GET /api/orchestrate/dependencies: 未登录返回 401', async () => {
  const res = await req('GET', '/api/orchestrate/dependencies');
  assert.strictEqual(res.status, 401);
});

test('PUT /api/orchestrate/dependencies/:id: 未登录返回 401', async () => {
  const res = await req('PUT', '/api/orchestrate/dependencies/000000000000', { deps: [] });
  assert.strictEqual(res.status, 401);
});

test('DELETE /api/orchestrate/dependencies/:id: 未登录返回 401', async () => {
  const res = await req('DELETE', '/api/orchestrate/dependencies/000000000000');
  assert.strictEqual(res.status, 401);
});

test('POST /api/orchestrate/start: 未登录返回 401', async () => {
  const res = await req('POST', '/api/orchestrate/start', {});
  assert.strictEqual(res.status, 401);
});

test('POST /api/orchestrate/stop: 未登录返回 401', async () => {
  const res = await req('POST', '/api/orchestrate/stop', {});
  assert.strictEqual(res.status, 401);
});

test('POST /api/orchestrate/restart: 未登录返回 401', async () => {
  const res = await req('POST', '/api/orchestrate/restart', {});
  assert.strictEqual(res.status, 401);
});

test('POST /api/orchestrate/retry: 未登录返回 401', async () => {
  const res = await req('POST', '/api/orchestrate/retry', { action: 'start', containerIds: ['x'] });
  assert.strictEqual(res.status, 401);
});

test('GET /api/orchestrate/history: 未登录返回 401', async () => {
  const res = await req('GET', '/api/orchestrate/history');
  assert.strictEqual(res.status, 401);
});
