/**
 * C3「更细粒度告警」Task 1 单元测试（node:test，零第三方依赖）
 * 覆盖：网络带宽速率差分纯函数 computeNetRate
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { computeNetRate } from '../src/docker/monitor';

test('computeNetRate 正确计算 Mbps 速率', () => {
  // 100MB 累计差，2 秒间隔 → 每秒 50MB = 419.43Mbps（二进制 MB）
  const r = computeNetRate(100 * 1024 * 1024, 50 * 1024 * 1024, 0, 0, 2);
  assert.ok(Math.abs(r.rxMbps - 419.43) < 1e-3, `rxMbps=${r.rxMbps}`);
  assert.ok(Math.abs(r.txMbps - 209.715) < 1e-3, `txMbps=${r.txMbps}`);
});

test('computeNetRate 倒置差分回落为 0（防突刺）', () => {
  const r = computeNetRate(0, 0, 100, 100, 2);
  assert.strictEqual(r.rxMbps, 0);
  assert.strictEqual(r.txMbps, 0);
});

test('computeNetRate 零间隔返回 0（避免除零）', () => {
  const r = computeNetRate(100, 100, 0, 0, 0);
  assert.strictEqual(r.rxMbps, 0);
});
