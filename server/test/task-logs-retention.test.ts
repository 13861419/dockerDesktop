/**
 * 计划任务执行历史保留清理单元测试（1.43.0）
 * 覆盖：purgeExpiredTaskLogs 按 run_at 清理过期行；0 = 永久保留
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录（须在 import storage 前设置）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-tasklogs-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { registerSettings, setSetting } from '../src/settings';
import { purgeExpiredTaskLogs } from '../src/retention';

registerSettings([
  { key: 'tasks.logRetentionDays', label: '任务执行历史保留天数', type: 'number', def: 90, group: 'retention' },
]);

before(() => {
  initStorage();
});

after(() => {
  try {
    fs.rmSync(tmpData, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});

function insertLog(runAt: number, detail: string): void {
  getDb()
    .prepare('INSERT INTO cron_task_logs (task_id, name, type, run_at, status, detail) VALUES (?, ?, ?, ?, 0, ?)')
    .run('t-' + detail, detail, 'prune', runAt, detail);
}

function countLog(detail: string): number {
  const row = getDb()
    .prepare('SELECT count(*) AS c FROM cron_task_logs WHERE name = ?')
    .get(detail) as { c: number };
  return row.c;
}

test('retention：按 run_at 清理过期的任务执行历史', () => {
  // 重置节流时间戳，便于测试直接触发
  const d = getDb();
  d.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('tasks.log.lastPurgeAt', '0')").run();
  insertLog(Date.now() - 200 * 86400_000, 'old-row');
  insertLog(Date.now(), 'fresh-row');

  purgeExpiredTaskLogs();

  assert.equal(countLog('old-row'), 0, '200 天前的记录应被清理');
  assert.equal(countLog('fresh-row'), 1, '新记录应保留');
});

test('retention：0 = 永久保留', () => {
  setSetting('tasks.logRetentionDays', 0);
  const d = getDb();
  d.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES ('tasks.log.lastPurgeAt', '0')").run();
  insertLog(Date.now() - 400 * 86400_000, 'ancient-row');

  purgeExpiredTaskLogs();

  assert.equal(countLog('ancient-row'), 1, '保留天数 <= 0 时不清任何记录');
  d.prepare('DELETE FROM cron_task_logs WHERE name = ?').run('ancient-row');
});

after(() => {
  closeDb();
});
