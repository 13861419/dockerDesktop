/**
 * 配置中心（settings）单元测试（node:test）
 * 覆盖：三态回退（db > env > default）/ setSetting 落库 / validateSetting 校验 / resetSetting 恢复默认 / listSettings 脱敏
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录（须在 import storage 前设置）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-settings-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import {
  registerSettings,
  getSetting,
  getSettingRaw,
  setSetting,
  resetSetting,
  validateSetting,
  listSettings,
} from '../src/settings';

// 测试用描述符
registerSettings([
  { key: 'test.num', label: '数字项', type: 'number', def: 10, group: 'runtime' },
  { key: 'test.env', label: '环境变量项', type: 'number', env: 'DM_TEST_ENV_NUM', def: 1, group: 'runtime' },
  { key: 'test.bool', label: '布尔项', type: 'bool', def: false, group: 'general' },
  { key: 'test.secret', label: '密钥项', type: 'secret', def: '', group: 'security' },
  { key: 'test.ro', label: '只读项', type: 'number', def: 5, group: 'runtime', readonly: true },
]);

before(() => {
  initStorage();
  delete process.env.DM_TEST_ENV_NUM;
});

after(() => {
  closeDb();
  delete process.env.DM_TEST_ENV_NUM;
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('未落库且无 env 时回退到默认值', () => {
  assert.strictEqual(getSetting<number>('test.num'), 10);
  assert.strictEqual(getSettingRaw('test.num')!.source, 'default');
});

test('env 存在时回退到 env，优先级高于 default', () => {
  process.env.DM_TEST_ENV_NUM = '42';
  assert.strictEqual(getSetting<number>('test.env'), 42);
  assert.strictEqual(getSettingRaw('test.env')!.source, 'env');
  delete process.env.DM_TEST_ENV_NUM;
});

test('落库后 db 优先级最高；resetSetting 后回退', () => {
  setSetting('test.num', 99);
  assert.strictEqual(getSetting<number>('test.num'), 99);
  assert.strictEqual(getSettingRaw('test.num')!.source, 'db');
  resetSetting('test.num');
  assert.strictEqual(getSetting<number>('test.num'), 10);
  assert.strictEqual(getSettingRaw('test.num')!.source, 'default');
});

test('bool 类型落库归一化为 true/false 字符串', () => {
  setSetting('test.bool', true);
  assert.strictEqual(getSetting<boolean>('test.bool'), true);
  setSetting('test.bool', 'false');
  assert.strictEqual(getSetting<boolean>('test.bool'), false);
  resetSetting('test.bool');
});

test('secret 类型落库后 getSetting 可解密回读，listSettings 仅回显 configured', () => {
  setSetting('test.secret', 'super-secret-value');
  assert.strictEqual(getSetting<string>('test.secret'), 'super-secret-value');
  const item = listSettings().find((s) => s.key === 'test.secret');
  assert.ok(item);
  assert.strictEqual(item!.configured, true);
  assert.strictEqual(item!.value, undefined);
});

test('validateSetting：未知键/非数字/负数/只读项均报错', () => {
  assert.ok(validateSetting('unknown.key', 1));
  assert.ok(validateSetting('test.num', 'abc'));
  assert.ok(validateSetting('test.num', -1));
  assert.ok(validateSetting('test.ro', 6));
  assert.strictEqual(validateSetting('test.num', 7), null);
});

test('listSettings 返回全部注册项且来源正确', () => {
  const items = listSettings();
  assert.ok(items.length >= 5);
  const ro = items.find((s) => s.key === 'test.ro');
  assert.strictEqual(ro!.source, 'default');
});
