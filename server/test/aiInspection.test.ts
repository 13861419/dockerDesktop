/**
 * AI 定时巡检模块（aiInspection）单元测试（node:test）
 * 覆盖：buildInspectionPrompt / snapshotHasAbnormal / saveInspection / listInspections / getInspection / deleteInspection
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录（须在 import storage 前设置）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-aiinsp-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import {
  buildInspectionPrompt,
  snapshotHasAbnormal,
  saveInspection,
  listInspections,
  getInspection,
  deleteInspection,
} from '../src/aiInspection';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('buildInspectionPrompt 包含快照内容', () => {
  const prompt = buildInspectionPrompt('- web: nginx | 状态: running');
  assert.ok(prompt.includes('- web: nginx | 状态: running'));
  assert.ok(prompt.includes('巡检'));
});

test('snapshotHasAbnormal 识别异常状态', () => {
  assert.strictEqual(snapshotHasAbnormal('- a | 状态: running | 详情: Up 1h'), false);
  assert.strictEqual(snapshotHasAbnormal('- b | 状态: exited | 详情: Exited (0)'), true);
  assert.strictEqual(snapshotHasAbnormal('- c | 状态: running | 详情: Up, unhealthy'), true);
  assert.strictEqual(snapshotHasAbnormal('- d | 状态: restarting | 详情: Restarting'), true);
});

test('saveInspection + listInspections + getInspection 读写', () => {
  const id1 = saveInspection(0, '一切正常', 'snapshot-1');
  const id2 = saveInspection(1, '发现异常容器', 'snapshot-2');
  assert.ok(id1 > 0 && id2 > id1);

  const list = listInspections(10);
  assert.ok(list.length >= 2);
  // 倒序：最新在前
  assert.strictEqual(list[0].id, id2);

  const got = getInspection(id2);
  assert.ok(got);
  assert.strictEqual(got!.status, 1);
  assert.strictEqual(got!.summary, '发现异常容器');
  assert.strictEqual(got!.snapshot, 'snapshot-2');
});

test('deleteInspection 删除记录', () => {
  const id = saveInspection(0, '待删除', 'snap');
  assert.strictEqual(deleteInspection(id), true);
  assert.strictEqual(getInspection(id), null);
  // 重复删除返回 false
  assert.strictEqual(deleteInspection(id), false);
});
