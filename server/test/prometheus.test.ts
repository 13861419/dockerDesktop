/**
 * 1.21.0 Prometheus 指标暴露单测：文本格式、host/k8s 最新值、label 转义
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-prom-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { buildPrometheusText } from '../src/prometheus';
import { ensureK8sMetricsTable } from '../src/k8s/metrics';

before(() => {
  initStorage();
  ensureK8sMetricsTable();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO host_metrics (ts, cpu_percent, cpu_cores, mem_percent, mem_used, mem_total, disk_percent, disk_used, disk_total, net_rx, net_tx, containers_running, containers_total, images)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(now, 12.34, 8, 56.78, 1, 2, 78.9, 1, 2, 0, 0, 0, 0, 0);
  getDb()
    .prepare('INSERT INTO k8s_metrics (ts, node, cpu_cores, mem_bytes) VALUES (?, ?, ?, ?)')
    .run(now, 'node-a"1', 2.5, 1073741824);
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('prometheus: 输出包含最新 host 指标', () => {
  const text = buildPrometheusText();
  assert.ok(text.includes('# TYPE dockermanager_host_cpu_percent gauge'));
  assert.ok(text.includes('dockermanager_host_cpu_percent 12.34'));
  assert.ok(text.includes('dockermanager_host_mem_percent 56.78'));
  assert.ok(text.includes('dockermanager_host_disk_percent 78.90'));
});

test('k8sMetrics: 输出包含 k8s 节点最新值且 label 已转义', () => {
  const text = buildPrometheusText();
  assert.ok(text.includes('dockermanager_k8s_node_cpu_cores{node="node-a\\"1"} 2.5000'));
  assert.ok(text.includes('dockermanager_k8s_node_mem_bytes{node="node-a\\"1"} 1073741824'));
});

test('prometheus: 文本以换行结尾且无空 HELP 行', () => {
  const text = buildPrometheusText();
  assert.ok(text.endsWith('\n'));
  for (const line of text.split('\n')) {
    if (line.startsWith('# HELP')) assert.ok(!line.endsWith('#'));
  }
});
