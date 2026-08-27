/**
 * AI 使用周报模块（aiWeeklyReport）单元测试（node:test）
 * 覆盖：buildWeeklyReport 纯函数
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录（须在 import storage 前设置）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-aiweekly-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { buildWeeklyReport } from '../src/aiWeeklyReport';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('buildWeeklyReport 生成含汇总/模型/用户的周报', () => {
  const report = buildWeeklyReport({
    byDay: [
      { day: '2026-08-25', calls: 10, totalTokens: 1500, cost: 0.02 },
      { day: '2026-08-26', calls: 5, totalTokens: 800, cost: 0.01 },
    ],
    byModel: [
      { model: 'gpt-4o-mini', calls: 10, totalTokens: 1500 },
      { model: 'deepseek-chat', calls: 5, totalTokens: 800 },
    ],
    chatStats: [
      { username: 'admin', totalMessages: 8, totalTokens: 1200, totalCost: 0.015, avgTokensPerCall: 150, lastActiveAt: Date.now() },
    ],
  });
  assert.ok(report.includes('AI 使用周报'));
  assert.ok(report.includes('总调用: 15 次'));
  assert.ok(report.includes('2,300'));
  assert.ok(report.includes('$0.0300'));
  assert.ok(report.includes('gpt-4o-mini: 10 次（67%）'));
  assert.ok(report.includes('admin: 8 次调用'));
});

test('buildWeeklyReport 空数据不抛异常', () => {
  const report = buildWeeklyReport({ byDay: [], byModel: [], chatStats: [] });
  assert.ok(report.includes('本周暂无 AI 调用记录'));
  assert.ok(report.includes('总调用: 0 次'));
});
