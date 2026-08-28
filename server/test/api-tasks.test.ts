/**
 * 定时任务 API 集成测试
 *
 * 覆盖任务 CRUD、手动执行、日志查询、cron 预览。
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let testTaskId = '';

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

test('GET /api/tasks: 返回任务列表', async () => {
  const res = await req('GET', '/api/tasks', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/tasks: 创建定时任务', async () => {
  const res = await req('POST', '/api/tasks', {
    name: `test-task-${Date.now()}`,
    type: 'prune',
    cron: '0 2 * * *',
    enabled: false,
    config: { images: true },
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 201);
  if (res.data?.id) testTaskId = res.data.id;
});

test('PUT /api/tasks/:id: 更新任务', async () => {
  if (!testTaskId) return;
  const res = await req('PUT', `/api/tasks/${testTaskId}`, { name: 'updated-task' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/tasks/:id/run: 手动执行任务', async () => {
  if (!testTaskId) return;
  const res = await req('POST', `/api/tasks/${testTaskId}/run`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500);
});

test('GET /api/tasks/logs: 查询执行日志', async () => {
  const res = await req('GET', '/api/tasks/logs', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('GET /api/tasks/logs/export: 导出日志', async () => {
  const res = await req('GET', '/api/tasks/logs/export', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 204);
});

test('GET /api/tasks/cron-preview: Cron 预览', async () => {
  const res = await req('GET', '/api/tasks/cron-preview?cron=0+2+*+*+*', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/tasks/:id/enable: 启用任务', async () => {
  if (!testTaskId) return;
  const res = await req('POST', `/api/tasks/${testTaskId}/enable`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500);
});

test('DELETE /api/tasks/:id: 删除任务', async () => {
  if (!testTaskId) return;
  const res = await req('DELETE', `/api/tasks/${testTaskId}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 204);
});

test('POST /api/tasks: 缺少必填字段返回 400', async () => {
  const res = await req('POST', '/api/tasks', { name: 'no-type' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400);
});

test('GET /api/tasks: 未登录返回 401', async () => {
  const res = await req('GET', '/api/tasks');
  assert.strictEqual(res.status, 401);
});

test('baselineScan: 创建并手动执行安全基线扫描任务', async () => {
  // 清掉上次运行可能残留的快照，让本用例从首扫状态开始
  await req('DELETE', '/api/settings/baseline.lastScan', undefined, { Authorization: `Bearer ${adminToken}` });

  const create = await req('POST', '/api/tasks', {
    name: `test-baseline-scan-${Date.now()}`,
    type: 'baselineScan',
    cron: '0 4 * * *',
    enabled: false,
    config: { severityMin: 'warn', onlyOnNew: true, notify: false },
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(create.status === 200 || create.status === 201);
  const id = create.data?.id;
  if (!id) return;

  try {
    // 首扫：快照为空，所有关注级违规都算"新增"
    const run = await req('POST', `/api/tasks/${id}/run`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(run.status === 200, `手动执行应返回 200，实际 ${run.status}`);
    assert.strictEqual(run.data?.ok, true);
    assert.ok(String(run.data?.detail || '').includes('扫描'), '执行详情应包含扫描摘要');

    // 第二次执行：容器状态未变，快照对比后新增应为 0
    const run2 = await req('POST', `/api/tasks/${id}/run`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(run2.status === 200);
    assert.ok(String(run2.data?.detail || '').includes('新增 0 项'), '第二次扫描不应有新增违规');
  } finally {
    await req('DELETE', `/api/tasks/${id}`, undefined, { Authorization: `Bearer ${adminToken}` });
    // 还原快照键，避免影响其它用例
    await req('DELETE', '/api/settings/baseline.lastScan', undefined, { Authorization: `Bearer ${adminToken}` });
  }
});
