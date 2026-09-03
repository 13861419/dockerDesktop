/**
 * 1.12.0 K8s 事件落库单测：uid 去重 UPSERT、历史查询、按命名空间过滤
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-k8sevents-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { insertK8sEvent, queryK8sEventsHistory, ensureK8sEventsTable } from '../src/k8s/eventWatcher';

before(() => {
  initStorage();
  ensureK8sEventsTable();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('k8sEvents: uid 去重 UPSERT（重复事件更新 count/last_at）', () => {
  const t0 = Date.now() - 60_000;
  insertK8sEvent({ uid: 'u1', namespace: 'default', type: 'Warning', reason: 'BackOff', kind: 'Pod', object: 'p1', message: 'back-off', count: 1, lastAt: t0 });
  insertK8sEvent({ uid: 'u1', namespace: 'default', type: 'Warning', reason: 'BackOff', kind: 'Pod', object: 'p1', message: 'back-off', count: 5, lastAt: Date.now() });

  const rows = getDb().prepare('SELECT count(*) AS n FROM k8s_events').all() as unknown as Array<{ n: number }>;
  assert.strictEqual(rows[0].n, 1);

  const hist = queryK8sEventsHistory(undefined, 100);
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].count, 5);
  assert.strictEqual(hist[0].object, 'p1');
});

test('k8sEvents: queryK8sEventsHistory 命名空间过滤 + 无 uid 事件丢弃', () => {
  insertK8sEvent({ uid: 'u2', namespace: 'kube-system', type: 'Normal', reason: 'Started', kind: 'Pod', object: 'p2', message: 'started', count: 1, lastAt: Date.now() });
  insertK8sEvent({ namespace: 'default', type: 'Normal', reason: 'NoUid', message: 'x', count: 1, lastAt: Date.now() });

  const all = queryK8sEventsHistory(undefined, 100);
  assert.strictEqual(all.length, 2);

  const sys = queryK8sEventsHistory('kube-system', 100);
  assert.strictEqual(sys.length, 1);
  assert.strictEqual(sys[0].reason, 'Started');
  assert.strictEqual(sys[0].namespace, 'kube-system');
});
