/**
 * Docker 管理面板 - 一键发布打包脚本
 *
 * 流程：
 *  1. 清理旧的发布目录
 *  2. 构建前端 (web/dist)
 *  3. 编译后端 (server/dist) 并收集生产依赖 (server/node_modules, 仅生产)
 *  4. 组装发布目录 dist-release/DockerManager
 *      ├─ server/            后端代码与生产依赖
 *      ├─ static/            前端静态资源
 *      ├─ nssm.exe           Windows 服务管理器
 *      ├─ TrayApp.exe        系统托盘程序
 *      ├─ install.bat        一键安装
 *      └─ uninstall.bat      一键卸载
 *
 * 用法: node packaging/build-release.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const SERVER_DIR = path.join(ROOT, 'server');
const PACKAGING_DIR = path.join(ROOT, 'packaging');
const RELEASE = path.join(ROOT, 'dist-release', 'DockerManager');

/** 执行命令并打印 */
function run(cmd, cwd) {
  console.log(`\n>>> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: 'cmd.exe' });
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

function main() {
  if (process.platform !== 'win32') {
    console.error('该打包脚本仅支持 Windows 平台');
    process.exit(1);
  }

  console.log('==========================================');
  console.log('  DockerManager 一键发布打包');
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

  // 收集生产依赖到已有 release/server/node_modules
  console.log('\n[4/5] 收集后端生产依赖...');
  const releaseServer = path.join(RELEASE, 'server');
  copyDir(serverDist, path.join(releaseServer, 'dist'));
  // package.json 为单个文件，用 copyFileSync 复制
  fs.mkdirSync(releaseServer, { recursive: true });
  fs.copyFileSync(path.join(SERVER_DIR, 'package.json'), path.join(releaseServer, 'package.json'));
  // 在发布目录内独立安装生产依赖，避免带入 devDependencies
  run('npm install --omit=dev', releaseServer);

  // 复制前端静态资源为 static/
  copyDir(webDist, path.join(RELEASE, 'static'));

  // 5. 组装辅助文件
  console.log('\n[5/5] 组装运行辅助文件...');
  copyFileIfExists(path.join(PACKAGING_DIR, 'nssm', 'nssm.exe'), path.join(RELEASE, 'nssm.exe'));
  copyFileIfExists(path.join(PACKAGING_DIR, 'tray', 'TrayApp.exe'), path.join(RELEASE, 'TrayApp.exe'));
  copyFileIfExists(path.join(PACKAGING_DIR, 'installer', 'install.bat'), path.join(RELEASE, 'install.bat'));
  copyFileIfExists(path.join(PACKAGING_DIR, 'installer', 'uninstall.bat'), path.join(RELEASE, 'uninstall.bat'));

  console.log('\n==========================================');
  console.log('打包完成！生成目录: ' + RELEASE);
  console.log('接下来可用 NSIS 将 dist-release/DockerManager 打成一个 setup.exe，');
  console.log('或在安装目录直接双击 install.bat 完成服务注册与开机自启。');
  console.log('==========================================');
}

function copyFileIfExists(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log('  已复制: ' + path.basename(src));
  } else {
    console.warn('  警告: 缺少文件 ' + src);
  }
}

main();
