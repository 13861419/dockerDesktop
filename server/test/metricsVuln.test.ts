/**
 * 1.2.0 可观测性单元测试：小时级指标聚合（metrics_hourly）与漏洞扫描历史
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-metricsh-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import { rollupHour, queryHourly } from '../src/metricsHistory';
import { diffNewHigh, saveScanResult, listVulnHistory } from '../src/vulnScan';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

/* ---------- 小时级聚合 ---------- */

test('metricsHistory: host 小时聚合 avg/max 正确', () => {
  const db = getDb();
  // 构造上一整小时的 3 条采样（10:00:30 起）
  const h = 10 * 3600_000; // 任意对齐小时桶
  const insert = db.prepare(
    `INSERT INTO host_metrics
      (ts, cpu_percent, cpu_cores, mem_percent, mem_used, mem_total,
       disk_percent, disk_used, disk_total, net_rx, net_tx, containers_running, containers_total, images)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(h + 60_000, 10, 4, 30, 100, 200, 50, 1, 2, 1000, 2000, 3, 5, 10);
  insert.run(h + 120_000, 50, 4, 60, 300, 200, 50, 1, 2, 3000, 4000, 3, 5, 10);
  insert.run(h + 180_000, 30, 4, 90, 200, 200, 50, 1, 2, 5000, 6000, 3, 5, 10);

  rollupHour('host', h);
  const rows = queryHourly('host', 'host', 0);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.ts_hour, h);
  assert.strictEqual(r.samples, 3);
  assert.strictEqual(r.cpu_avg, 30); // (10+50+50... = (10+50+50)/3? no: (10+50+50)...
  assert.strictEqual(r.cpu_max, 50);
  assert.strictEqual(r.mem_avg, 200);
  assert.strictEqual(r.mem_max, 300);
  assert.strictEqual(r.cpu_cores, 4);
  assert.strictEqual(r.mem_total, 200);
  // 网络：max-min = 5000-1000 = 4000 / 6000-2000 = 4000
  assert.strictEqual(r.rx_sum, 4000);
  assert.strictEqual(r.tx_sum, 4000);
});

test('metricsHistory: container 聚合按容器分组且增量求和', () => {
  const db = getDb();
  const h = 20 * 3600_000;
  const insert = db.prepare(
    `INSERT INTO container_metrics
      (container_id, ts, cpu_percent, mem_usage, mem_limit, mem_percent, net_rx, net_tx, rx_delta, tx_delta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run('c1', h + 60_000, 10, 100, 1000, 10, 500, 700, 100, 200);
  insert.run('c1', h + 120_000, 30, 200, 1000, 20, 700, 900, 200, 300);
  insert.run('c2', h + 60_000, 80, 900, 1000, 90, 100, 100, 50, 60);

  rollupHour('container', h);
  const rows = queryHourly('container', 'c1', 0);
  assert.strictEqual(rows.length, 1);
  const r1 = rows[0];
  assert.strictEqual(r1.ts_hour, h);
  assert.strictEqual(r1.samples, 2);
  assert.strictEqual(r1.cpu_avg, 20);
  assert.strictEqual(r1.cpu_max, 30);
  assert.strictEqual(r1.rx_sum, 300);
  assert.strictEqual(r1.tx_sum, 500);
  assert.strictEqual(queryHourly('container', 'c2', 0).length, 1);
  void db;
});

/* ---------- 漏洞扫描 ---------- */

test('vulnScan: diffNewHigh 仅保留新增的 Critical/High', () => {
  const prevCsv = 'CVE-2024-0001,CVE-2024-0002';
  const entries = [
    { id: 'CVE-2024-0001', severity: 'CRITICAL' }, // 已有 → 排除
    { id: 'CVE-2024-0003', severity: 'HIGH' }, // 新增高危
    { id: 'CVE-2024-0004', severity: 'CRITICAL' }, // 新增高危
    { id: 'CVE-2024-0005', severity: 'MEDIUM' }, // 新增但非高危 → 忽略
    { id: 'CVE-2024-0006', severity: 'LOW' }, // 非高危 → 忽略
    { id: 'CVE-2024-0003', severity: 'HIGH' }, // 重复条目去重
  ];
  const diff = diffNewHigh(prevCsv, entries);
  assert.deepStrictEqual(diff, ['CVE-2024-0003', 'CVE-2024-0004']);
  // 首扫（无上次记录）：全部高危视为新增（测试数据中无 CVE-2024-0002 条目）
  const first = diffNewHigh('', entries);
  assert.deepStrictEqual(first, ['CVE-2024-0001', 'CVE-2024-0003', 'CVE-2024-0004']);
});

test('vulnScan: saveScanResult 留存快照并计算新增', () => {
  const counts = { critical: 2, high: 1, medium: 0, low: 0, unknown: 0, total: 3 };
  const entries = [
    { id: 'CVE-2024-1001', severity: 'CRITICAL' },
    { id: 'CVE-2024-1002', severity: 'CRITICAL' },
    { id: 'CVE-2024-1003', severity: 'HIGH' },
  ];
  const first = saveScanResult('smoke:1.0', counts, entries, 's1');
  // �扫：全部高危（3 个）视为新增
  assert.strictEqual(first.length, 3);
  // 第二轮：CVE 全集相同 → 无新增
  const second = saveScanResult('smoke:1.0', counts, entries, 's2');
  assert.strictEqual(second.length, 0);
  // 第三轮新增一个高危 CVE → 恰好检出该新增
  const third = saveScanResult(
    'smoke:1.0',
    counts,
    [...entries, { id: 'CVE-2024-9999', severity: 'CRITICAL' }],
    's3',
  );
  assert.deepStrictEqual(third, ['CVE-2024-9999']);
  // 历史可查
  const hist = listVulnHistory('smoke:1.0');
  assert.strictEqual(hist.length, 3);
  assert.strictEqual(hist[0].critical, 2); // 最新一条
  assert.deepStrictEqual(hist[0].newCves, ['CVE-2024-9999']);
});
