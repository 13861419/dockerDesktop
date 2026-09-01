/**
 * 1.3.0 审批与协作单元测试：多级审批链 / 审批单编号 / 超时前提醒
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-approvalchain-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { getSetting, setSetting } from '../src/settings';
import { submitApproval, decideApproval, remindPendingApprovals, listApprovals } from '../src/approvals';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('approvalChain: 两级动作提交即固化级数并生成编号', () => {
  setSetting('approval.twoStepActions', 'container.delete');
  const { id, ticketNo } = submitApproval({
    username: 'dev1',
    actionType: 'container.delete',
    target: 'abc123',
    reason: '测试',
  });
  assert.ok(id > 0);
  assert.ok(ticketNo.startsWith('AP-'));
  assert.ok(ticketNo.endsWith(`-${id}`));
  const row = listApprovals().find((r) => r.id === id)!;
  assert.strictEqual(row.levels, 2);
  assert.strictEqual(row.level, 0);
  assert.strictEqual(row.ticket_no, ticketNo);
  // 单级动作：未列入 twoStepActions → levels=1
  const single = submitApproval({ username: 'dev1', actionType: 'image.delete', target: 'img:1', reason: '测试' });
  const row2 = listApprovals().find((r) => r.id === single.id)!;
  assert.strictEqual(row2.levels, 1);
  void getSetting;
});

test('approvalChain: 第一级 operator 可批、第二级须管理员', async () => {
  setSetting('approval.twoStepActions', 'container.delete');
  const { id } = submitApproval({ username: 'dev1', actionType: 'container.delete', target: 'abc123', reason: '测试' });
  // 第一级：operator 通过 → 推进级数，状态仍 pending
  const r1 = await decideApproval(id, 'approved', 'op1', undefined, 'operator');
  assert.strictEqual(r1.advanced, true);
  assert.strictEqual(r1.executed, false);
  const row = listApprovals().find((r) => r.id === id)!;
  assert.strictEqual(row.status, 'pending');
  assert.strictEqual(row.level, 1);
  // 第二级：operator → 403
  await assert.rejects(() => decideApproval(id, 'approved', 'op1', undefined, 'operator'), /需要管理员权限/);
  // 第二级：admin → 执行（Docker 不可达会执行失败，但审批状态应为 approved）
  const r2 = await decideApproval(id, 'approved', 'admin1', undefined, 'admin');
  assert.strictEqual(r2.advanced, undefined);
  const after = listApprovals().find((r) => r.id === id)!;
  assert.strictEqual(after.status, 'approved');
  assert.strictEqual(after.level, 2);
  // 轨迹包含两级签批人
  const decisions = JSON.parse(after.decisions || '[]');
  assert.strictEqual(decisions.length, 2);
  assert.strictEqual(decisions[0].by, 'op1');
  assert.strictEqual(decisions[1].by, 'admin1');
});

test('approvalChain: 单级动作 operator 直接签批即 403', async () => {
  const { id } = submitApproval({ username: 'dev2', actionType: 'volume.delete', target: 'vol1', reason: '测试' });
  await assert.rejects(() => decideApproval(id, 'approved', 'op1', undefined, 'operator'), /需要管理员权限/);
  // admin 正常签批
  await decideApproval(id, 'approved', 'admin1', undefined, 'admin');
  const row = listApprovals().find((r) => r.id === id)!;
  assert.strictEqual(row.status, 'approved');
});

test('approvalChain: 待审批超时前提醒一次', async () => {
  const db = getDb();
  const prevTtl = getSetting<number>('approvals.ttlHours');
  setSetting('approvals.ttlHours', 4);
  // 直接插入一条 3 小时前提交的待审批（超过 3/4 TTL）
  const created = Date.now() - 3 * 3600_000;
  const r = db
    .prepare(
      "INSERT INTO approvals (username, action_type, target, payload, status, reason, created_at, ticket_no) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
    )
    .run('dev3', 'image.delete', 'img:x', '{}', '提醒测试', created, 'AP-TEST-REMIND');
  const id = Number(r.lastInsertRowid);
  const n1 = remindPendingApprovals();
  assert.ok(n1 >= 1);
  const row = db.prepare('SELECT reminded FROM approvals WHERE id = ?').get(id) as { reminded: number };
  assert.strictEqual(row.reminded, 1);
  // 第二轮不再提醒
  const n2 = remindPendingApprovals();
  assert.strictEqual(n2, 0);
  setSetting('approvals.ttlHours', prevTtl ?? 0);
});
