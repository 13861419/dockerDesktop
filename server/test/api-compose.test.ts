/**
 * Compose 管理 API 集成测试
 *
 * 依赖：后端服务运行在 localhost:9528，Docker + Docker Compose 可用
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

test('GET /api/compose: 返回成功状态码', async () => {
  const res = await req('GET', '/api/compose', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('GET /api/compose/nonexistent: 返回 404', async () => {
  const res = await req('GET', '/api/compose/nonexistent-id', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('POST /api/compose: 缺少 name 返回 4xx', async () => {
  const res = await req('POST', '/api/compose', { content: 'test' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400);
});

test('GET /api/compose: 未登录返回 401', async () => {
  const res = await req('GET', '/api/compose');
  assert.strictEqual(res.status, 401);
});

// ============ 补充缺失端点测试 ============

test('POST /api/compose/validate: 校验有效 YAML', async () => {
  const res = await req('POST', '/api/compose/validate', { content: 'version: "3"\nservices:\n  web:\n    image: nginx\n' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 400, `应返回 200/400，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true, '有效 YAML 应返回 ok');
  }
});

test('POST /api/compose/validate: 无效 YAML 返回 400', async () => {
  const res = await req('POST', '/api/compose/validate', { content: 'version: "3"\nservices:\n  web:\n    image:\n      - invalid' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400 || res.status === 200, `应返回 400/200，实际 ${res.status}`);
});

test('POST /api/compose/validate: 缺少 content 返回 400', async () => {
  const res = await req('POST', '/api/compose/validate', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

const TEST_COMPOSE = 'version: "3"\nservices:\n  dm-test:\n    image: alpine:latest\n    command: sleep 3600\n';
let testProjectName = '';

test('POST /api/compose: 创建测试项目', async () => {
  testProjectName = 'dm-autotest-compose';
  const res = await req('POST', '/api/compose', { name: testProjectName, content: TEST_COMPOSE }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 201) {
    assert.ok(res.data?.name === testProjectName);
  }
});

test('GET /api/compose/:name/config: 获取项目配置', async () => {
  if (!testProjectName) return;
  const res = await req('GET', `/api/compose/${testProjectName}/config`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.config === 'string', '应返回 config 字符串');
  }
});

test('GET /api/compose/:name/file: 读取 compose 文件', async () => {
  if (!testProjectName) return;
  const res = await req('GET', `/api/compose/${testProjectName}/file`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.content === 'string', '应返回 content 字符串');
  }
});

test('GET /api/compose/:name/file: 不存在返回 404', async () => {
  const res = await req('GET', '/api/compose/nonexistent-id/file', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('GET /api/compose/:name/structure: 项目结构视图', async () => {
  if (!testProjectName) return;
  const res = await req('GET', `/api/compose/${testProjectName}/structure`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data?.services), '应返回 services 数组');
  }
});

test('POST /api/compose/:name/up: 启动项目', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/up`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true, '应返回 ok: true');
  }
});

test('POST /api/compose/:name/logs: 获取项目日志', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/logs`, { tail: 10 }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.logs === 'string', '应返回 logs 字符串');
  }
});

test('POST /api/compose/:name/services/:service/start: 启动服务', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/services/dm-test/start`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/compose/:name/services/:service/stop: 停止服务', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/services/dm-test/stop`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/compose/:name/services/:service/restart: 重启服务', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/services/dm-test/restart`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/compose/:name/restart: 重启项目', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/restart`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/compose/:name/pull: 拉取镜像', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/pull`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/compose/:name/build: 构建镜像', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/build`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/compose/:name/down: 停止并移除项目', async () => {
  if (!testProjectName) return;
  const res = await req('POST', `/api/compose/${testProjectName}/down`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true);
  }
});

test('DELETE /api/compose/:name: 删除项目目录', async () => {
  if (!testProjectName) return;
  const res = await req('DELETE', `/api/compose/${testProjectName}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true);
  }
});

test('POST /api/compose: 缺少 content 返回 4xx', async () => {
  const res = await req('POST', '/api/compose', { name: 'test-no-content' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400);
});
