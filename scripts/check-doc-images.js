#!/usr/bin/env node
/**
 * 文档图片死链校验（AGENTS.md 提交远端前检查项第 4 条）
 * 扫描 README.md 与 docs/*.md 中引用的 images/*，校验文件存在；缺失时退出码 1。
 * 用法：npm run docs:check
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = [
  'README.md',
  ...fs
    .readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => 'docs/' + f),
];

const refs = new Set();
for (const doc of DOCS) {
  const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
  for (const m of text.matchAll(/images\/[\w./-]+\.(?:png|jpg|gif)/g)) refs.add(m[0]);
}

const missing = [...refs].filter((r) => !fs.existsSync(path.join(ROOT, r)));
console.log(`文档图片引用 ${refs.size} 张，缺失 ${missing.length}`);
if (missing.length) {
  for (const m of missing) console.log(`  缺失: ${m}`);
  process.exit(1);
}
