/**
 * 操作审计日志单元测试
 *
 * 覆盖：
 *  1. logOperation：写入日志
 *  2. listOperationLogs：分页查询、过滤
 *  3. clearOperationLogs：清空日志
 *  4. exportOperationLogsCsv：CSV 导出
 *  5. exportOperationLogsJson：JSON 导出
 *  6. summarizeOperationLogs：统计汇总
 *  7. summarizeOperationLogsByUser：按用户统计
 *  8. summarizeOperationLogsTrend：按天趋势统计
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-oplog-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import {
  logOperation,
  listOperationLogs,
  clearOperationLogs,
  exportOperationLogsCsv,
  exportOperationLogsJson,
  summarizeOperationLogs,
  summarizeOperationLogsByUser,
  summarizeOperationLogsTrend,
} from '../src/operationLog';

before(() => {
  initStorage();
  clearOperationLogs();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('logOperation: 写入日志后可查询', () => {
  logOperation('admin', '测试操作', 'container', 'test-container');
  const result = listOperationLogs();
  assert.ok(result.total >= 1, '应至少有 1 条日志');
  const last = result.items[0];
  assert.strictEqual(last.username, 'admin');
  assert.strictEqual(last.action, '测试操作');
  assert.strictEqual(last.targetType, 'container');
  assert.strictEqual(last.targetName, 'test-container');
});

test('logOperation: 支持 detail 和 success 参数', () => {
  logOperation('admin', '带详情操作', 'image', 'nginx', '操作详情', false);
  const result = listOperationLogs({ targetType: 'image' });
  const item = result.items.find(i => i.targetName === 'nginx');
  assert.ok(item);
  assert.strictEqual(item!.success, false);
  assert.strictEqual(item!.detail, '操作详情');
});

test('listOperationLogs: 分页参数', () => {
  clearOperationLogs();
  for (let i = 0; i < 20; i++) {
    logOperation('admin', `操作${i}`, 'container', `ctr-${i}`);
  }
  const page1 = listOperationLogs({ page: 1, pageSize: 5 });
  assert.strictEqual(page1.items.length, 5);
  assert.strictEqual(page1.total, 20);
  const page2 = listOperationLogs({ page: 2, pageSize: 5 });
  assert.strictEqual(page2.items.length, 5);
  // 第二页的 id 应大于第一页
  assert.ok(page2.items[0].id < page1.items[0].id, '按时间倒序');
});

test('listOperationLogs: 过滤 username', () => {
  clearOperationLogs();
  logOperation('admin', 'admin操作', 'container');
  logOperation('user1', 'user1操作', 'container');
  const result = listOperationLogs({ username: 'admin' });
  assert.ok(result.items.every(i => i.username === 'admin'));
});

test('listOperationLogs: 过滤 targetType', () => {
  clearOperationLogs();
  logOperation('admin', '容器操作', 'container');
  logOperation('admin', '镜像操作', 'image');
  const result = listOperationLogs({ targetType: 'container' });
  assert.ok(result.items.every(i => i.targetType === 'container'));
});

test('listOperationLogs: 过滤 success', () => {
  clearOperationLogs();
  logOperation('admin', '成功操作', 'container', undefined, undefined, true);
  logOperation('admin', '失败操作', 'container', undefined, undefined, false);
  const okResult = listOperationLogs({ success: true });
  assert.ok(okResult.items.every(i => i.success === true));
  const failResult = listOperationLogs({ success: false });
  assert.ok(failResult.items.every(i => i.success === false));
});

test('clearOperationLogs: 清空后 total 为 0', () => {
  logOperation('admin', '待清理', 'container');
  clearOperationLogs();
  const result = listOperationLogs();
  assert.strictEqual(result.total, 0);
  assert.strictEqual(result.items.length, 0);
});

test('exportOperationLogsCsv: 返回 CSV 格式字符串', () => {
  clearOperationLogs();
  logOperation('admin', 'CSV测试', 'container', 'ctr1');
  const csv = exportOperationLogsCsv();
  assert.ok(typeof csv === 'string');
  assert.ok(csv.length > 0);
  // CSV 应有逗号分隔的字段
  assert.ok(csv.includes(','), 'CSV 应包含逗号分隔符');
  // 应包含日志内容
  assert.ok(csv.includes('CSV测试'), '应包含日志内容');
});

test('exportOperationLogsJson: 返回 JSON 数组字符串', () => {
  clearOperationLogs();
  logOperation('admin', 'JSON测试', 'image');
  const json = exportOperationLogsJson();
  assert.ok(typeof json === 'string');
  const arr = JSON.parse(json);
  assert.ok(Array.isArray(arr));
  assert.ok(arr.length >= 1);
  assert.strictEqual(arr[0].action, 'JSON测试');
});

test('summarizeOperationLogs: 返回统计结构', () => {
  clearOperationLogs();
  logOperation('admin', '统计测试1', 'container', undefined, undefined, true);
  logOperation('admin', '统计测试2', 'image', undefined, undefined, false);
  const stats = summarizeOperationLogs();
  assert.ok(typeof stats === 'object');
  assert.ok(typeof stats.total === 'number');
  assert.ok(Array.isArray(stats.byType));
  assert.ok(Array.isArray(stats.bySuccess));
  assert.ok(Array.isArray(stats.byAction));
  assert.ok(stats.total >= 2);
});

test('summarizeOperationLogsByUser: 按用户分组', () => {
  clearOperationLogs();
  logOperation('admin', '操作A', 'container');
  logOperation('admin', '操作B', 'container');
  logOperation('user1', '操作C', 'image');
  const byUser = summarizeOperationLogsByUser();
  assert.ok(Array.isArray(byUser));
  assert.ok(byUser.length >= 2, `应至少有 2 个用户分组，实际 ${byUser.length}`);
  // 每个分组应有 username 和 count
  for (const u of byUser) {
    assert.ok(typeof (u as any).username === 'string');
    assert.ok(typeof (u as any).count === 'number' || typeof (u as any).total === 'number');
  }
});

test('summarizeOperationLogsTrend: 按天趋势', () => {
  clearOperationLogs();
  logOperation('admin', '趋势测试', 'container');
  const trend = summarizeOperationLogsTrend();
  assert.ok(Array.isArray(trend));
  assert.ok(trend.length > 0, '应至少有 1 天的趋势数据');
  // 每个条目应有 date 和 count
  const first = trend[0] as any;
  assert.ok(first.date || first.day, '趋势条目应有 date 或 day 字段');
});
