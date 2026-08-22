/**
 * Docker 管理面板 - 一键发布打包脚本（跨平台）
 *
 * 流程：
 *  1. 清理旧的发布目录
 *  2. 构建前端 (web/dist)
 *  3. 编译后端 (server/dist) 并收集生产依赖 (server/node_modules, 仅生产)
 *  4. 组装发布目录 dist-release/DockerManager
 *      Windows: nssm.exe / TrayApp.exe / install.bat / uninstall.bat
 *      Linux:   systemd unit / install.sh
 *  5. (Linux) 调用 build-deb.sh / build-rpm.sh 生成安装包
 *
 * 用法: node packaging/build-release.js [--linux-only]
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const SERVER_DIR = path.join(ROOT, 'server');
const PACKAGING_DIR = path.join(ROOT, 'packaging');
const RELEASE = path.join(ROOT, 'dist-release', 'DockerManager');
const LINUX_DIR = path.join(PACKAGING_DIR, 'linux');
const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

/** 执行命令并打印 */
function run(cmd, cwd) {
  console.log(`\n>>> ${cmd}`);
  const shell = isWin ? 'cmd.exe' : '/bin/bash';
  execSync(cmd, { cwd, stdio: 'inherit', shell });
}

/** 复制目录 */
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

function copyFileIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log('  已复制: ' + path.basename(src));
  } else {
    console.warn('  警告: 缺少文件 ' + src);
  }
}

function main() {
  const linuxOnly = process.argv.includes('--linux-only');

  console.log('==========================================');
  console.log('  DockerManager 一键发布打包');
  console.log(`  平台: ${isWin ? 'Windows' : isLinux ? 'Linux' : '未知'}`);
  console.log('==========================================');

  // 1. 清理旧发布目录
  console.log('\n[1/5] 清理旧发布目录...');
  fs.rmSync(RELEASE, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(RELEASE), { recursive: true });

  // 2. 构建前端
  console.log('\n[2/5] 构建前端 (web)...');
  run('npm run build', WEB_DIR);
  const webDist = path.join(WEB_DIR, 'dist');
  if (!fs.existsSync(webDist)) {
    console.error('前端构建产物缺失: ' + webDist);
    process.exit(1);
  }

  // 3. 编译后端 + 收集生产依赖
  console.log('\n[3/5] 编译后端 (server)...');
  run('npx tsc', SERVER_DIR);
  const serverDist = path.join(SERVER_DIR, 'dist');
  if (!fs.existsSync(serverDist)) {
    console.error('后端编译产物缺失: ' + serverDist);
    process.exit(1);
  }

  // 4. 收集后端生产依赖到 release/server
  console.log('\n[4/5] 收集后端生产依赖...');
  const releaseServer = path.join(RELEASE, 'server');
  copyDir(serverDist, path.join(releaseServer, 'dist'));
  fs.mkdirSync(releaseServer, { recursive: true });
  fs.copyFileSync(path.join(SERVER_DIR, 'package.json'), path.join(releaseServer, 'package.json'));
  run('npm install --omit=dev', releaseServer);

  // 复制前端静态资源为 static/
  copyDir(webDist, path.join(RELEASE, 'static'));

  // 5. 组装平台特定辅助文件
  console.log('\n[5/5] 组装运行辅助文件...');
  if (isWin) {
    // Windows: nssm + tray + bat
    copyFileIfExists(path.join(PACKAGING_DIR, 'nssm', 'nssm.exe'), path.join(RELEASE, 'nssm.exe'));
    copyFileIfExists(path.join(PACKAGING_DIR, 'tray', 'TrayApp.exe'), path.join(RELEASE, 'TrayApp.exe'));
    copyFileIfExists(path.join(PACKAGING_DIR, 'installer', 'install.bat'), path.join(RELEASE, 'install.bat'));
    copyFileIfExists(path.join(PACKAGING_DIR, 'installer', 'uninstall.bat'), path.join(RELEASE, 'uninstall.bat'));
  } else if (isLinux) {
    // Linux: systemd unit + install.sh
    const systemdSrc = path.join(LINUX_DIR, 'docker-manager.service');
    const systemdDest = path.join(RELEASE, 'docker-manager.service');
    copyFileIfExists(systemdSrc, systemdDest);

    const installShSrc = path.join(LINUX_DIR, 'install.sh');
    const installShDest = path.join(RELEASE, 'install.sh');
    copyFileIfExists(installShSrc, installShDest);

    // 为 install.sh 添加可执行权限
    if (fs.existsSync(installShDest)) {
      fs.chmodSync(installShDest, 0o755);
    }

    // 生成 .env 模板
    const envContent = [
      'PORT=9528',
      'HOST=0.0.0.0',
      'WEB_DIR=/opt/docker-manager/static',
      'DATA_DIR=/var/lib/docker-manager',
    ].join('\n');
    fs.writeFileSync(path.join(releaseServer, '.env'), envContent + '\n');
  }

  console.log('\n==========================================');
  console.log('打包完成！生成目录: ' + RELEASE);
  if (isWin) {
    console.log('接下来可用 NSIS 将 dist-release/DockerManager 打成一个 setup.exe，');
    console.log('或在安装目录直接双击 install.bat 完成服务注册与开机自启。');
  } else if (isLinux) {
    console.log('Linux 平台额外包生成:');
    console.log('  .deb: bash packaging/linux/build-deb.sh [amd64|arm64]');
    console.log('  .rpm: bash packaging/linux/build-rpm.sh [x86_64|aarch64]');
  }
  console.log('==========================================');

  // Linux 可选：自动生成 deb/rpm
  if (isLinux && !linuxOnly) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const rpmArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';

    console.log('\n[可选] 生成 Linux 安装包...');
    try {
      run(`bash ${path.join(LINUX_DIR, 'build-deb.sh')} ${arch}`, ROOT);
    } catch (e) {
      console.warn('  .deb 构建跳过（需要 Docker）');
    }
    try {
      run(`bash ${path.join(LINUX_DIR, 'build-rpm.sh')} ${rpmArch}`, ROOT);
    } catch (e) {
      console.warn('  .rpm 构建跳过（需要 Docker）');
    }
  }
}

main();
