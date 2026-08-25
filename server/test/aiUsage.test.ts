/**
 * AI 用量统计模块（aiUsage）单元测试（node:test）
 * 覆盖：estimateTokens / recordAiUsage / summarizeAiUsage / listAiUsageByModel / listAiUsageByDay / clearAiUsage
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录（须在 import storage 前设置）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-aiusage-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, getDb, closeDb } from '../src/storage';
import {
  recordAiUsage,
  estimateTokens,
  summarizeAiUsage,
  listAiUsageByModel,
  listAiUsageByDay,
  clearAiUsage,
} from '../src/aiUsage';

before(() => {
  initStorage();
  clearAiUsage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('estimateTokens 中文/英文混合估算', () => {
  assert.strictEqual(estimateTokens(''), 0);
  assert.ok(estimateTokens('中文测试') >= 4);
  // 长英文按字符/token 估算
  const en = 'a'.repeat(8);
  assert.ok(estimateTokens(en) >= 2);
});

test('recordAiUsage + summarizeAiUsage 正确聚合', () => {
  clearAiUsage();
  recordAiUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150, model: 'gpt-4o-mini', provider: 'openai', username: 'admin' });
  recordAiUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300, model: 'deepseek', provider: 'deepseek' });
  recordAiUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, model: 'gpt-4o-mini', success: false, errorMessage: 'timeout' });

  const s = summarizeAiUsage();
  assert.strictEqual(s.totalCalls, 3);
  assert.strictEqual(s.successCalls, 2);
  assert.strictEqual(s.failedCalls, 1);
  assert.strictEqual(s.totalPrompt, 310);
  assert.strictEqual(s.totalCompletion, 155);
  assert.strictEqual(s.total, 465);

  const byModel = listAiUsageByModel();
  const gpt = byModel.find((m) => m.model === 'gpt-4o-mini');
  assert.ok(gpt);
  assert.strictEqual(gpt.calls, 2);
  assert.strictEqual(gpt.totalTokens, 165);
});

test('listAiUsageByDay 按天聚合（近 30 天含当天）', () => {
  clearAiUsage();
  recordAiUsage({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
  const byDay = listAiUsageByDay(30);
  assert.ok(byDay.length >= 1);
  const today = byDay[byDay.length - 1];
  assert.strictEqual(today.calls, 1);
  assert.strictEqual(today.totalTokens, 8);
});

test('clearAiUsage 清空全部记录', () => {
  recordAiUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  clearAiUsage();
  assert.strictEqual(summarizeAiUsage().totalCalls, 0);
});

test('recordAiUsage 异常输入不抛异常', () => {
  clearAiUsage();
  // 异常输入不阻断流程、不抛异常
  recordAiUsage({} as any);
  recordAiUsage({ model: 'x', promptTokens: -5 } as any);
  assert.doesNotThrow(() => recordAiUsage({ completionTokens: NaN } as any));
  // 负数被钳制为 0，仍写入成功记录
  assert.strictEqual(summarizeAiUsage().totalCalls, 2);
});
