#!/usr/bin/env node
/**
 * README 首次安装命令版本号同步（AGENTS.md 提交远端前检查项第 2 条）
 *
 * README「方式零：从 GitHub Releases 首次安装」中的下载命令硬编码版本号，
 * 本脚本读取根 package.json 的 version 并校验/改写 README 中的安装命令，
 * 保证发版后文档始终指向最新版本。
 *
 * 用法：
 *   node scripts/sync-readme-version.js          # 校验（不一致退出码 1）
 *   node scripts/sync-readme-version.js --fix    # 自动改写为当前版本
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/** 版本号出现的四种形态（deb / rpm 下载命令与示例说明） */
const patterns = [
  /docker-manager-\d+\.\d+\.\d+-(?:amd64|arm64)\.deb/g,
  /docker-manager-\d+\.\d+\.\d+-1\.(?:x86_64|aarch64)\.rpm/g,
  /releases\/download\/v\d+\.\d+\.\d+\//g,
  /示例版本以 `\d+\.\d+\.\d+` 为例/g,
];

const text = fs.readFileSync(README, 'utf8');
const stale = [];

// 校验：收集所有与当前版本不一致的出现
for (const re of patterns) {
  for (const m of text.matchAll(re)) {
    const v = m[0].match(/\d+\.\d+\.\d+/)[0];
    if (v !== version) stale.push(m[0]);
  }
}

if (!stale.length) {
  console.log(`README 安装命令版本号 = ${version}，一致 ✓`);
  process.exit(0);
}

if (process.argv.includes('--fix')) {
  let updated = text;
  for (const re of patterns) {
    updated = updated.replace(re, (m) => m.replace(/\d+\.\d+\.\d+/, version));
  }
  fs.writeFileSync(README, updated);
  console.log(`README 安装命令版本号已同步为 ${version}（修正 ${stale.length} 处：${stale.join('、')}）`);
  process.exit(0);
}

console.error(`README 安装命令版本号与 package.json（${version}）不一致：${stale.join('、')}`);
console.error('运行 node scripts/sync-readme-version.js --fix 自动修正');
process.exit(1);
