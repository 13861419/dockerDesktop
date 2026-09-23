/**
 * 1.72.0 应用「保留数据升级」单元测试
 *
 * 覆盖：
 *  1. parseComposeImages：整段 JSON / 逐行 JSON / 异常输入
 *  2. 升级快照 save / load / clear 往返（临时数据目录）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-appstore-upgrade-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import {
  parseComposeImages,
  saveUpgradeSnapshot,
  loadUpgradeSnapshot,
  clearUpgradeSnapshot,
  AppUpgradeSnapshot,
} from '../src/appstore/upgrade';

test('parseComposeImages 解析整段 JSON 数组', () => {
  const text = JSON.stringify([
    { ID: 'sha256:aaa', Repository: 'nginx', Tag: '1.25', Service: 'web' },
    { ID: 'sha256:bbb', Repository: 'redis', Tag: '7', Service: 'cache' },
  ]);
  const rows = parseComposeImages(text);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].service, 'web');
  assert.strictEqual(rows[1].repository, 'redis');
});

test('parseComposeImages 解析逐行 JSON（旧版 compose）', () => {
  const line1 = JSON.stringify({ ID: 'sha256:aaa', Repository: 'nginx', Tag: '1.25', Service: 'web' });
  const line2 = JSON.stringify({ ID: 'sha256:bbb', Repository: 'redis', Tag: '7', Service: 'cache' });
  const rows = parseComposeImages(`${line1}\n${line2}\n`);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].service, 'cache');
});

test('parseComposeImages 同一服务去重并容忍空输入', () => {
  const row = JSON.stringify({ ID: 'sha256:aaa', Repository: 'nginx', Tag: '1.25', Service: 'web' });
  const rows = parseComposeImages(`${row}\n${row}\n`);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(parseComposeImages(''), []);
  assert.deepStrictEqual(parseComposeImages('not json at all'), []);
});

test('升级快照保存 / 读取 / 清除往返', () => {
  const snap: AppUpgradeSnapshot = {
    appId: 'test-app',
    createdAt: 1234567,
    version: '1.0.0',
    composeFile: 'docker-compose.yml',
    composeContent: 'services: {}',
    images: [{ service: 'web', repository: 'nginx', tag: '1.0.0', id: 'sha256:abc' }],
  };
  saveUpgradeSnapshot(snap);
  const loaded = loadUpgradeSnapshot('test-app');
  assert.ok(loaded);
  assert.strictEqual(loaded!.version, '1.0.0');
  assert.strictEqual(loaded!.images[0].tag, '1.0.0');
  clearUpgradeSnapshot('test-app');
  assert.strictEqual(loadUpgradeSnapshot('test-app'), null);
});

test('无快照读取返回 null（不抛错）', () => {
  assert.strictEqual(loadUpgradeSnapshot('never-existed'), null);
});

// 测试后清理临时数据目录（失败不阻塞退出）
after(() => {
  try { fs.rmSync(tmpData, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 句柄释放滞后等场景清理失败不阻塞 */ }
});
