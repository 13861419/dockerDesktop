/**
 * 1.6.0 K8s 写操作审批集成单测：GATE_ACTIONS 注册、门禁判定、执行器注册
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-k8sapproval-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { setSetting } from '../src/settings';
import { GATE_ACTIONS, shouldGate, hasExecutor, submitApproval, listApprovals } from '../src/approvals';
import { ensureBuiltinRoles, hasPermission } from '../src/rbac';

before(() => {
  initStorage();
  ensureBuiltinRoles();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('k8sApproval: GATE_ACTIONS 注册三个 K8s 动作', () => {
  assert.ok('k8s.pod.delete' in GATE_ACTIONS);
  assert.ok(GATE_ACTIONS['k8s.deployment.scale']);
  assert.ok(GATE_ACTIONS['k8s.deployment.restart']);
  // 执行器与动作一一注册
  assert.ok(hasExecutor('k8s.pod.delete'));
  assert.ok(hasExecutor('k8s.deployment.scale'));
  assert.ok(hasExecutor('k8s.deployment.restart'));
});

test('k8sApproval: 1.17.0 新动作注册（回滚/扩容/重建）', () => {
  setSetting('approvals.enabled', true);
  assert.ok('k8s.deployment.rollback' in GATE_ACTIONS);
  assert.ok('k8s.pvc.resize' in GATE_ACTIONS);
  assert.ok('k8s.pod.recreate' in GATE_ACTIONS);
  // 权限映射：rollback/resize → k8s.write，recreate → k8s.delete
  assert.strictEqual(shouldGate('operator', 'k8s.deployment.rollback'), false);
  assert.strictEqual(shouldGate('operator', 'k8s.pvc.resize'), false);
  assert.strictEqual(shouldGate('operator', 'k8s.pod.recreate'), true);
});

test('k8sApproval: 1.19.0 新动作注册（CM/Secret 编辑 + STS/DS 重启）', () => {
  setSetting('approvals.enabled', true);
  assert.ok('k8s.configmap.edit' in GATE_ACTIONS);
  assert.ok('k8s.secret.edit' in GATE_ACTIONS);
  assert.ok('k8s.sts.restart' in GATE_ACTIONS);
  assert.ok('k8s.ds.restart' in GATE_ACTIONS);
  assert.ok(hasExecutor('k8s.configmap.edit'));
  assert.ok(hasExecutor('k8s.secret.edit'));
  assert.ok(hasExecutor('k8s.sts.restart'));
  assert.ok(hasExecutor('k8s.ds.restart'));
  // 权限映射：CM/Secret 编辑与 STS/DS 重启 → k8s.write（operator 放行）
  assert.strictEqual(shouldGate('operator', 'k8s.configmap.edit'), false);
  assert.strictEqual(shouldGate('operator', 'k8s.secret.edit'), false);
  assert.strictEqual(shouldGate('operator', 'k8s.sts.restart'), false);
  assert.strictEqual(shouldGate('operator', 'k8s.ds.restart'), false);
  assert.strictEqual(shouldGate('admin', 'k8s.configmap.edit'), false);
});

test('k8sApproval: admin 放行、operator 持 k8s.write 放行 scale、user 被拦截', () => {
  setSetting('approvals.enabled', true);
  // admin 恒放行
  assert.strictEqual(shouldGate('admin', 'k8s.pod.delete'), false);
  // operator 内置含 k8s.write：scale/restart 放行
  assert.strictEqual(shouldGate('operator', 'k8s.deployment.scale'), false);
  assert.strictEqual(shouldGate('operator', 'k8s.deployment.restart'), false);
  // operator 无 k8s.delete：删除 Pod 拦截
  assert.strictEqual(shouldGate('operator', 'k8s.pod.delete'), true);
  // 无权限角色全部拦截
  assert.strictEqual(shouldGate('user', 'k8s.deployment.scale'), true);
  assert.strictEqual(shouldGate('user', 'k8s.pod.delete'), true);
});

test('k8sApproval: 提交 k8s 审批单并生成单号与执行器', async () => {
  const { submitApproval: submit, decideApproval: decide } = await import('../src/approvals');
  const { id, ticketNo } = submit({
    username: 'dev2',
    actionType: 'k8s.pod.delete',
    target: 'default/nginx-1',
    payload: {},
    reason: '测试',
  });
  assert.ok(id > 0);
  assert.ok(ticketNo.startsWith('AP-'));
  const row = listApprovals().find((r) => r.id === id)!;
  assert.strictEqual(row.action_type, 'k8s.pod.delete');
  assert.strictEqual(row.status, 'pending');
  // 审批通过触发执行器：无集群环境执行会失败，但状态流转应为 approved
  const r = await decide(id, 'approved', 'boss', undefined, 'admin');
  assert.strictEqual(r.advanced, undefined);
  const after = listApprovals().find((r) => r.id === id)!;
  assert.strictEqual(after.status, 'approved');
  void hasExecutor;
});

test('k8sApproval: rbac 增量合并为存量 operator 补 k8s.write', () => {
  // ensureBuiltinRoles 幂等重跑后 operator 应持有 k8s.write
  assert.strictEqual(hasPermission('operator', 'k8s.write'), true);
  // admin 名恒全权
  assert.strictEqual(hasPermission('admin', 'k8s.delete'), true);
});
