#!/usr/bin/env node
/**
 * 文档图片死链校验（AGENTS.md 提交远端前检查项第 4 条）
 *
 * 与 GitHub 渲染规则一致：Markdown 中的相对路径按「引用文件所在目录」解析。
 * 即 docs/*.md 中的图片必须写 ../images/xxx.png（而非 images/xxx.png）。
 *
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

let total = 0;
const missing = [];

for (const doc of DOCS) {
  const docPath = path.join(ROOT, doc);
  const text = fs.readFileSync(docPath, 'utf8');
  // [任意 alt](images/...) 或 (../images/...)，按文档目录解析
  const refs = text.matchAll(/\]\(((?:\.\.\/)?images\/[\w./-]+\.(?:png|jpg|gif))\)/g);
  for (const m of refs) {
    total++;
    const resolved = path.resolve(path.dirname(docPath), m[1]);
    if (!fs.existsSync(resolved)) missing.push(`${doc} -> ${m[3]}`);
  }
}

console.log(`文档图片引用 ${total} 张，缺失 ${missing.length}`);
if (missing.length) {
  for (const m of missing) console.log(`  缺失: ${m}`);
  process.exit(1);
}
