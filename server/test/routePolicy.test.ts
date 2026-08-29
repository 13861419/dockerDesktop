/**
 * 告警多渠道路由（resolveTargetChannels）单元测试
 *
 * 覆盖三种策略：first（默认，兼容旧版）/ all / byLevel（含停用渠道过滤与空表回退）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-routepolicy-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { setSetting } from '../src/settings';
import { resolveTargetChannels } from '../src/alerting';
import { createChannel, updateChannel, deleteChannel } from '../src/notify';

let chA = '';
let chB = '';
let chC = '';

before(() => {
  initStorage();
  chA = createChannel({ name: '渠道A', type: 'webhook', config: { url: 'https://example.com/a' } }).id;
  chB = createChannel({ name: '渠道B', type: 'webhook', config: { url: 'https://example.com/b' } }).id;
  chC = createChannel({ name: '渠道C', type: 'telegram', config: { botToken: 't', chatId: '1' } }).id;
  // 渠道 C 建立后停用（保留 ID 用于验证停用过滤）
  updateChannel(chC, { enabled: false });
});

after(() => {
  for (const id of [chA, chB, chC]) {
    try { deleteChannel(id); } catch {}
  }
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('first（默认）：仅返回首个启用渠道，兼容旧版行为', () => {
  setSetting('alerts.channelMode', 'first');
  for (const level of ['warn', 'danger', 'recovery'] as const) {
    const targets = resolveTargetChannels(level);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].id, chA);
  }
});

test('all：返回全部启用渠道（停用的 C 被排除）', () => {
  setSetting('alerts.channelMode', 'all');
  for (const level of ['warn', 'danger', 'recovery'] as const) {
    const ids = resolveTargetChannels(level).map((c) => c.id);
    assert.deepStrictEqual(ids, [chA, chB]);
  }
});

test('byLevel：按级别路由表取渠道', () => {
  setSetting('alerts.channelMode', 'byLevel');
  setSetting('alerts.route.danger', `${chB},${chA}`);
  setSetting('alerts.route.warn', chA);
  setSetting('alerts.route.recovery', '');
  assert.deepStrictEqual(resolveTargetChannels('danger').map((c) => c.id), [chB, chA]);
  assert.deepStrictEqual(resolveTargetChannels('warn').map((c) => c.id), [chA]);
  assert.deepStrictEqual(resolveTargetChannels('recovery').map((c) => c.id), [chA], '路由表为空回退首个启用渠道');
});

test('byLevel：路由表中的停用渠道被过滤，过滤后为空回退首个启用渠道', () => {
  setSetting('alerts.channelMode', 'byLevel');
  setSetting('alerts.route.danger', chC);
  setSetting('alerts.route.warn', `${chB},${chC}`);
  assert.deepStrictEqual(resolveTargetChannels('danger').map((c) => c.id), [chA], '仅含停用渠道应回退');
  assert.deepStrictEqual(resolveTargetChannels('warn').map((c) => c.id), [chB], '停用渠道应被剔除');
});

test('byLevel：未知渠道 ID 被忽略', () => {
  setSetting('alerts.channelMode', 'byLevel');
  setSetting('alerts.route.danger', `nonexistent,${chA}`);
  assert.deepStrictEqual(resolveTargetChannels('danger').map((c) => c.id), [chA]);
});

test('非法模式值按 first 处理', () => {
  setSetting('alerts.channelMode', 'weird');
  for (const level of ['warn', 'danger', 'recovery'] as const) {
    const targets = resolveTargetChannels(level);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].id, chA);
  }
});
