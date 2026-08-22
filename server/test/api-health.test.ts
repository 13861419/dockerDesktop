/**
 * 健康体检 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/health-check：完整体检报告
 *  2. 响应结构：score、level、items 数组
 *  3. 每个 item 结构：key、title、level、message
 *  4. 评分范围 0-100
 *  5. 未登录返回 401
 *
 * 依赖：后端服务运行在 localhost:9528，Docker 引擎可用
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

test('GET /api/health-check: 返回完整体检报告', async () => {
  const res = await req('GET', '/api/health-check', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 200);
  assert.ok(typeof res.data.score === 'number', 'score 应为数字');
  assert.ok(res.data.score >= 0 && res.data.score <= 100, `score 应在 0-100，实际 ${res.data.score}`);
  assert.ok(['healthy', 'warning', 'danger'].includes(res.data.level), `level 应为 healthy/warning/danger，实际 ${res.data.level}`);
  assert.ok(Array.isArray(res.data.items), 'items 应为数组');
  assert.ok(res.data.items.length > 0, '应至少有 1 个体检条目');
});

test('GET /api/health-check: 每个 item 结构正确', async () => {
  const res = await req('GET', '/api/health-check', undefined, { Authorization: `Bearer ${adminToken}` });
  for (const item of res.data.items) {
    assert.ok(typeof item.key === 'string', 'item.key 应为字符串');
    assert.ok(typeof item.title === 'string', 'item.title 应为字符串');
    assert.ok(['healthy', 'warning', 'danger'].includes(item.level), `item.level 应为有效值，实际 ${item.level}`);
    assert.ok(typeof item.message === 'string', 'item.message 应为字符串');
  }
});

test('GET /api/health-check: 应包含 CPU/内存/磁盘条目', async () => {
  const res = await req('GET', '/api/health-check', undefined, { Authorization: `Bearer ${adminToken}` });
  const keys = res.data.items.map((i: any) => i.key);
  assert.ok(keys.includes('cpu'), '应包含 cpu 条目');
  assert.ok(keys.includes('memory'), '应包含 memory 条目');
  assert.ok(keys.includes('disk'), '应包含 disk 条目');
});

test('GET /api/health-check: 统计汇总字段存在', async () => {
  const res = await req('GET', '/api/health-check', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(typeof res.data.summary === 'object', 'summary 应为对象');
  // summary 包含资源计数
  assert.ok(typeof res.data.summary.containers === 'number');
  assert.ok(typeof res.data.summary.images === 'number');
  assert.ok(typeof res.data.summary.volumes === 'number');
  assert.ok(typeof res.data.summary.networks === 'number');
});

test('GET /api/health-check: 未登录返回 401', async () => {
  const res = await req('GET', '/api/health-check');
  assert.strictEqual(res.status, 401);
});

test('GET /api/health-check: 响应时间合理（<10s）', async () => {
  const start = Date.now();
  const res = await req('GET', '/api/health-check', undefined, { Authorization: `Bearer ${adminToken}` });
  const elapsed = Date.now() - start;
  assert.strictEqual(res.status, 200);
  assert.ok(elapsed < 10000, `响应时间 ${elapsed}ms 应小于 10s`);
});
