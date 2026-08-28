/**
 * 面板数据库备份恢复（restoreSqliteBackup）单元测试
 *
 * 为什么是隔离单测而非集成测试：
 *  恢复会把整库文件回滚到快照，若针对共享 dev 服务器的库执行，
 *  会抹掉其他并行测试文件期间新建的行（曾导致 api-databases 偶发 404）。
 *  因此在独立临时数据目录中直接调用模块函数验证恢复逻辑。
 *
 * 覆盖：
 *  1. 创建备份 → 快照文件非空且在列表中
 *  2. 删除数据 → 恢复 → 数据回到快照状态且 quick_check 通过
 *  3. 非 SQLite 文件恢复 → 400
 *  4. 不存在的备份 → 404
 *  5. 路径穿越 → 400
 *  6. 删除备份 → 从列表消失
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录（须在 import storage 前设置）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-sqlbak-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, getDb, closeDb } from '../src/storage';
import {
  createSqliteBackup,
  restoreSqliteBackup,
  listSqliteBackups,
  deleteSqliteBackup,
  resolveSqliteBackupFile,
} from '../src/sqliteBackup';

const MARKER_SQL = "INSERT INTO setting (key, value) VALUES ('restore-marker', 'survived')";
const MARKER_COUNT_SQL = "SELECT COUNT(*) AS n FROM setting WHERE key = 'restore-marker'";

before(() => {
  initStorage();
  getDb().exec(MARKER_SQL);
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('创建备份：快照文件非空且出现在列表中', () => {
  const info = createSqliteBackup('unittest');
  assert.ok(info.size > 0);
  assert.ok(listSqliteBackups().some((x) => x.file === info.file));
});

test('恢复：删掉快照后新增的数据，恢复后回到快照状态', () => {
  const info = createSqliteBackup('unittest-restore');
  // 快照之后改动数据：删除标记行并新增一行
  getDb().exec("DELETE FROM setting WHERE key = 'restore-marker'");
  getDb().exec("INSERT INTO setting (key, value) VALUES ('post-snapshot-row', '1')");
  const before = getDb().prepare(MARKER_COUNT_SQL).get() as { n: number };
  assert.strictEqual(before.n, 0);

  restoreSqliteBackup(info.file);

  const after = getDb().prepare(MARKER_COUNT_SQL).get() as { n: number };
  assert.strictEqual(after.n, 1);
  const post = getDb().prepare("SELECT COUNT(*) AS n FROM setting WHERE key = 'post-snapshot-row'").get() as { n: number };
  assert.strictEqual(post.n, 0);
  const check = getDb().prepare('PRAGMA quick_check').get() as { quick_check: string };
  assert.strictEqual(check.quick_check, 'ok');
});

test('非 SQLite 文件恢复：400', () => {
  const fake = path.join(tmpData, 'db-backups', 'not-a-db.db');
  fs.writeFileSync(fake, 'this is plain text, not sqlite');
  assert.throws(() => restoreSqliteBackup('not-a-db.db'), (e: any) => e.statusCode === 400);
});

test('不存在的备份：404；路径穿越：400', () => {
  assert.throws(() => restoreSqliteBackup('no-such-backup.db'), (e: any) => e.statusCode === 404);
  assert.throws(() => deleteSqliteBackup('../evil.db'), (e: any) => e.statusCode === 400);
  assert.throws(() => resolveSqliteBackupFile('a/b.db'), (e: any) => e.statusCode === 400);
});

test('删除备份：从列表消失', () => {
  const info = createSqliteBackup('unittest-delete');
  deleteSqliteBackup(info.file);
  assert.ok(!listSqliteBackups().some((x) => x.file === info.file));
});
