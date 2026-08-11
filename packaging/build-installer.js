/**
 * 一键生成安装包脚本
 *
 * 流程：
 *  1. 调用 build-release.js 生成发布目录 dist-release/DockerManager
 *  2. 用 NSIS (makensis) 将发布目录编译成 setup.exe
 *  3. 将 setup.exe 复制到项目根目录
 *
 * 用法: node packaging/build-installer.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER_DIR = path.join(ROOT, 'packaging', 'installer');
const RELEASE_DIR = path.join(ROOT, 'dist-release', 'DockerManager');
const NSI = path.join(INSTALLER_DIR, 'install.nsi');

/** 在 packaging/nsis 下递归查找 makensis.exe */
function findMakensis() {
  const searchDirs = [path.join(ROOT, 'packaging', 'nsis')];
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === 'makensis.exe') return full;
      }
    }
  }
  return null;
}

/** 确保 NSIS 脚本为 UTF-8 with BOM（否则 makensis 无法解析中文） */
function ensureUtf8Bom(file) {
  const buf = fs.readFileSync(file);
  if (!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)) {
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]));
    console.log('已为 install.nsi 添加 UTF-8 BOM');
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.error('打包安装包仅支持 Windows');
    process.exit(1);
  }

  // 1. 构建发布目录
  console.log('\n========== [1/3] 构建发布目录 ==========');
  execSync('node ' + JSON.stringify(path.join(ROOT, 'packaging', 'build-release.js')), {
    cwd: ROOT,
    stdio: 'inherit',
    shell: 'cmd.exe',
  });

  // 2. 确保 install.nsi 编码正确，然后编译 NSIS
  console.log('\n========== [2/3] 编译安装包 (NSIS) ==========');
  const makensis = findMakensis();
  if (!makensis) {
    console.error('未找到 makensis.exe，请先将 NSIS 解压到 packaging/nsis 目录');
    process.exit(1);
  }
  ensureUtf8Bom(NSI);
  execSync(
    `"${makensis}" /DRELEASE_DIR=${RELEASE_DIR} "${NSI}"`,
    { cwd: INSTALLER_DIR, stdio: 'inherit', shell: 'cmd.exe' },
  );

  // 3. 复制 setup.exe 到根目录
  console.log('\n========== [3/3] 复制安装包到根目录 ==========');
  const built = fs
    .readdirSync(INSTALLER_DIR)
    .filter((f) => f.endsWith('.exe') && f.startsWith('DockerManager-setup'))
    .sort()
    .pop();
  if (!built) {
    console.error('未找到生成的 setup.exe');
    process.exit(1);
  }
  const target = path.join(ROOT, built);
  fs.copyFileSync(path.join(INSTALLER_DIR, built), target);
  console.log(`安装包已生成: ${target}`);

  console.log('\n==========================================');
  console.log('一键安装包制作完成！');
  console.log('在目标 Windows 电脑上运行该 setup.exe 即可完成安装。');
  console.log('==========================================');
}

main();
