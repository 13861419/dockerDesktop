/**
 * 宿主机终端 API 集成测试
 *
 * 覆盖：
 *  1. GET  /api/hostterminal/info — 会话信息
 *  2. POST /api/hostterminal/exec — 执行命令
 *  3. 参数校验：空命令、超长命令、shell 类型
 *  4. 未登录返回 401
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

// ---------- GET /api/hostterminal/info ----------

test('GET /api/hostterminal/info: 返回会话信息', async () => {
  const res = await req('GET', '/api/hostterminal/info', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.cwd, '应返回 cwd');
  assert.ok(res.data.shell, '应返回 shell');
  assert.ok(Array.isArray(res.data.shells), '应返回 shells 数组');
  assert.ok(res.data.shells.includes('powershell'));
  assert.ok(res.data.shells.includes('cmd'));
});

// ---------- POST /api/hostterminal/exec ----------

test('POST /api/hostterminal/exec: 执行 echo 命令', async () => {
  const res = await req('POST', '/api/hostterminal/exec', {
    command: 'echo hello',
    shell: 'powershell',
    timeout: 10000,
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.data.output === 'string');
  assert.ok(res.data.output.includes('hello'), '输出应包含 hello');
  assert.ok(typeof res.data.exitCode === 'number');
});

test('POST /api/hostterminal/exec: cmd shell 执行命令', async () => {
  const res = await req('POST', '/api/hostterminal/exec', {
    command: 'echo hello',
    shell: 'cmd',
    timeout: 10000,
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.data.output === 'string');
});

test('POST /api/hostterminal/exec: 指定 cwd 参数', async () => {
  const res = await req('POST', '/api/hostterminal/exec', {
    command: 'echo test',
    cwd: 'C:\\',
    timeout: 10000,
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.cwd, '应返回 cwd');
});

test('POST /api/hostterminal/exec: 不存在的 cwd 回退到默认', async () => {
  const res = await req('POST', '/api/hostterminal/exec', {
    command: 'echo test',
    cwd: 'C:\\nonexistent_xyz_dir',
    timeout: 10000,
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
});

test('POST /api/hostterminal/exec: 空命令返回 400', async () => {
  const res = await req('POST', '/api/hostterminal/exec', {
    command: '',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/hostterminal/exec: 超长命令返回 400', async () => {
  const longCmd = 'a'.repeat(9000);
  const res = await req('POST', '/api/hostterminal/exec', {
    command: longCmd,
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400 && res.status < 500, `应返回 4xx，实际 ${res.status}`);
});

test('POST /api/hostterminal/exec: 不存在的命令不返回 5xx', async () => {
  const res = await req('POST', '/api/hostterminal/exec', {
    command: 'nonexistent_command_xyz_12345',
    shell: 'powershell',
    timeout: 10000,
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回 5xx，实际 ${res.status}`);
});

// ---------- cd 命令更新会话目录 ----------

test('POST /api/hostterminal/exec: cd 命令更新会话目录', async () => {
  const res = await req('POST', '/api/hostterminal/exec', {
    command: 'cd C:\\Windows',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  // 再次获取 info 确认目录已更新
  const info = await req('GET', '/api/hostterminal/info', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(info.data.cwd.includes('Windows'), `cwd 应包含 Windows，实际 ${info.data.cwd}`);
});

// ---------- 未登录测试 ----------

test('GET /api/hostterminal/info: 未登录返回 401', async () => {
  const res = await req('GET', '/api/hostterminal/info');
  assert.strictEqual(res.status, 401);
});

test('POST /api/hostterminal/exec: 未登录返回 401', async () => {
  const res = await req('POST', '/api/hostterminal/exec', { command: 'echo hi' });
  assert.strictEqual(res.status, 401);
});
