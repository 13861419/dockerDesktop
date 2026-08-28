/**
 * 安全基线违规在线修复 API 集成测试
 *
 * 覆盖：
 *  1. 不可自动修复的规则返回 400
 *  2. 缺少参数返回 400
 *  3. 管理员直接修复不存在的容器 → 404（门禁不拦截管理员）
 *
 * 审批门禁相关用例（operator 202 转审批等）已并入 api-approvals.test.ts，
 * 避免两文件并行时互踩 approvals.enabled 设置。
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

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
  const r = await req('POST', '/api/policy/fix', { containerId: 'policy-fix-missing', ruleId: 'mem-limit' });
  assert.strictEqual(r.status, 404);
});
