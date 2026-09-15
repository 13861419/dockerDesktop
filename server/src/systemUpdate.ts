/**
 * 系统更新（1.26.0）
 *
 * 通过 GitHub Releases API 检查最新版本，并按当前平台给出更新方式指引。
 * - 支持 update.githubMirror 系统参数配置镜像前缀（国内网络可达性）；
 * - 结果缓存 10 分钟，避免频繁外呼；
 * - 版本比较为纯函数，便于单测。
 *
 * 一键更新（1.69.0）：自动检测安装类型（Windows 服务版 / deb / rpm），
 * 下载对应产物并校验 sha256，生成升级脚本（停服务 → 覆盖/安装 → 起服务）后
 * 以 detached 方式拉起并自退出。用户数据目录与安装目录分离，升级不丢数据。
 */
import { execSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting } from './settings';

const REPO_API = 'https://api.github.com/repos/13861419/dockerDesktop/releases/latest';
const CACHE_MS = 10 * 60 * 1000;

/** 内存缓存（进程内） */
let cache: { ts: number; data: UpdateCheckResult } | null = null;

export interface UpdateCheckResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl: string;
  notes: string;
  publishedAt: number | null;
  assets: Array<{ name: string; url: string; size: number; platform: string }>;
}

/** 语义化版本比较：返回 true 当 b > a */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((x) => parseInt(x, 10) || 0);
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

/** 按资产名匹配当前平台 */
export function platformOf(assetName: string): string {
  const n = assetName.toLowerCase();
  if (n.includes('win')) return 'windows';
  if (n.includes('macos') || n.includes('darwin')) return 'macos';
  if (n.includes('aarch64') || n.includes('arm64')) return 'linux-arm64';
  if (n.includes('x86_64') || n.includes('amd64')) return 'linux';
  if (n.includes('sha256')) return 'checksums';
  return 'other';
}

/** 检查更新（带 10 分钟缓存） */
export async function checkUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  if (cache && Date.now() - cache.ts < CACHE_MS) {
    return { ...cache.data, current: currentVersion, hasUpdate: isNewerVersion(currentVersion, cache.data.latest) };
  }
  const mirror = String(getSetting('update.githubMirror') || '').trim();
  const base = mirror ? `${mirror.replace(/\/+$/, '')}/api.github.com/repos/13861419/dockerDesktop/releases/latest` : REPO_API;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const resp = await fetch(base, {
      headers: { 'User-Agent': 'dockermanager', Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    const data = (await resp.json()) as any;
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    const result: UpdateCheckResult = {
      current: currentVersion,
      latest,
      hasUpdate: isNewerVersion(currentVersion, latest),
      releaseUrl: String(data.html_url || ''),
      notes: String(data.body || '').slice(0, 2000),
      publishedAt: data.published_at ? new Date(data.published_at).getTime() : null,
      assets: (data.assets || []).map((a: any) => {
        const url = String(a.browser_download_url || '');
        return {
          name: String(a.name || ''),
          url: mirror ? url.replace('https://github.com', mirror.replace(/\/+$/, '')) : url,
          size: Number(a.size || 0),
          platform: platformOf(a.name || ''),
        };
      }),
    };
    cache = { ts: Date.now(), data: result };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function clearUpdateCache(): void {
  cache = null as any;
}

/** 安装类型：windows-service=Windows 服务版（nssm） / deb / rpm / docker / manual=手动或开发 */
export type InstallType = 'windows-service' | 'deb' | 'rpm' | 'docker' | 'manual';

/** 检测当前安装类型（用于一键更新的可行性判断与产物选择） */
export function detectInstallType(): InstallType {
  if (process.platform === 'win32') {
    // 服务版：server/ 的上级目录（安装目录）带 nssm.exe 与 install.bat
    const installDir = path.resolve(process.cwd(), '..');
    if (fs.existsSync(path.join(installDir, 'nssm.exe'))) return 'windows-service';
    return 'manual';
  }
  try {
    if (fs.existsSync('/.dockerenv')) return 'docker';
  } catch { /* ignore */ }
  try {
    execSync('dpkg -s docker-manager', { stdio: 'ignore' });
    return 'deb';
  } catch { /* not deb */ }
  try {
    execSync('rpm -q docker-manager', { stdio: 'ignore' });
    return 'rpm';
  } catch { /* not rpm */ }
  return 'manual';
}

/** 安装类型的展示名与升级方式说明（docker / manual 只能提示，不能自升级） */
export function installTypeLabel(type: InstallType): { label: string; hint: string } {
  switch (type) {
    case 'windows-service':
      return { label: 'Windows 服务版', hint: '支持一键更新：自动停服务 → 覆盖程序 → 重启服务' };
    case 'deb':
      return { label: 'deb 包（systemd）', hint: '支持一键更新：自动 dpkg 安装并重启服务' };
    case 'rpm':
      return { label: 'rpm 包（systemd）', hint: '支持一键更新：自动 rpm 安装并重启服务' };
    case 'docker':
      return { label: 'Docker 镜像', hint: '请在宿主机执行 docker pull 新镜像并重建容器' };
    default:
      return { label: '手动安装 / 开发模式', hint: '请参考文档手动下载并替换程序' };
  }
}

/** 按安装类型与 CPU 架构挑选升级包资产名 */
export function pickAssetName(type: InstallType, latest: string): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const rpmArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  switch (type) {
    case 'windows-service':
      return 'DockerManager-windows-amd64.zip';
    case 'deb':
      return `docker-manager-${latest}-${arch}.deb`;
    case 'rpm':
      return `docker-manager-${latest}-1.${rpmArch}.rpm`;
    default:
      return null;
  }
}

/** 下载文件（自动跟随重定向，最长 10 分钟，产物约 5-15MB） */
export async function downloadFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'dockermanager' },
    redirect: 'follow',
    signal: AbortSignal.timeout(600_000),
  });
  if (!resp.ok || !resp.body) throw new Error(`下载失败：HTTP ${resp.status}`);
  const tmp = dest + '.part';
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

