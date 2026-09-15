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
import { isNewerVersion, platformOf, buildWindowsBat, shouldNotifyUpdate } from '../src/systemUpdate';

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

test('update: pickAssetName 按安装类型与架构选包', () => {
  const { pickAssetName, detectInstallType, installTypeLabel } = require('../src/systemUpdate') as typeof import('../src/systemUpdate');
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const rpmArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  assert.strictEqual(pickAssetName('windows-service', '1.69.0'), 'DockerManager-windows-amd64.zip');
  assert.strictEqual(pickAssetName('deb', '1.69.0'), `docker-manager-1.69.0-${arch}.deb`);
  assert.strictEqual(pickAssetName('rpm', '1.69.0'), `docker-manager-1.69.0-1.${rpmArch}.rpm`);
  assert.strictEqual(pickAssetName('docker', '1.69.0'), null);
  assert.strictEqual(pickAssetName('manual', '1.69.0'), null);
  // 仓库内运行（安装目录无 nssm.exe）应识别为 manual，且不支持一键更新
  const type = detectInstallType();
  assert.strictEqual(type === 'windows-service' || type === 'deb' || type === 'rpm' ? 'auto' : 'manual', 'manual');
  assert.strictEqual(installTypeLabel('docker').hint.length > 0, true);
});

test('update: 多源候选与 URL 改写', () => {
  const { mirrorCandidates, withSource } = require('../src/systemUpdate') as typeof import('../src/systemUpdate');
  const { setSetting: setKv } = require('../src/settings') as typeof import('../src/settings');
  // 未配置镜像：内置池 + 直连兜底
  const bases = mirrorCandidates();
  assert.strictEqual(bases[bases.length - 1], '', '直连应作为最后一个候选');
  assert.ok(bases.length >= 2);
  // 配置了镜像则排最前
  setKv('update.githubMirror', 'https://my-mirror.example/');
  const withCfg = mirrorCandidates();
  assert.strictEqual(withCfg[0], 'https://my-mirror.example');
  setKv('update.githubMirror', '');
  // URL 改写：直连原样返回，镜像去协议加前缀
  const raw = 'https://github.com/13861419/dockerDesktop/releases/download/v1.69.0/pkg.zip';
  assert.strictEqual(withSource('', raw), raw);
  assert.strictEqual(withSource('https://ghfast.top', raw), 'https://ghfast.top/github.com/13861419/dockerDesktop/releases/download/v1.69.0/pkg.zip');
  assert.strictEqual(withSource('https://ghfast.top', 'https://api.github.com/repos/x/y'), 'https://ghfast.top/api.github.com/repos/x/y');
});

test('update: verifySha256 校验通过与不匹配', () => {
  const { verifySha256 } = require('../src/systemUpdate') as typeof import('../src/systemUpdate');
  const crypto = require('crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-sha-'));
  const file = path.join(dir, 'pkg.zip');
  fs.writeFileSync(file, 'hello-update');
  const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  // 正确校验和 → 通过
  verifySha256(file, `${sum}  pkg.zip\n`, 'pkg.zip');
  // 二进制格式（*前缀）→ 通过
  verifySha256(file, `${sum} *pkg.zip\n`, 'pkg.zip');
  // 错误校验和 → 抛错
  assert.throws(() => verifySha256(file, `deadbeef  pkg.zip\n`, 'pkg.zip'), /sha256/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('update: shouldNotifyUpdate 每版本仅提醒一次', () => {
  assert.strictEqual(shouldNotifyUpdate(true, '1.74.0', ''), true);
  assert.strictEqual(shouldNotifyUpdate(true, '1.74.0', '1.73.0'), true);
  assert.strictEqual(shouldNotifyUpdate(true, '1.74.0', '1.74.0'), false);
  assert.strictEqual(shouldNotifyUpdate(false, '1.74.0', ''), false);
  assert.strictEqual(shouldNotifyUpdate(true, '', ''), false);
});

test('update: buildWindowsBat 含备份 / 健康检查 / 自动回滚标记', () => {
  const bat = buildWindowsBat('C:\\opt\\docker-manager', 'C:\\staging\\pkg.zip', 'C:\\staging', 9528);
  assert.ok(bat.includes('_prev'), '_prev 备份目录应存在');
  assert.ok(bat.includes('/MIR'), '新版覆盖应为镜像同步');
  assert.ok(bat.includes('api/health'), '健康检查应访问 /api/health');
  assert.ok(bat.includes('-lt 20'), '健康检查窗口应为 20 秒');
  assert.ok(bat.includes('[FAIL]'), '含失败回滚标记');
  assert.ok(bat.includes('update-result.txt'), '写入结果留痕文件');
  assert.ok(bat.includes('9528'), '健康检查地址应包含面板端口');
});
