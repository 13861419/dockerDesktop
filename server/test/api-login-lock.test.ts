/**
 * 登录失败保护 API 集成测试（1.43.0）
 *
 * 覆盖：不存在的用户名连续失败达到阈值后返回 429 锁定（内存 + IP 维度）。
 * 注意：本文件必须位于 test:api 清单末尾执行（失败登录会累积测试机来源 IP 计数）。
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

function tryLogin(username: string, password: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/auth/login', BASE);
    const r = http.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, data: {} });
          }
        });
      },
    );
    r.on('error', reject);
    r.write(JSON.stringify({ username, password }));
    r.end();
  });
}

before(async () => {
  const ok = await tryLogin('admin', 'admin888');
  if (ok.status !== 200) throw new Error('admin 登录失败，环境未就绪');
  adminToken = ok.data.token;
});

test('login-lock：不存在的用户连续失败达到阈值后锁定', async () => {
  const user = 'e2e-lock-' + Date.now();
  // 前 4 次返回 401（用户名或密码错误，未锁定）
  for (let i = 0; i < 4; i++) {
    const r = await tryLogin(user, 'definitely-wrong-' + Date.now());
    assert.equal(r.status, 401, `第 ${i + 1} 次失败应为 401`);
    assert.equal(r.data.locked, false);
  }
  // 第 5 次达到阈值：仍返回 401 但提示已触发锁定
  const r5 = await tryLogin(user, 'definitely-wrong-' + Date.now());
  assert.equal(r5.status, 401);
  assert.equal(r5.data.locked, true, '第 5 次失败应触发锁定提示');
  // 第 6 次直接 429（未验密码即拒绝）
  const r6 = await tryLogin(user, 'definitely-wrong-' + Date.now());
  assert.equal(r6.status, 429, '锁定期间应返回 429');
  assert.equal(r6.data.locked, true);
  assert.ok(Number(r6.data.remaining) > 0, '返回剩余锁定秒数');
  void adminToken;
});
