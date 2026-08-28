/**
 * 高危操作审批流 API 集成测试
 *
 * 覆盖：
 *  1. 管理员开启 approvals.enabled 后，operator 删除容器转为 202 待审批
 *  2. 审批列表按角色过滤（admin 全部 / operator 仅自己）
 *  3. 同一提交人对同一动作+目标去重
 *  4. operator 不能批准（403）；admin 批准后执行（目标不存在则记录执行失败）
 *  5. 拒绝与撤销路径
 *  6. 关闭审批流后恢复直接执行
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let operatorToken = '';
const OP_USER = 'approval-test-op';

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

  // 创建 operator 测试账号（存在则忽略）
  await req('POST', '/api/system/users', { username: OP_USER, password: 'op-test-8888', role: 'operator' });
  const opLogin = await req('POST', '/api/auth/login', { username: OP_USER, password: 'op-test-8888' });
  operatorToken = opLogin.data.token;
  assert.ok(operatorToken, 'operator 登录失败');
});

after(async () => {
  // 恢复设置默认值并清理测试账号
  await req('DELETE', '/api/settings/approvals.enabled');
  await req('DELETE', `/api/system/users/${OP_USER}`);
});

test('开启审批流后 operator 删除容器转为 202 待审批', async () => {
  await req('PUT', '/api/settings/approvals.enabled', { value: true });
  const r = await req('DELETE', '/api/containers/approval-test-no-such-container', undefined, operatorToken);
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.data.approvalPending, true);
  assert.ok(r.data.approvalId > 0);
});

test('提交去重：同人对同动作同目标复用待审批记录', async () => {
  const first = await req('POST', '/api/approvals', { actionType: 'container.delete', target: 'dup-target', payload: { force: true } }, operatorToken);
  assert.strictEqual(first.status, 201);
  const second = await req('POST', '/api/approvals', { actionType: 'container.delete', target: 'dup-target' }, operatorToken);
  assert.strictEqual(second.status, 201);
  assert.strictEqual(second.data.id, first.data.id);
  assert.strictEqual(second.data.reused, true);
});

test('列表按角色过滤：operator 仅见自己的提交', async () => {
  const opList = await req('GET', '/api/approvals', undefined, operatorToken);
  assert.strictEqual(opList.status, 200);
  assert.strictEqual(opList.data.isAdmin, false);
  assert.ok(opList.data.items.length > 0);
  assert.ok(opList.data.items.every((x: any) => x.username === OP_USER));

  const adminList = await req('GET', '/api/approvals', undefined, adminToken);
  assert.strictEqual(adminList.data.isAdmin, true);
  assert.ok(adminList.data.items.length >= opList.data.items.length);
});

test('operator 不能批准审批（403）', async () => {
  const list = await req('GET', '/api/approvals?status=pending', undefined, operatorToken);
  const item = list.data.items[0];
  const r = await req('POST', `/api/approvals/${item.id}/approve`, {}, operatorToken);
  assert.strictEqual(r.status, 403);
});

test('admin 批准后执行不存在的目标：状态 approved 且记录执行失败', async () => {
  const submit = await req('POST', '/api/approvals', { actionType: 'container.delete', target: 'no-such-container-xyz' }, operatorToken);
  const approve = await req('POST', `/api/approvals/${submit.data.id}/approve`, {});
  assert.strictEqual(approve.status, 200);
  assert.strictEqual(approve.data.ok, true);
  assert.strictEqual(approve.data.executed, false);
  assert.ok(approve.data.error, '应记录执行错误');

  const list = await req('GET', '/api/approvals', undefined, adminToken);
  const row = list.data.items.find((x: any) => x.id === submit.data.id);
  assert.strictEqual(row.status, 'approved');
  assert.ok(row.result.includes('执行失败'));
});

test('拒绝路径：admin 拒绝后状态为 rejected', async () => {
  const submit = await req('POST', '/api/approvals', { actionType: 'volume.delete', target: 'no-such-volume-xyz' }, operatorToken);
  const reject = await req('POST', `/api/approvals/${submit.data.id}/reject`, { reason: '测试拒绝' });
  assert.strictEqual(reject.status, 200);
  const list = await req('GET', '/api/approvals', undefined, adminToken);
  const row = list.data.items.find((x: any) => x.id === submit.data.id);
  assert.strictEqual(row.status, 'rejected');
});

test('撤销路径：提交人可撤销自己的待审批，不能撤销他人', async () => {
  const submit = await req('POST', '/api/approvals', { actionType: 'container.delete', target: 'cancel-target' }, operatorToken);
  const cancel = await req('DELETE', `/api/approvals/${submit.data.id}`, undefined, operatorToken);
  assert.strictEqual(cancel.status, 200);
  const list = await req('GET', '/api/approvals', undefined, operatorToken);
  const row = list.data.items.find((x: any) => x.id === submit.data.id);
  assert.strictEqual(row.status, 'cancelled');

  // admin 提交一条，operator 无权撤销
  const adminSubmit = await req('POST', '/api/approvals', { actionType: 'container.delete', target: 'admin-target' });
  const opCancel = await req('DELETE', `/api/approvals/${adminSubmit.data.id}`, undefined, operatorToken);
  assert.strictEqual(opCancel.status, 403);
});

test('审批流开启时批量删除转为待审批，不直接执行', async () => {
  const r = await req('POST', '/api/containers/batch/delete', { ids: ['batch-gate-a', 'batch-gate-b'], force: true }, operatorToken);
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.data.approvalPending, true);
  assert.ok(Array.isArray(r.data.approvalIds) && r.data.approvalIds.length === 2);

  // 同一批重复提交：同人同目标去重，复用已有记录
  const again = await req('POST', '/api/containers/batch/delete', { ids: ['batch-gate-a'] }, operatorToken);
  assert.strictEqual(again.status, 202);
  assert.strictEqual(again.data.approvalIds.length, 1);
  assert.strictEqual(again.data.approvalIds[0], r.data.approvalIds[0]);

  // 列表项应带展示用目标标签（目标不存在时回退短 ID / 原名）
  const list = await req('GET', '/api/approvals', undefined, adminToken);
  const row = list.data.items.find((x: any) => x.id === r.data.approvalIds[0]);
  assert.ok(row, '审批记录应存在');
  assert.strictEqual(typeof row.target_label, 'string');
  assert.ok(row.target_label.length > 0);
});

test('待审批超过 TTL 自动过期（approvals.ttlHours）', async () => {
  // 清理历史运行残留的同目标记录，避免去重逻辑干扰本用例
  const { DatabaseSync } = await import('node:sqlite');
  const path = await import('node:path');
  const db = new DatabaseSync(path.default.join(__dirname, '../../data/docker-manager.db'), {}, { timeout: 10000 });
  db.prepare("DELETE FROM approvals WHERE target = 'ttl-test-target'").run();

  await req('PUT', '/api/settings/approvals.enabled', { value: true });
  const r = await req('DELETE', '/api/containers/ttl-test-target', undefined, operatorToken);
  assert.strictEqual(r.status, 202);

  // 直接回填 created_at 到 4 天前（默认 TTL 72 小时），再查列表触发惰性过期
  db.prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(
    Date.now() - 4 * 86400_000,
    r.data.approvalId,
  );
  db.close();

  const list = await req('GET', '/api/approvals', undefined, adminToken);
  const row = list.data.items.find((x: any) => x.id === r.data.approvalId);
  assert.ok(row, '审批记录应存在');
  assert.strictEqual(row.status, 'cancelled');
  assert.ok(String(row.result).includes('超时'));

  // 过期后重新提交同目标：应生成新记录而非复用已过期记录
  const again = await req('DELETE', '/api/containers/ttl-test-target', undefined, operatorToken);
  assert.strictEqual(again.status, 202);
  assert.notStrictEqual(again.data.approvalId, r.data.approvalId);
  assert.strictEqual(again.data.reused, false);

  await req('DELETE', '/api/settings/approvals.enabled', undefined, adminToken);
});

test('关闭审批流后恢复直接执行（不再 202）', async () => {
  await req('DELETE', '/api/settings/approvals.enabled');
  const r = await req('DELETE', '/api/containers/approval-test-no-such-container', undefined, operatorToken);
  assert.notStrictEqual(r.status, 202);
});