/** 用 sha256sums.txt 校验已下载的产物 */
export function verifySha256(file: string, sumsContent: string, assetName: string): void {
  const line = sumsContent
    .split('\n')
    .find((l) => l.trimEnd().endsWith(assetName) || l.trimEnd().endsWith('*' + assetName));
  if (!line) throw new Error('sha256sums.txt 中未找到该更新包，无法校验完整性');
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toLowerCase();
  if (expected !== actual) throw new Error('更新包完整性校验失败（sha256 不匹配），已中止更新');
}

/** 升级暂存目录（放在数据目录下，与安装目录分离） */
function stagingDir(): string {
  const base = process.env.DOCKERMANAGER_DATA || path.join(os.tmpdir(), 'docker-manager-update');
  const dir = path.join(base, 'update-staging');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 生成 Windows 服务版升级脚本：停服务 → 解压覆盖 → 起服务 */
function writeWindowsUpdater(staging: string, zipPath: string, installDir: string): string {
  const bat = [
    '@echo off',
    'rem DockerManager 一键升级脚本（由面板生成）',
    'timeout /t 2 /nobreak >nul',
    `"${path.join(installDir, 'nssm.exe')}" stop DockerManager`,
    'timeout /t 3 /nobreak >nul',
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${path.join(staging, 'extract')}' -Force"`,
    `robocopy "${path.join(staging, 'extract', 'DockerManager')}" "${installDir}" /E /NFL /NDL /NJH /NJS /NP`,
    `"${path.join(installDir, 'nssm.exe')}" start DockerManager`,
    '',
  ].join('\r\n');
  const file = path.join(staging, 'update.bat');
  fs.writeFileSync(file, bat, 'utf8');
  return file;
}

/** 生成 deb/rpm 升级脚本：停服务 → 安装包 → 起服务 */
function writeLinuxUpdater(staging: string, type: 'deb' | 'rpm', pkgPath: string): string {
  const install =
    type === 'deb'
      ? `dpkg -i "${pkgPath}" || (apt-get install -y -f && dpkg -i "${pkgPath}")`
      : `rpm -Uvh --replacepkgs "${pkgPath}"`;
  const sh = [
    '#!/bin/bash',
    '# DockerManager 一键升级脚本（由面板生成）',
    'sleep 2',
    'systemctl stop docker-manager 2>/dev/null || true',
    install,
    'systemctl start docker-manager',
    '',
  ].join('\n');
  const file = path.join(staging, 'update.sh');
  fs.writeFileSync(file, sh, 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

export interface ApplyResult {
  asset: string;
  script: string;
  message: string;
}

/**
 * 执行一键更新：下载 → 校验 → 生成升级脚本 → detached 拉起（调用方随后自退出）
 * @throws 安装类型不支持 / 产物缺失 / 校验失败时抛错（路由返回 400）
 */
export async function applyUpdate(currentVersion: string): Promise<ApplyResult> {
  const type = detectInstallType();
  if (type !== 'windows-service' && type !== 'deb' && type !== 'rpm') {
    const { label, hint } = installTypeLabel(type);
    throw new Error(`当前安装类型（${label}）暂不支持面板内一键更新。${hint}`);
  }
  const info = await checkUpdate(currentVersion);
  if (!info.hasUpdate) throw new Error('当前已是最新版本，无需更新');
  const assetName = pickAssetName(type, info.latest);
  const asset = info.assets.find((a) => a.name === assetName);
  if (!assetName || !asset) throw new Error(`最新版本 ${info.latest} 未找到匹配当前平台的更新包`);

  const staging = stagingDir();
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const pkgPath = path.join(staging, asset.name);
  const sumsPath = path.join(staging, 'sha256sums.txt');

  // 下载产物与校验文件（在进程退出前完成全部网络与校验工作）
  await downloadFile(asset.url, pkgPath);
  const sumsAsset = info.assets.find((a) => a.platform === 'checksums');
  if (!sumsAsset) throw new Error('最新版本缺少 sha256sums.txt，无法校验完整性');
  await downloadFile(sumsAsset.url, sumsPath);
  verifySha256(pkgPath, fs.readFileSync(sumsPath, 'utf8'), asset.name);

  // 生成并拉起升级脚本（detached，面板退出后仍继续执行）
  let script: string;
  if (type === 'windows-service') {
    const installDir = path.resolve(process.cwd(), '..');
    script = writeWindowsUpdater(staging, pkgPath, installDir);
  } else {
    script = writeLinuxUpdater(staging, type, pkgPath);
  }
  if (type === 'windows-service') {
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn('bash', [script], { detached: true, stdio: 'ignore' }).unref();
  }
  return {
    asset: asset.name,
    script,
    message: `更新包 ${asset.name} 已下载并校验通过，正在执行升级，服务将重启`,
  };
}
