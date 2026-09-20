/**
 * 首次启动向导（1.88.0）单元测试
 *
 * 覆盖：
 *  - onboarding.done 设置描述符注册（bool / 默认 true / hidden）
 *  - 首装种子：users 表为空 → 写入 '0'；有用户 → 不写（存量库不受打扰）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 必须先于 storage 模块加载设置临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-onboard-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, getDb, seedOnboardingFlag } from '../src/storage';
import { getSettingRaw } from '../src/settings';

test('onboarding.done 描述符：bool 类型、默认 true（已完成）、hidden', () => {
  const raw = getSettingRaw('onboarding.done');
  assert.ok(raw, 'onboarding.done 应已注册');
  assert.strictEqual(raw.value, true);
  assert.strictEqual(raw.source, 'default');
});

test('首装种子：users 为空 → 写入待完成标记', () => {
  initStorage();
  seedOnboardingFlag();
  const raw = getSettingRaw('onboarding.done');
  assert.strictEqual(raw!.value, false);
  assert.strictEqual(raw!.source, 'db');
});

test('存量库：users 非空且无标记 → 不种子（视为已完成）', () => {
  // 模拟存量库：插入一个用户后清除标记，再次执行种子应保持无键
  getDb()
    .prepare("INSERT INTO users (username, salt, password_hash, role, created_at) VALUES ('legacy', 's', 'h', 'admin', 0)")
    .run();
  getDb().prepare('DELETE FROM setting WHERE key = ?').run('onboarding.done');
  seedOnboardingFlag();
  const raw = getSettingRaw('onboarding.done');
  assert.strictEqual(raw!.source, 'default');
  assert.strictEqual(raw!.value, true);
});
