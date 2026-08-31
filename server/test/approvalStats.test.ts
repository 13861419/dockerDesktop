/**
 * 审批统计单元测试
 *
 * 覆盖 getApprovalStats：状态汇总、执行质量、按动作类型与提交人分布、天数窗口
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-approvalstats-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { getApprovalStats, listAllApprovals, renderApprovalsCsv } from '../src/approvals';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

/** 直接插入审批行（insertion 顺序与 created_at 单调一致） */
function insertApproval(username: string, actionType: string, status: string, createdAt: number, result = '') {
  getDb()
    .prepare('INSERT INTO approvals (username, action_type, target, payload, status, reason, result, created_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(username, actionType, 'target-x', '{}', status, 'test', result, createdAt, status === 'pending' ? null : createdAt, status === 'pending' ? null : 'admin');
}

before(() => {
  const now = Date.now();
  insertApproval('alice', 'container.delete', 'approved', now - 1000, '执行成功：容器 target-x 已删除');
  insertApproval('alice', 'container.delete', 'approved', now - 2000, '执行失败：no such container');
  insertApproval('alice', 'image.delete', 'rejected', now - 3000);
  insertApproval('bob', 'container.delete', 'pending', now - 4000);
  insertApproval('bob', 'volume.delete', 'cancelled', now - 5000, '提交人撤销');
  // 40 天前的旧记录：默认 30 天窗口外
  insertApproval('alice', 'image.prune', 'approved', now - 40 * 86400_000, '执行成功');
});

test('getApprovalStats: 状态汇总与执行质量', () => {
  const s = getApprovalStats(30);
  assert.strictEqual(s.totals.total, 5);
  assert.strictEqual(s.totals.pending, 1);
  assert.strictEqual(s.totals.approved, 2);
  assert.strictEqual(s.totals.rejected, 1);
  assert.strictEqual(s.totals.cancelled, 1);
  assert.strictEqual(s.totals.executedOk, 1);
  assert.strictEqual(s.totals.executedFail, 1);
});

test('getApprovalStats: 按动作类型分布（附中文名）', () => {
  const s = getApprovalStats(30);
  const cd = s.byAction.find((a) => a.actionType === 'container.delete');
  assert.ok(cd);
  assert.strictEqual(cd.label, '删除容器');
  // alice 2 条（1 成 1 败）+ bob 1 条 pending
  assert.strictEqual(cd.total, 3);
  assert.strictEqual(cd.approved, 2);
  assert.strictEqual(cd.pending, 1);
  const im = s.byAction.find((a) => a.actionType === 'image.delete');
  assert.strictEqual(im!.rejected, 1);
});

test('getApprovalStats: 按提交人分布', () => {
  const s = getApprovalStats(30);
  const alice = s.byUser.find((u) => u.username === 'alice');
  assert.strictEqual(alice!.total, 3);
  const bob = s.byUser.find((u) => u.username === 'bob');
  assert.strictEqual(bob!.total, 2);
  assert.strictEqual(bob!.pending, 1);
});

test('getApprovalStats: 天数窗口过滤旧记录', () => {
  const s = getApprovalStats(30);
  assert.ok(!s.byAction.some((a) => a.actionType === 'image.prune'));
  // 收窄到 1 天：只剩 3 条最近的
  const narrow = getApprovalStats(1);
  assert.strictEqual(narrow.totals.total, 5);
});

test('renderApprovalsCsv: 表头、行数与字段转义', () => {
  // 含逗号/引号的 result 字段应被双引号包裹转义
  getDb()
    .prepare('INSERT INTO approvals (username, action_type, target, payload, status, reason, result, created_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('carol', 'image.delete', 'nginx', '{}', 'approved', 'test', '执行成功：已删除, 版本 "v1"', Date.now(), Date.now(), 'admin');
  const rows = listAllApprovals();
  assert.ok(rows.length >= 6);
  const csv = renderApprovalsCsv(rows);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('提交人,动作类型,目标,状态'));
  // 含逗号/引号的 result 应被双引号包裹且内部引号翻倍
  assert.ok(csv.includes('"执行成功：已删除, 版本 ""v1"""'));
  // 状态过滤
  const pendingOnly = listAllApprovals(undefined, 'pending');
  assert.ok(pendingOnly.every((r) => r.status === 'pending'));
});
