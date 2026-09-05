/**
 * 1.26.0 系统更新单测：语义化版本比较与平台资产匹配
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-update-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { isNewerVersion, platformOf } from '../src/systemUpdate';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('update: isNewerVersion 语义化比较（含 v 前缀与补零）', () => {
  assert.strictEqual(isNewerVersion('1.25.0', '1.26.0'), true);
  assert.strictEqual(isNewerVersion('1.25.1', '1.25.2'), true);
  assert.strictEqual(isNewerVersion('v1.25.0', '1.26.0'), true);
  assert.strictEqual(isNewerVersion('1.25.0', 'v1.26.0'), true);
  assert.strictEqual(isNewerVersion('1.26.0', '1.26.0'), false);
  assert.strictEqual(isNewerVersion('1.26.1', '1.26.0'), false);
  assert.strictEqual(isNewerVersion('2.0.0', '1.9.9'), false);
  assert.strictEqual(isNewerVersion('1.9.0', '1.10.0'), true);
});

test('update: platformOf 按资产名匹配平台', () => {
  assert.strictEqual(platformOf('DockerManager-windows-amd64.zip'), 'windows');
  assert.strictEqual(platformOf('DockerManager-macos.zip'), 'macos');
  assert.strictEqual(platformOf('docker-manager-1.25.0-1.aarch64.rpm'), 'linux-arm64');
  assert.strictEqual(platformOf('docker-manager-1.25.0-1.x86_64.rpm'), 'linux');
  assert.strictEqual(platformOf('sha256sums.txt'), 'checksums');
});
