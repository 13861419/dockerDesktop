/**
 * 一键运行全部页面回归脚本。
 *
 * 依次以子进程方式执行 scripts/regression-*.js，逐个收集退出码：
 *  - 即使某个脚本失败也继续跑完其余脚本（不中断）
 *  - 最终输出汇总报告（通过 / 失败清单 + 退出码）
 *
 * 用法：
 *   node scripts/run-regression-all.js
 *   npm run regression:all
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPTS = [
  'regression-files-events.js',
  'regression-databases.js',
  'regression-appstore.js',
  'regression-images.js',
  'regression-overview.js',
  'regression-volumes.js',
  'regression-hub.js',
  'regression-compose.js',
  'regression-networks.js',
  'regression-containers.js',
];

let failedCount = 0;
const results = [];

console.log('=== 开始运行全部页面回归 ===\n');

for (const file of SCRIPTS) {
  const scriptPath = path.join(__dirname, file);
  const label = file.replace(/^regression-/, '').replace(/\.js$/, '');
  process.stdout.write(`[${label}] 运行中... `);

  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
  });

  const ok = result.status === 0;
  if (ok) {
    console.log(`[${label}] ✅ 通过`);
  } else {
    console.log(`[${label}] ❌ 失败 (exit ${result.status})`);
    failedCount += 1;
  }
  results.push({ label, ok, status: result.status });
}

console.log('\n=== 回归汇总 ===');
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.ok ? '' : ` (exit ${r.status})`}`);
}
console.log(`\n共 ${results.length} 项，通过 ${results.length - failedCount} 项，失败 ${failedCount} 项。`);

process.exit(failedCount > 0 ? 1 : 0);
