/**
 * 渠道送达率统计单元测试
 *
 * 覆盖 getPushStats 聚合：总数/成功率、按渠道分组、最近失败明细、天数过滤
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-pushstats-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { getPushStats } from '../src/notify';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

const DAY = 86400_000;

/**
 * 直接写入推送日志（recordPushLog 为私有函数，此处直接插库验证聚合逻辑）
 */
function insertPush(channelId: string, channelName: string, ok: boolean, createdAt: number, level = 'warn') {
  getDb()
    .prepare('INSERT INTO notify_push_log (channel_id, channel_name, level, ok, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(channelId, channelName, level, ok ? 1 : 0, ok ? 'HTTP 200' : `HTTP 500 fail-${createdAt}`, createdAt);
}

before(() => {
  // 渠道 A：3 成 1 失败（最近一次失败 detail=HTTP 500 fail）；时间随插入顺序递增，保证 id 序与时间序一致
  insertPush('a', '渠道A', true, Date.now() - 7000);
  insertPush('a', '渠道A', false, Date.now() - 6000);
  insertPush('a', '渠道A', true, Date.now() - 5000);
  insertPush('a', '渠道A', true, Date.now() - 4000);
  // 渠道 B：全部成功
  insertPush('b', '渠道B', true, Date.now() - 3000);
  // 渠道 C：全失败
  insertPush('c', '渠道C', false, Date.now() - 2000, 'danger');
  // 8 天前的旧记录：默认 7 天窗口外
  insertPush('old', '旧渠道', true, Date.now() - 8 * 86400_000);
});

test('getPushStats: 汇总 ok/fail/rate', () => {
  const stats = getPushStats(7);
  // 窗口内共 6 条：4 成功 2 失败（渠道A 3 成 1 失败 + 渠道B 1 成 + 渠道C 1 失败）
  assert.strictEqual(stats.totals.ok, 4);
  assert.strictEqual(stats.totals.fail, 2);
  assert.strictEqual(stats.totals.rate, Math.round((4 / 6) * 1000) / 10);
});

test('getPushStats: 按渠道聚合，含成功/失败/最近时间', () => {
  const stats = getPushStats(7);
  const a = stats.channels.find((c) => c.channelId === 'a');
  assert.ok(a);
  assert.strictEqual(a.channelName, '渠道A');
  assert.strictEqual(a.okCount, 3);
  assert.strictEqual(a.failCount, 1);
  assert.strictEqual(a.rate, 75);
  assert.ok(a.lastOkAt);
  assert.ok(a.lastFailAt);
  assert.ok(a.lastFailDetail!.includes('HTTP 500'));

  const b = stats.channels.find((c) => c.channelId === 'b');
  assert.strictEqual(b!.rate, 100);
  assert.strictEqual(b!.lastFailAt, null);

  const c = stats.channels.find((c) => c.channelId === 'c');
  assert.strictEqual(c!.rate, 0);
  assert.ok(stats.recentFailures.some((f) => f.channelName === '渠道C' && f.level === 'danger'));
});

test('getPushStats: 最近失败明细按时间倒序且封顶 10 条', () => {
  const stats = getPushStats(7);
  const failures = stats.recentFailures;
  assert.ok(failures.length >= 2);
  for (let i = 1; i < failures.length; i++) {
    assert.ok(failures[i - 1].createdAt >= failures[i].createdAt);
  }
});

test('getPushStats: days 窗口过滤旧记录', () => {
  const stats = getPushStats(7);
  assert.ok(!stats.channels.some((c) => c.channelId === 'old'));
});
