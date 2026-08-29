/**
 * 告警持续时间窗口单元测试
 *
 * 覆盖：
 *  1. evaluateStreak 状态机：默认立即触发、连续 N 周期窗口、活跃期升级、恢复与清零
 *  2. updateAlertRule 的 consecutive 校验与持久化（临时 SQLite）
 *  3. 容器告警规则（cpu/mem）的 consecutive 创建与读取
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-alertdur-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import {
  evaluateStreak,
  updateAlertRule,
  getAlertRules,
  createContainerAlertRule,
  loadContainerRules,
  deleteContainerAlertRule,
} from '../src/alerting';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

/* ---------- evaluateStreak 状态机 ---------- */

test('evaluateStreak: consecutive=1 时首个周期立即触发（保持原行为）', () => {
  const d = evaluateStreak(null, 'warn', 0, 1);
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.escalated, true);
  assert.strictEqual(d.streak, 1);
  assert.strictEqual(d.active, 'warn');
  assert.strictEqual(d.recovery, false);
});

test('evaluateStreak: consecutive=3 时第 3 个周期才触发', () => {
  const t1 = evaluateStreak(null, 'warn', 0, 3);
  assert.strictEqual(t1.fire, false, '第 1 周期不应触发');
  assert.strictEqual(t1.active, null, '未达窗口不置活跃态');
  assert.strictEqual(t1.streak, 1);

  const t2 = evaluateStreak(null, 'warn', t1.streak, 3);
  assert.strictEqual(t2.fire, false, '第 2 周期不应触发');

  const t3 = evaluateStreak(null, 'warn', t2.streak, 3);
  assert.strictEqual(t3.fire, true, '第 3 周期应触发');
  assert.strictEqual(t3.escalated, true, '首次触发应强制推送');
  assert.strictEqual(t3.active, 'warn');
});

test('evaluateStreak: 活跃告警期间持续超阈值走去重（不强制）', () => {
  const d = evaluateStreak('warn', 'warn', 5, 3);
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.escalated, false, '同级别重复触发交给 maybeFire 去重');
  assert.strictEqual(d.active, 'warn');
});

test('evaluateStreak: 活跃期间 warn 升级 danger 立即强制推送', () => {
  const d = evaluateStreak('warn', 'danger', 9, 3);
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.escalated, true);
  assert.strictEqual(d.active, 'danger');
});

test('evaluateStreak: 活跃告警回落发恢复并清零计数', () => {
  const d = evaluateStreak('warn', null, 4, 3);
  assert.strictEqual(d.recovery, true);
  assert.strictEqual(d.fire, true);
  assert.strictEqual(d.active, null);
  assert.strictEqual(d.streak, 0);
});

test('evaluateStreak: 从未触发过就回落不发恢复，仅清零计数', () => {
  const d = evaluateStreak(null, null, 2, 3);
  assert.strictEqual(d.fire, false);
  assert.strictEqual(d.recovery, false);
  assert.strictEqual(d.streak, 0);
  assert.strictEqual(d.active, null);
});

test('evaluateStreak: consecutive 非法值按 1 处理', () => {
  const d = evaluateStreak(null, 'warn', 0, 0);
  assert.strictEqual(d.fire, true, '0 视为立即告警');
});

/* ---------- updateAlertRule 校验与持久化 ---------- */

test('updateAlertRule: 默认 consecutive 为 1', () => {
  const rules = getAlertRules();
  assert.ok(rules.length > 0);
  for (const r of rules) assert.strictEqual(r.consecutive, 1, `${r.type} 默认应为 1`);
});

test('updateAlertRule: 合法 consecutive 持久化', () => {
  updateAlertRule('cpu', { consecutive: 5 });
  const rule = getAlertRules().find((r) => r.type === 'cpu')!;
  assert.strictEqual(rule.consecutive, 5);
});

test('updateAlertRule: consecutive 越界返回 400', () => {
  assert.throws(() => updateAlertRule('cpu', { consecutive: 0 }), /1-120/);
  assert.throws(() => updateAlertRule('cpu', { consecutive: 121 }), /1-120/);
  assert.throws(() => updateAlertRule('cpu', { consecutive: -2 }), /1-120/);
});

test('updateAlertRule: consecutive 小数向下取整', () => {
  updateAlertRule('mem', { consecutive: 2.9 });
  const rule = getAlertRules().find((r) => r.type === 'mem')!;
  assert.strictEqual(rule.consecutive, 2);
});

test('updateAlertRule: 未传 consecutive 时保留原值', () => {
  updateAlertRule('disk', { consecutive: 4 });
  updateAlertRule('disk', { warnThreshold: 80 });
  const rule = getAlertRules().find((r) => r.type === 'disk')!;
  assert.strictEqual(rule.consecutive, 4, '应保留原值 4');
  assert.strictEqual(rule.warnThreshold, 80);
});

/* ---------- 容器规则（cpu/mem）的 consecutive ---------- */

test('容器告警规则: cpu/mem 类型支持 consecutive 并持久化', () => {
  const created = createContainerAlertRule({
    containerId: 'test-container-dur',
    watchType: 'cpu',
    warnThreshold: 80,
    dangerThreshold: 90,
    consecutive: 6,
  });
  const loaded = loadContainerRules().find((r) => r.id === created.id)!;
  assert.strictEqual(loaded.consecutive, 6);
  deleteContainerAlertRule(created.id);
  assert.strictEqual(loadContainerRules().some((r) => r.id === created.id), false);
});

test('容器告警规则: consecutive 越界返回 400', () => {
  assert.throws(() => {
    createContainerAlertRule({
      containerId: 'test-container-dur-bad',
      watchType: 'mem',
      warnThreshold: 80,
      dangerThreshold: 90,
      consecutive: 999,
    });
  }, /1-120/);
});
