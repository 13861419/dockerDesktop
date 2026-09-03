/**
 * 1.18.0 K8s Warning 事件告警联动单测：开关控制 + 同源去重 + 落库
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-k8salert-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { setSetting } from '../src/settings';
import { reportK8sEventWarning } from '../src/alerting';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('k8sAlert: Warning 事件派发落库 + 同源 5 分钟去重', async () => {
  setSetting('alerts.k8sEvents', true);
  const ev = { namespace: 'prod', kind: 'Pod', object: 'web-1', reason: 'BackOff', message: 'back-off restarting failed container', count: 3 };
  await reportK8sEventWarning(ev);
  await reportK8sEventWarning(ev);
  await reportK8sEventWarning(ev);

  const rows = getDb()
    .prepare("SELECT type, level, message FROM alert_records WHERE type = 'k8s' ORDER BY id DESC")
    .all() as unknown as Array<{ type: string; level: string; message: string }>;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].level, 'warn');
  assert.ok(rows[0].message.includes('prod'));
  assert.ok(rows[0].message.includes('BackOff'));
  assert.ok(rows[0].message.includes('已发生 3 次'));
});

test('k8sAlert: 开关关闭时不派发', async () => {
  setSetting('alerts.k8sEvents', false);
  const before = (getDb().prepare("SELECT count(*) AS n FROM alert_records WHERE type = 'k8s'").all() as unknown as Array<{ n: number }>)[0].n;
  await reportK8sEventWarning({ namespace: 'dev', kind: 'Pod', object: 'x', reason: 'Evicted', message: 'evicted' });
  const after = (getDb().prepare("SELECT count(*) AS n FROM alert_records WHERE type = 'k8s'").all() as unknown as Array<{ n: number }>)[0].n;
  assert.strictEqual(before, after);
  // 不同源事件仍可派发（重新开启后）
  setSetting('alerts.k8sEvents', true);
  await reportK8sEventWarning({ namespace: 'dev', kind: 'Pod', object: 'y', reason: 'FailedMount', message: 'mount failed' });
  const after2 = (getDb().prepare("SELECT count(*) AS n FROM alert_records WHERE type = 'k8s'").all() as unknown as Array<{ n: number }>)[0].n;
  assert.strictEqual(after2, before + 1);
});
