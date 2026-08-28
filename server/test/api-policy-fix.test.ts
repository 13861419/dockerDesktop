/**
 * 安全基线违规在线修复 API 集成测试
 *
 * 覆盖：
 *  1. 不可自动修复的规则返回 400
 *  2. 管理员直接修复不存在的容器 → 404（审批门禁不拦截管理员）
 *  3. 审批流开启时 operator 修复 → 202 转审批单（action_type = container.fix）
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let operatorToken = '';
const OP_USER = 'policy-fix-op';

function req(method: string, path: string, body?: any, token = adminToken): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
  assert.ok(adminToken, '管理员登录失败');

  await req('POST', '/api/system/users', { username: OP_USER, password: 'op-test-8888', role: 'operator' });
  const opLogin = await req('POST', '/api/auth/login', { username: OP_USER, password: 'op-test-8888' });
  operatorToken = opLogin.data.token;
  assert.ok(operatorToken, 'operator 登录失败');
});

after(async () => {
  await req('DELETE', '/api/settings/approvals.enabled');
  await req('DELETE', `/api/system/users/${OP_USER}`);
  // 清理本文件产生的审批记录
  const { DatabaseSync } = await import('node:sqlite');
  const path = await import('node:path');
  const db = new DatabaseSync(path.default.join(__dirname, '../../data/docker-manager.db'));
  db.exec('PRAGMA busy_timeout = 30000;');
  db.prepare("DELETE FROM approvals WHERE target LIKE 'policy-fix-%'").run();
  db.close();
});

test('不可自动修复的规则返回 400', async () => {
  const r = await req('POST', '/api/policy/fix', { containerId: 'policy-fix-nope', ruleId: 'no-privileged' });
  assert.strictEqual(r.status, 400);
  assert.ok(String(r.data.error).includes('不支持自动修复'));
});

test('缺少参数返回 400', async () => {
  const noContainer = await req('POST', '/api/policy/fix', { ruleId: 'mem-limit' });
  assert.strictEqual(noContainer.status, 400);
  const noRule = await req('POST', '/api/policy/fix', { containerId: 'policy-fix-nope' });
  assert.strictEqual(noRule.status, 400);
});

test('管理员直接修复不存在的容器：404（门禁不拦截管理员）', async () => {
  await req('PUT', '/api/settings/approvals.enabled', { value: true });
  const r = await req('POST', '/api/policy/fix', { containerId: 'policy-fix-missing', ruleId: 'mem-limit' });
  assert.strictEqual(r.status, 404);
});

test('审批流开启时 operator 修复转审批单（container.fix）', async () => {
  await req('PUT', '/api/settings/approvals.enabled', { value: true });
  const r = await req('POST', '/api/policy/fix', { containerId: 'policy-fix-gate-target', ruleId: 'restart-policy' }, operatorToken);
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.data.approvalPending, true);
  assert.ok(r.data.approvalId > 0);

  const list = await req('GET', '/api/approvals?status=pending');
  const row = list.data.items.find((x: any) => x.id === r.data.approvalId);
  assert.ok(row, '审批记录应存在');
  assert.strictEqual(row.action_type, 'container.fix');
  assert.strictEqual(row.username, OP_USER);
});

test('审批流关闭时 operator 直接修复：404（容器不存在）', async () => {
  await req('DELETE', '/api/settings/approvals.enabled');
  const r = await req('POST', '/api/policy/fix', { containerId: 'policy-fix-missing', ruleId: 'mem-limit' }, operatorToken);
  assert.strictEqual(r.status, 404);
});
