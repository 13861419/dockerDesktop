/**
 * 存储层单元测试
 *
 * 覆盖：
 *  1. 加密/解密：encryptSecret / decryptSecret 往返一致性、空值/异常输入处理
 *  2. 数据库初始化：initStorage / getDb / closeDb 生命周期
 *  3. 数据库导入导出：exportDatabase / importDatabaseBuffer
 *  4. 数据目录：getDataDir / DATA_DIR / DB_FILE
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-storage-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, getDb, closeDb, encryptSecret, decryptSecret, exportDatabase, importDatabaseBuffer, getDataDir, DATA_DIR, DB_FILE } from '../src/storage';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('encryptSecret / decryptSecret: 往返一致性', () => {
  const plaintext = 'my-super-secret-password-123!@#';
  const encrypted = encryptSecret(plaintext);
  assert.notStrictEqual(encrypted, plaintext, '加密后不应与原文相同');
  assert.ok(encrypted.length > 0, '加密结果不应为空');
  const decrypted = decryptSecret(encrypted);
  assert.strictEqual(decrypted, plaintext, '解密后应与原文一致');
});

test('encryptSecret: 空字符串返回空', () => {
  const result = encryptSecret('');
  assert.strictEqual(result, '');
});

test('decryptSecret: 空字符串返回空', () => {
  const result = decryptSecret('');
  assert.strictEqual(result, '');
});

test('decryptSecret: null 返回空', () => {
  assert.strictEqual(decryptSecret(null), '');
});

test('decryptSecret: undefined 返回空', () => {
  assert.strictEqual(decryptSecret(undefined), '');
});

test('decryptSecret: 非法 base64 返回空（不抛异常）', () => {
  assert.strictEqual(decryptSecret('not-valid-base64!!!'), '');
});

test('encryptSecret: 不同明文产生不同密文', () => {
  const a = encryptSecret('aaa');
  const b = encryptSecret('bbb');
  assert.notStrictEqual(a, b);
});

test('getDb: 返回有效的 DatabaseSync 对象', () => {
  const d = getDb();
  assert.ok(d !== null && d !== undefined);
  // 验证能执行简单查询
  const result = d.prepare('SELECT 1 AS x').get() as { x: number };
  assert.strictEqual(result.x, 1);
});

test('getDb: 多次调用返回同一实例', () => {
  const a = getDb();
  const b = getDb();
  assert.strictEqual(a, b);
});

test('getDataDir: 返回路径字符串', () => {
  const dir = getDataDir();
  assert.strictEqual(typeof dir, 'string');
  assert.ok(dir.length > 0);
  assert.ok(fs.existsSync(dir), '数据目录应存在');
});

test('DB_FILE: 指向正确的数据库文件路径', () => {
  assert.ok(DB_FILE.endsWith('.db'));
  assert.ok(DB_FILE.includes(tmpData), '应位于临时数据目录');
});

test('exportDatabase: 返回备份文件路径，文件存在且为有效 SQLite', () => {
  const backupPath = exportDatabase();
  assert.strictEqual(typeof backupPath, 'string');
  assert.ok(backupPath.endsWith('.db.backup'));
  assert.ok(fs.existsSync(backupPath), '备份文件应存在');
  // 验证 SQLite 文件头
  const header = Buffer.alloc(16);
  const fd = fs.openSync(backupPath, 'r');
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  assert.strictEqual(header.toString('utf8', 0, 16), 'SQLite format 3\u0000', '应为有效 SQLite 文件');
});

test('importDatabaseBuffer: 导入有效 SQLite buffer 后数据可读', () => {
  // 先导出获取有效 SQLite buffer
  const backupPath = exportDatabase();
  const buf = fs.readFileSync(backupPath);
  assert.ok(buf.length > 16);
  // 验证头
  assert.strictEqual(buf.subarray(0, 16).toString('utf8'), 'SQLite format 3\u0000');
  const result = importDatabaseBuffer(buf);
  assert.ok(typeof result === 'object');
  assert.ok(typeof result.users === 'number');
});

test('container_templates 表: 内置模板已 seed', () => {
  const d = getDb();
  const rows = d.prepare('SELECT id, name FROM container_templates WHERE id LIKE ?').all('builtin-%') as Array<{ id: string; name: string }>;
  assert.ok(rows.length >= 5, `应至少有 5 个内置模板，实际 ${rows.length}`);
  const names = rows.map(r => r.name);
  assert.ok(names.includes('Nginx 静态站点'), '应包含 Nginx 模板');
  assert.ok(names.includes('MySQL 数据库'), '应包含 MySQL 模板');
  assert.ok(names.includes('Redis 缓存'), '应包含 Redis 模板');
});

test('container_templates 表: config 字段为合法 JSON', () => {
  const d = getDb();
  const rows = d.prepare('SELECT config FROM container_templates WHERE id LIKE ?').all('builtin-%') as Array<{ config: string }>;
  for (const row of rows) {
    assert.doesNotThrow(() => JSON.parse(row.config), `config 应为合法 JSON: ${row.config.substring(0, 50)}`);
    const cfg = JSON.parse(row.config);
    assert.ok(cfg.image, `config 应包含 image 字段`);
  }
});

test('hub_sources 表: 表结构存在且可查询', () => {
  const d = getDb();
  // 表应存在（即使无数据）
  const rows = d.prepare('SELECT count(*) AS c FROM hub_sources').get() as { c: number };
  assert.ok(typeof rows.c === 'number');
  // 内置源通过 migrateLegacyData() 从旧 JSON 文件迁移，测试环境可能无旧文件
  // 这里只验证表结构存在
});
