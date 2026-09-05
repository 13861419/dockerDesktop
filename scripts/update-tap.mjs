/**
 * Homebrew tap 更新脚本（发版后手动运行）
 *
 * 用法：node scripts/update-tap.mjs [version]
 *   version 缺省时读取根 package.json 的版本号。
 * 前置：本地 git 凭证可推送 https://github.com/13861419/homebrew-dockerDesktop.git
 *   （或已 gh auth login）。
 *
 * 作用：更新 tap 仓库 Formula/docker-manager.rb 的下载 url 与 sha256，
 * 并 commit + push，使 brew 用户升级即拿到新版。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const version = process.argv[2] || require(path.join(ROOT, 'package.json')).version;
const tag = `v${version}`;
const TAP_DIR = path.join(require('os').tmpdir(), `homebrew-dockerDesktop-${Date.now()}`);

function run(cmd, cwd) {
  console.log(`>>> ${cmd}`);
  execSync(cmd, { cwd: cwd || TAP_DIR, stdio: 'inherit' });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'dockerDesktop-release' } }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

(async () => {
  console.log(`更新 Homebrew tap 到 ${tag}...`);
  const shaUrl = `https://github.com/13861419/dockerDesktop/releases/download/${tag}/sha256sums.txt`;
  const shaLine = (await fetchText(shaUrl)).split('\n').find((l) => l.includes('DockerManager-macos.zip'));
  if (!shaLine) throw new Error('sha256sums.txt 中未找到 DockerManager-macos.zip');
  const sha = shaLine.trim().split(/\s+/)[0];
  console.log(`sha256: ${sha}`);

  run(`git clone https://github.com/13861419/homebrew-dockerDesktop.git ${TAP_DIR}`);
  const formula = path.join(TAP_DIR, 'Formula', 'docker-manager.rb');
  let c = fs.readFileSync(formula, 'utf8');
  c = c.replace(/releases\/download\/v[0-9.]*\/DockerManager-macos\.zip/, `releases/download/${tag}/DockerManager-macos.zip`);
  c = c.replace(/sha256 ".*"/, `sha256 "${sha}"`);
  fs.writeFileSync(formula, c, 'utf8');

  run('git diff --stat', TAP_DIR);
  run('git add -A', TAP_DIR);
  run(`git commit -m "Update docker-manager to ${tag}"`, TAP_DIR);
  run('git push', TAP_DIR);
  console.log('\nHomebrew tap 已更新，用户可通过 brew upgrade docker-manager 升级。');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
