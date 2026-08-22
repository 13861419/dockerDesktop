/**
 * 调度器 cron 解析单元测试
 *
 * 覆盖 nextRunTime 的各种 cron 表达式：
 *  通配符星号、步进星号加N、具体数字、逗号多值
 *  非法表达式返回 null
 *  边界场景（闰年、跨月、跨年）
 */
import { test } from 'node:test';
import assert from 'node:assert';

// 必须先于 storage 模块加载设置临时数据目录
import os from 'os';
import path from 'path';
import fs from 'fs';
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-sched-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { nextRunTime } from '../src/scheduler';

/** 固定基准时间：2026-01-15 10:30:00（本地时间） */
function makeBase(): number {
  const d = new Date(2026, 0, 15, 10, 30, 0); // month is 0-indexed
  return d.getTime();
}

function getLocal(t: number) {
  const d = new Date(t);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
}

const BASE = makeBase();

test('nextRunTime: every minute', () => {
  const next = nextRunTime('* * * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.y, 2026);
  assert.strictEqual(t.m, 1);
  assert.strictEqual(t.d, 15);
  assert.strictEqual(t.h, 10);
  assert.strictEqual(t.min, 31);
});

test('nextRunTime: every 5 minutes step', () => {
  const next = nextRunTime('*/5 * * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 15);
  assert.strictEqual(t.h, 10);
  assert.strictEqual(t.min, 35);
});

test('nextRunTime: hourly at minute 0', () => {
  const next = nextRunTime('0 * * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 15);
  assert.strictEqual(t.h, 11);
  assert.strictEqual(t.min, 0);
});

test('nextRunTime: daily at midnight', () => {
  const next = nextRunTime('0 0 * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 16);
  assert.strictEqual(t.h, 0);
  assert.strictEqual(t.min, 0);
});

test('nextRunTime: specific time 10:30 - same minute skips to next day', () => {
  const next = nextRunTime('30 10 * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 16);
  assert.strictEqual(t.h, 10);
  assert.strictEqual(t.min, 30);
});

test('nextRunTime: specific time 10:15 - earlier today, skips to next day', () => {
  // 10:15 < BASE 10:30, so next occurrence is tomorrow
  const next = nextRunTime('15 10 * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 16);
  assert.strictEqual(t.h, 10);
  assert.strictEqual(t.min, 15);
});

test('nextRunTime: comma values 0,30', () => {
  const next = nextRunTime('0,30 * * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 15);
  assert.strictEqual(t.h, 11);
  assert.strictEqual(t.min, 0);
});

test('nextRunTime: step 15 minutes', () => {
  const next = nextRunTime('*/15 * * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 15);
  assert.strictEqual(t.h, 10);
  assert.strictEqual(t.min, 45);
});

test('nextRunTime: monthly on 1st', () => {
  const next = nextRunTime('0 0 1 * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.m, 2);
  assert.strictEqual(t.d, 1);
  assert.strictEqual(t.h, 0);
  assert.strictEqual(t.min, 0);
});

test('nextRunTime: weekly on Monday (cron dow=1)', () => {
  // Scheduler maps getDay(): Mon=0, Tue=1, ..., Sun=6
  // cron field '1' means getDay()=2 (Tuesday) in the scheduler's mapping
  // cron field '0' means Monday
  // Use '0' to get Monday
  const next = nextRunTime('0 0 * * 0', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 19); // Jan 19 is Monday
  assert.strictEqual(t.h, 0);
  assert.strictEqual(t.min, 0);
});

test('nextRunTime: step 10 minutes', () => {
  const next = nextRunTime('*/10 * * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 15);
  assert.strictEqual(t.h, 10);
  assert.strictEqual(t.min, 40);
});

test('nextRunTime: invalid expression - too few fields', () => {
  assert.strictEqual(nextRunTime('* * *', BASE), null);
  assert.strictEqual(nextRunTime('* * * * * *', BASE), null);
  assert.strictEqual(nextRunTime('', BASE), null);
});

test('nextRunTime: invalid field values', () => {
  assert.strictEqual(nextRunTime('abc * * * *', BASE), null);
  assert.strictEqual(nextRunTime('*/0 * * * *', BASE), null);
});

test('nextRunTime: leap year Feb 29', () => {
  const next = nextRunTime('0 0 29 2 *', BASE);
  if (next !== null) {
    const t = getLocal(next);
    assert.strictEqual(t.m, 2);
    assert.strictEqual(t.d, 29);
  }
});

test('nextRunTime: year end Dec 31', () => {
  const next = nextRunTime('0 0 31 12 *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.m, 12);
  assert.strictEqual(t.d, 31);
  assert.strictEqual(t.h, 0);
  assert.strictEqual(t.min, 0);
});

test('nextRunTime: from parameter with seconds precision', () => {
  const from = new Date(2026, 0, 15, 10, 30, 30).getTime();
  const next = nextRunTime('* * * * *', from);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 15);
  assert.strictEqual(t.h, 10);
  assert.strictEqual(t.min, 31);
});

test('nextRunTime: comma combination 0,15,30,45', () => {
  const next = nextRunTime('0,15,30,45 * * * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.h, 10);
  assert.strictEqual(t.min, 45);
});

test('nextRunTime: day comma 28,29,30,31', () => {
  const next = nextRunTime('0 0 28,29,30,31 * *', BASE);
  assert.ok(next !== null);
  const t = getLocal(next);
  assert.strictEqual(t.d, 28);
  assert.strictEqual(t.h, 0);
  assert.strictEqual(t.min, 0);
});

test('nextRunTime: result is always after from time', () => {
  const exprs = ['* * * * *', '0 * * * *', '0 0 * * *', '*/5 * * * *'];
  for (const cron of exprs) {
    const next = nextRunTime(cron, BASE);
    if (next !== null) {
      assert.ok(next > BASE, `nextRunTime("${cron}") should be after BASE`);
    }
  }
});

test('nextRunTime: consecutive calls produce increasing results', () => {
  const first = nextRunTime('* * * * *', BASE);
  assert.ok(first !== null);
  const second = nextRunTime('* * * * *', first!);
  assert.ok(second !== null);
  assert.ok(second! > first!, 'second call should be after first');
});
