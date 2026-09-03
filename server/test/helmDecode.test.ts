/**
 * 1.16.0 Helm Release protobuf 深度解码单测：自编解码互逆校验 wire format
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-helm-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { decodeHelmRelease, encodeHelmReleaseForTest } from '../src/k8s/helmDecode';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('helmDecode: 解析 Release protobuf（chart 名/版本 + status + last_deployed）', () => {
  const buf = encodeHelmReleaseForTest({
    chartName: 'nginx',
    chartVersion: '15.4.0',
    status: 1,
    lastDeployedSec: 1759500000,
  });
  const meta = decodeHelmRelease(buf.toString('base64'));
  assert.ok(meta);
  assert.strictEqual(meta.chartName, 'nginx');
  assert.strictEqual(meta.chartVersion, '15.4.0');
  assert.strictEqual(meta.status, 'deployed');
  assert.strictEqual(meta.lastDeployedAt, 1759500000 * 1000);
});

test('helmDecode: gzip 包裹 payload 兼容 + 非法输入返回 null', () => {
  const zlib = require('zlib') as typeof import('zlib');
  const buf = encodeHelmReleaseForTest({ chartName: 'redis', chartVersion: '17.0.1', status: 7, lastDeployedSec: 1700000000 });
  const gz = decodeHelmRelease(zlib.gzipSync(buf).toString('base64'));
  assert.ok(gz);
  assert.strictEqual(gz.chartName, 'redis');
  assert.strictEqual(gz.chartVersion, '17.0.1');
  assert.strictEqual(gz.status, 'failed');

  // 解析失败的 payload 返回 null（降级路径）
  assert.strictEqual(decodeHelmRelease(Buffer.from('not-a-protobuf').toString('base64')), null);
  assert.strictEqual(decodeHelmRelease(''), null);
});
