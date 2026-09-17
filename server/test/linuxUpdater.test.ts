/**
 * Linux 一键升级脚本生成器单元测试（1.75.1）：
 * 修复两个致命缺陷——root 面板下 systemctl stop 连坐杀死脚本自身；非 root 面板静默假成功。
 */
import { test } from 'node:test';
import assert = require('node:assert');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { writeLinuxUpdater } from '../src/systemUpdate';

function gen(type: 'deb' | 'rpm'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-updater-'));
  const file = writeLinuxUpdater(dir, type, '/var/lib/docker-manager/updates/docker-manager-1.75.1-amd64.deb');
  return fs.readFileSync(file, 'utf8');
}

test('升级脚本：root 检查在 systemd-run 逃逸之前，逃逸在安装之前', () => {
  const sh = gen('deb');
  const iRoot = sh.indexOf('id -u');
  const iEscape = sh.indexOf('systemd-run');
  const iInstall = sh.indexOf('dpkg -i "/var/lib/docker-manager/updates');
  assert.ok(iRoot >= 0 && iEscape >= 0 && iInstall >= 0);
  assert.ok(iRoot < iEscape, 'root 检查必须先于 cgroup 逃逸');
  assert.ok(iEscape < iInstall, '逃逸必须先于安装');
});

test('升级脚本：不再内联 systemctl stop（避免 cgroup 连坐杀死脚本自身）', () => {
  const sh = gen('deb');
  assert.ok(!/systemctl stop docker-manager/.test(sh), '禁止在脚本内 stop 服务，交由 dpkg prerm 处理');
  assert.ok(/systemctl reset-failed docker-manager/.test(sh));
  assert.ok(/systemctl start docker-manager/.test(sh));
});

test('升级脚本：非 root 时诚实失败并给出手动命令，而非假成功', () => {
  const sh = gen('deb');
  assert.ok(/sudo -n true/.test(sh), '尝试免密 sudo 提权重跑');
  assert.ok(/无法自动安装系统包/.test(sh));
  assert.ok(/sudo dpkg -i/.test(sh), '给出手动安装命令');
});

test('升级脚本：健康轮询与失败留痕（journalctl 尾部写入结果文件）', () => {
  const sh = gen('deb');
  assert.ok(/for i in \$\(seq 1 30\)/.test(sh));
  assert.ok(/journalctl -u docker-manager/.test(sh));
  assert.ok(/api\/health/.test(sh));
});

test('升级脚本：安装失败时先拉回旧版服务再退出（1.75.3）', () => {
  const sh = gen('deb');
  const iFail = sh.indexOf('安装包安装失败');
  const iRescue = sh.indexOf('systemctl start docker-manager 2>/dev/null || true');
  assert.ok(iFail >= 0);
  assert.ok(iRescue >= 0 && iRescue < iFail, 'FAIL 之前必须先 start 恢复旧版服务');
  assert.ok(/已恢复旧版服务/.test(sh));
});

test('升级脚本：启动带重试且健康检查不通过时二次复活（1.75.3）', () => {
  const sh = gen('deb');
  assert.ok(/for attempt in 1 2 3/.test(sh), 'start 失败重试 3 次');
  assert.ok(/systemctl enable docker-manager/.test(sh), '显式 enable（prerm 不再 disable）');
  assert.ok(sh.includes('systemctl restart docker-manager 2>/dev/null || true'), '不健康时强制 restart 二次复活');
});

test('升级脚本：健康不通过时的提示包含手动恢复命令（1.75.3）', () => {
  const sh = gen('deb');
  assert.ok(/sudo systemctl restart docker-manager/.test(sh));
});

test('升级脚本：rpm 分支使用 rpm -Uvh --replacepkgs', () => {
  const sh = gen('rpm');
  assert.ok(sh.includes('rpm -Uvh --replacepkgs'));
});

test('升级脚本：bash -n 语法校验（bash 可用时）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-updater-'));
  const file = writeLinuxUpdater(dir, 'deb', '/tmp/x.deb');
  try {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    if (process.platform === 'win32') {
      return; // Windows 下路径翻译易碎，交给 CI（ubuntu）执行 bash -n
    }
    const r = spawnSync('bash', ['-n', file], { timeout: 10000 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // 无 bash 环境则跳过
    }
    assert.strictEqual(r.status, 0, `bash -n 语法错误: ${r.stderr?.toString()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
