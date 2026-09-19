/**
 * 一键更新权限决策单元测试（1.82.0）
 *
 * decideUpdateMode 是「换种方式」重构的核心纯函数：
 *   root → 直接升级；非 root + 已装特权辅助单元 → helper；否则诚实拒绝（绝不先自杀后失败）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { decideUpdateMode, isNewerVersion, platformOf } from '../src/systemUpdate';

test('decideUpdateMode: root 面板直接升级（无论辅助单元是否安装）', () => {
  assert.strictEqual(decideUpdateMode(true, false).mode, 'root');
  assert.strictEqual(decideUpdateMode(true, true).mode, 'root');
});

test('decideUpdateMode: 非 root + 已装辅助单元走 helper 路径', () => {
  const d = decideUpdateMode(false, true);
  assert.strictEqual(d.mode, 'helper');
  assert.strictEqual(d.reason, '');
});

test('decideUpdateMode: 非 root + 未装辅助单元诚实拒绝并给出指引', () => {
  const d = decideUpdateMode(false, false);
  assert.strictEqual(d.mode, 'denied');
  assert.match(d.reason, /SSH/);
  assert.match(d.reason, /dpkg/);
});

test('isNewerVersion: 语义化版本比较边界', () => {
  assert.strictEqual(isNewerVersion('1.81.0', '1.82.0'), true);
  assert.strictEqual(isNewerVersion('1.82.0', '1.81.0'), false);
  assert.strictEqual(isNewerVersion('1.82.0', '1.82.0'), false);
  assert.strictEqual(isNewerVersion('v1.81.0', '1.82.0'), true);
  assert.strictEqual(isNewerVersion('1.9.0', '1.10.0'), true);
});

test('platformOf: 产物名平台归一', () => {
  assert.strictEqual(platformOf('DockerManager-windows-amd64.zip'), 'windows');
  assert.strictEqual(platformOf('docker-manager-1.82.0-amd64.deb'), 'linux');
  assert.strictEqual(platformOf('docker-manager-1.82.0-arm64.deb'), 'linux-arm64');
  assert.strictEqual(platformOf('docker-manager-1.82.0-1.x86_64.rpm'), 'linux');
  assert.strictEqual(platformOf('sha256sums.txt'), 'checksums');
});
