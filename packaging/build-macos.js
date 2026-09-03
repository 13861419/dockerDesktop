/**
 * Docker 管理面板 - macOS 包打包脚本
 *
 * 产出 dist-release/DockerManager-macos.zip：
 *   DockerManager/
 *     server/         后端编译产物 + 生产依赖（纯 JS，跨平台通用）
 *     static/         前端构建产物
 *     start.sh        启动脚本（检查 Node >= 22）
 *     stop.sh         停止脚本
 *     README.txt      安装说明
 *
 * 前置：npm install + web build + tsc（与 build-release.js 相同前置）。
 * 依赖均为纯 JS（dockerode / ws / express 等），产物与构建机平台无关。
 *
 * 用法: node packaging/build-macos.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const SERVER_DIR = path.join(ROOT, 'server');
const RELEASE = path.join(ROOT, 'dist-release', 'DockerManager');

function run(cmd, cwd) {
  console.log(`\n>>> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const items = fs.readdirSync(src, { withFileTypes: true });
  for (const item of items) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  console.log('==========================================');
  console.log('  DockerManager macOS 包打包');
  console.log('==========================================');

  // 1. 清理
  fs.rmSync(RELEASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(RELEASE, 'server'), { recursive: true });
  fs.mkdirSync(path.join(RELEASE, 'static'), { recursive: true });

  // 2. 后端编译产物 + 生产依赖
  console.log('\n[1/4] 收集后端产物与生产依赖...');
  copyDir(path.join(SERVER_DIR, 'dist'), path.join(RELEASE, 'server', 'dist'));
  fs.copyFileSync(path.join(SERVER_DIR, 'package.json'), path.join(RELEASE, 'server', 'package.json'));
  run('npm install --omit=dev', path.join(RELEASE, 'server'));

  // 3. 前端静态资源
  console.log('\n[2/4] 收集前端静态资源...');
  copyDir(path.join(WEB_DIR, 'dist'), path.join(RELEASE, 'static'));

  // 4. 启动 / 停止脚本
  console.log('\n[3/4] 生成启动脚本...');
  const startSh = `#!/bin/bash
# DockerManager macOS 启动脚本（需要 Node.js >= 22）
set -e
cd "$(dirname "$0")/server"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装（brew install node@22）或从 https://nodejs.org 下载。"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 版本过低（当前 $(node -v)），需要 >= 22。"
  echo "macOS 安装：brew install node@22"
  exit 1
fi

export NODE_ENV=production
exec node dist/index.js
`;
  const stopSh = `#!/bin/bash
# 停止 DockerManager（查找并结束面板进程）
pkill -f "node .*server/dist/index.js" && echo "DockerManager 已停止" || echo "未发现运行中的 DockerManager"
`;
  fs.writeFileSync(path.join(RELEASE, 'start.sh'), startSh);
  fs.writeFileSync(path.join(RELEASE, 'stop.sh'), stopSh);
  fs.chmodSync(path.join(RELEASE, 'start.sh'), 0o755);
  fs.chmodSync(path.join(RELEASE, 'stop.sh'), 0o755);

  const readme = `DockerManager for macOS
========================

前置要求：
  1. Node.js >= 22（brew install node@22 或 https://nodejs.org 下载）
  2. Docker Desktop（启动并允许默认 Docker socket）

启动：
  1. 解压后进入 DockerManager 目录
  2. 双击或在终端执行:  ./start.sh
  3. 浏览器打开 http://localhost:9528

停止：  ./stop.sh
数据：   DockerManager/server/data/（SQLite 数据库与监控数据）
配置：   支持 DOCKER_HOST 环境变量覆盖 Docker 端点；
         默认自动探测 ~/.docker/run/docker.sock 与 /var/run/docker.sock。

默认账号 admin / 首次启动时控制台输出初始密码（与 Windows / Linux 版一致）。
`;
  fs.writeFileSync(path.join(RELEASE, 'README.txt'), readme);

  // 4. 产物统计
  console.log('\n[4/4] 打包完成');
  const size = (dir) => {
    let total = 0;
    const walk = (d) => {
      for (const item of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, item.name);
        if (item.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    walk(dir);
    return Math.round(total / 1024 / 1024);
  };
  console.log(`产物目录: ${RELEASE}（约 ${size(RELEASE)} MB）`);
}

main();
