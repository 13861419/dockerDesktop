/**
 * 1.9.0 K8s 指标落库单测：k8s_metrics 采样写入、小时级 rollup、集群聚合查询
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-k8smetrics-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { ensureK8sMetricsTable, rollupK8sHour, queryK8sNodeHourly, queryK8sClusterHourly } from '../src/k8s/metrics';
import { hourStart } from '../src/metricsHistory';

before(() => {
  initStorage();
  ensureK8sMetricsTable();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('k8sMetrics: rollup 聚合节点采样到 metrics_hourly（k8s-node scope）', () => {
  const db = getDb();
  const hour = hourStart(Date.now() - 3600_000) - 3600_000; // 上上小时（避开 rollup 定时覆盖）
  const base = hour + 60_000;
  // node-1：2 个采样点（500m/1.0 核），node-2：1 个采样点（250m）
  db.prepare('INSERT INTO k8s_metrics (ts, node, cpu_cores, mem_bytes) VALUES (?, ?, ?, ?)').run(base, 'node-1', 0.5, 1024 * 1024);
  db.prepare('INSERT INTO k8s_metrics (ts, node, cpu_cores, mem_bytes) VALUES (?, ?, ?, ?)').run(base + 60_000, 'node-1', 1.0, 2 * 1024 * 1024);
  db.prepare('INSERT INTO k8s_metrics (ts, node, cpu_cores, mem_bytes) VALUES (?, ?, ?, ?)').run(base, 'node-2', 0.25, 512 * 1024);

  const n = rollupK8sHour(hour);
  assert.strictEqual(n, 3);

  const rows = db
    .prepare("SELECT key, samples, cpu_avg, cpu_max, mem_avg, mem_max FROM metrics_hourly WHERE scope = 'k8s-node' AND ts_hour = ? ORDER BY key")
    .all(hour) as unknown as Array<{ key: string; samples: number; cpu_avg: number; cpu_max: number; mem_avg: number; mem_max: number }>;
  assert.strictEqual(rows.length, 2);
  const node1 = rows.find((r) => r.key === 'node-1')!;
  assert.strictEqual(node1.samples, 2);
  assert.strictEqual(node1.cpu_avg, 0.75);
  assert.strictEqual(node1.cpu_max, 1.0);
  assert.strictEqual(node1.mem_avg, 1.5 * 1024 * 1024);
});

test('k8sMetrics: queryK8sNodeHourly 与集群求和', () => {
  const since = Date.now() - 3600_000 * 24;
  const node1 = queryK8sNodeHourly('node-1', since);
  assert.ok(node1.length >= 1);
  assert.ok(node1[0].cpu_avg > 0);
  const cluster = queryK8sClusterHourly(since);
  assert.ok(cluster.length >= 1);
  // node-1 (0.75) + node-2 (0.25) = 1.0 核
  assert.ok(Math.abs(cluster[0].cpuCores - 1.0) < 1e-9);
});
