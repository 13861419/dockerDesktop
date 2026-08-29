/**
 * 容器自愈单元测试
 *
 * 覆盖：
 *  1. shouldTrigger 纯函数：unhealthy/exited 命中、健康/运行中不命中、冷却期防重
 *  2. 规则 CRUD：创建、同名同类型去重 409、非法入参 400、更新、删除
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-selfheal-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { shouldTrigger, createSelfHealRule, updateSelfHealRule, deleteSelfHealRule, listSelfHealRules } from '../src/selfheal';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

/* ---------- shouldTrigger 纯函数 ---------- */

const CD = { cooldownSec: 300, lastTriggeredAt: null as number | null };

test('shouldTrigger: unhealthy 命中，running/starting/none 不命中', () => {
  assert.strictEqual(shouldTrigger(CD, 'unhealthy', 'running', 'unhealthy', 1000).hit, true);
  assert.strictEqual(shouldTrigger(CD, 'unhealthy', 'running', 'healthy', 1000).hit, false);
  assert.strictEqual(shouldTrigger(CD, 'unhealthy', 'running', 'starting', 1000).hit, false);
  assert.strictEqual(shouldTrigger(CD, 'unhealthy', 'running', 'none', 1000).hit, false);
});

test('shouldTrigger: exited 命中 exited/dead，running 不命中', () => {
  assert.strictEqual(shouldTrigger(CD, 'exited', 'exited', 'none', 1000).hit, true);
  assert.strictEqual(shouldTrigger(CD, 'exited', 'dead', 'none', 1000).hit, true);
  assert.strictEqual(shouldTrigger(CD, 'exited', 'running', 'none', 1000).hit, false);
});

test('shouldTrigger: 冷却期内不触发，超出后恢复触发', () => {
  const cd = { cooldownSec: 300, lastTriggeredAt: 1000 as number | null };
  // 300s 冷却，200s 时仍处冷却期
  assert.strictEqual(shouldTrigger(cd, 'unhealthy', 'running', 'unhealthy', 1000 + 200 * 1000).hit, false);
  assert.strictEqual(shouldTrigger(cd, 'unhealthy', 'running', 'unhealthy', 1000 + 200 * 1000).reason, '冷却期内');
  // 301s 后允许再触发
  assert.strictEqual(shouldTrigger(cd, 'unhealthy', 'running', 'unhealthy', 1000 + 301 * 1000).hit, true);
});

test('shouldTrigger: 状态未命中时即使处于冷却期也返回未命中', () => {
  const cd = { cooldownSec: 300, lastTriggeredAt: 1000 as number | null };
  const r = shouldTrigger(cd, 'unhealthy', 'running', 'healthy', 1000 + 10 * 1000);
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, '状态未命中');
});

/* ---------- 规则 CRUD ---------- */

test('createSelfHealRule: 正常创建并回读', () => {
  const rule = createSelfHealRule({ containerName: 'web', watchType: 'unhealthy', action: 'restart', cooldownSec: 120 });
  assert.strictEqual(rule.containerName, 'web');
  assert.strictEqual(rule.watchType, 'unhealthy');
  assert.strictEqual(rule.action, 'restart');
  assert.strictEqual(rule.cooldownSec, 120);
  assert.strictEqual(rule.enabled, true);
  assert.strictEqual(rule.lastTriggeredAt, null);
});

test('createSelfHealRule: 同容器同类型去重 409', () => {
  assert.throws(
    () => createSelfHealRule({ containerName: 'web', watchType: 'unhealthy', action: 'restart' }),
    (err: any) => err.statusCode === 409,
  );
});

test('createSelfHealRule: 非法入参 400', () => {
  assert.throws(() => createSelfHealRule({ containerName: '', watchType: 'unhealthy', action: 'restart' }), /容器名/);
  assert.throws(() => createSelfHealRule({ containerName: 'x', watchType: 'bad', action: 'restart' }), /监控类型/);
  assert.throws(() => createSelfHealRule({ containerName: 'x', watchType: 'exited', action: 'kill' }), /动作/);
  assert.throws(
    () => createSelfHealRule({ containerName: 'x', watchType: 'exited', action: 'start', cooldownSec: 1 }),
    /冷却期/,
  );
});

test('updateSelfHealRule: 局部更新，未传字段保持原值', () => {
  const { id } = createSelfHealRule({ containerName: 'db', watchType: 'exited', action: 'start' });
  const updated = updateSelfHealRule(id, { enabled: false, cooldownSec: 600 });
  assert.strictEqual(updated.enabled, false);
  assert.strictEqual(updated.cooldownSec, 600);
  assert.strictEqual(updated.containerName, 'db');
  assert.strictEqual(updated.watchType, 'exited');
  assert.throws(() => updateSelfHealRule(9999, { enabled: true }), /不存在/);
});

test('deleteSelfHealRule: 删除后列表减少', () => {
  const before = listSelfHealRules().length;
  const { id } = createSelfHealRule({ containerName: 'tmp', watchType: 'exited', action: 'restart' });
  assert.strictEqual(listSelfHealRules().length, before + 1);
  deleteSelfHealRule(id);
  assert.strictEqual(listSelfHealRules().length, before);
  assert.throws(() => deleteSelfHealRule(id), /不存在/);
});
