/**
 * AI 配置文件（aiProfiles）单元测试
 * 运行：先设 DOCKERMANAGER_DATA 到临时目录再 import storage，避免污染真实 data/。
 * 覆盖：迁移 / CRUD / 默认切换 / 删除保护 / SSRF / getProfileApiKey
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 必须先于 storage import 设置临时数据目录（DATA_DIR 随模块加载解析一次）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-aiprofiles-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { DatabaseSync } from 'node:sqlite';
import { initStorage, closeDb, getDb } from '../src/storage';
import {
  ensureAiProfiles,
  listProfiles,
  getDefaultProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  setDefaultProfile,
  getProfileApiKey,
} from '../src/aiProfiles';

before(() => {
  initStorage();
});
after(() => {
  closeDb();
});

/** 每测前清空 ai_profiles（同文件共享一个临时 DB，靠清表隔离；复用 storage 连接避免二次连库锁冲突） */
function resetProfiles() {
  getDb().exec('DELETE FROM ai_profiles');
}

test('ai_settings 有数据时迁移为首条默认 profile', () => {
  resetProfiles();
  // 预置 ai_settings 数据（复用 storage 连接）
  getDb().exec('DELETE FROM ai_settings');
  getDb()
    .prepare('INSERT INTO ai_settings (id, enabled, base_url, model, api_key_enc, system_prompt, timeout_ms, updated_at) VALUES (1,1,?,?,?,?,?,?)')
    .run('http://127.0.0.1:9119/v1', 'm', 'ENCKEY', '', 60000, Date.now());

  ensureAiProfiles();
  const list = listProfiles();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].baseUrl, 'http://127.0.0.1:9119/v1');
  assert.strictEqual(list[0].model, 'm');
  assert.ok(list[0].isDefault);
});

test('ensureAiProfiles 幂等：迁移后再调用不重复', () => {
  resetProfiles();
  ensureAiProfiles();
  const first = listProfiles().length;
  ensureAiProfiles();
  assert.strictEqual(listProfiles().length, first);
});

test('createProfile 首条自动设默认', () => {
  resetProfiles();
  const first = createProfile({ name: 'A-本地', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' });
  assert.ok(first.isDefault);
  assert.strictEqual(listProfiles().length, 1);
});

test('createProfile 校验 baseUrl（SSRF）', () => {
  resetProfiles();
  assert.throws(() => createProfile({ baseUrl: 'http://192.168.1.5/v1' }), /仅允许/);
  assert.throws(() => createProfile({ baseUrl: 'http://example.com/v1' }), /仅允许/);
  // 合法值不抛
  assert.doesNotThrow(() => createProfile({ baseUrl: 'https://api.openai.com/v1' }));
  assert.doesNotThrow(() => createProfile({ baseUrl: 'http://127.0.0.1:9119/v1' }));
});

test('setDefaultProfile 仅有一条默认', () => {
  resetProfiles();
  const a = createProfile({ name: 'A' });
  const b = createProfile({ name: 'B' });
  setDefaultProfile(b.id);
  const list = listProfiles();
  const defaults = list.filter((p) => p.isDefault);
  assert.strictEqual(defaults.length, 1);
  assert.strictEqual(defaults[0].id, b.id);
});

test('deleteProfile 禁止删除最后一条', () => {
  resetProfiles();
  const a = createProfile({ name: 'A' });
  const count = listProfiles().length;
  if (count === 1) {
    assert.throws(() => deleteProfile(a.id), /至少保留/);
  }
});

test('deleteProfile 删除默认后自动改选', () => {
  resetProfiles();
  const a = createProfile({ name: 'A' });
  const b = createProfile({ name: 'B' });
  // 默认应为首条 A；删除 A
  deleteProfile(a.id);
  const rest = listProfiles();
  assert.strictEqual(rest.length, 1);
  assert.ok(rest[0].isDefault);
});

test('getProfileApiKey 解密还原明文 key', () => {
  resetProfiles();
  const p = createProfile({ name: 'K', apiKey: 'sk-very-secret' });
  assert.strictEqual(getProfileApiKey(p.id), 'sk-very-secret');
});
