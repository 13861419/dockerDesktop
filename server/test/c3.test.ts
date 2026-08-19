/**
 * C3「更细粒度告警」Task 1 单元测试（node:test，零第三方依赖）
 * 覆盖：网络带宽速率差分纯函数 computeNetRate
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { computeNetRate } from '../src/docker/monitor';

// 必须先于 storage/alerting 模块加载设置临时数据目录，确保 getDb() 指向隔离环境
import os from 'os';
import path from 'path';
import fs from 'fs';
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-c3-test-'));
process.env.DOCKERMANAGER_DATA = tmpData;
import { initStorage } from '../src/storage';
import { updateAlertRule } from '../src/alerting';
initStorage();

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

test('updateAlertRule 的 net 类型放开阈值上限（Mbps 可 >100）', () => {
  // net 默认 danger=200 > 100，仅开关 enabled（阈值回落 row）也应放行不抛错
  assert.doesNotThrow(() => updateAlertRule('net', { dangerThreshold: 200 }));
  // 更大的 Mbps 值同样放行
  assert.doesNotThrow(() => updateAlertRule('net', { dangerThreshold: 1e6 }));
  // 依旧禁止负数
  assert.throws(
    () => updateAlertRule('net', { warnThreshold: -1 }),
    /阈值需为非负数/,
  );
});

test('updateAlertRule 的非 net 类型仍保持 0-100 校验', () => {
  // 生效：cpu 已关闭静默/工作时段，仅改阈值不触发 400
  assert.doesNotThrow(() => updateAlertRule('cpu', { dangerThreshold: 99 }));
  // 超过 100 仍应拒绝
  assert.throws(() => updateAlertRule('cpu', { dangerThreshold: 200 }), /阈值需为 0-100/);
});
