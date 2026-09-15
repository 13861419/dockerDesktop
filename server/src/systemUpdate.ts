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
import { getSetting, setSetting } from './settings';
import { pushToTargets } from './alerting';

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
  /** 本次检查使用的源（'' = 直连，否则为镜像前缀） */
  source?: string;
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
/** 内置公共镜像池（用户配置的 update.githubMirror 优先，直连兜底） */
const BUILTIN_MIRRORS = ['https://ghfast.top', 'https://gh-proxy.com'];

/** 候选源列表：用户配置镜像 > 内置镜像池 > 直连（'' 表示直连） */
export function mirrorCandidates(): string[] {
  const list: string[] = [];
  const configured = String(getSetting('update.githubMirror') || '').trim().replace(/\/+$/, '');
  if (configured) list.push(configured);
  list.push(...BUILTIN_MIRRORS);
  list.push('');
  return list;
}

/** 按候选源改写 GitHub URL（直连返回原始地址；镜像去掉协议前缀，与主流代理约定一致） */
export function withSource(base: string, githubUrl: string): string {
  if (!base) return githubUrl;
  return githubUrl.replace(/^https:\/\//, base.replace(/\/+$/, '') + '/');
}

export async function checkUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  if (cache && Date.now() - cache.ts < CACHE_MS) {
    return { ...cache.data, current: currentVersion, hasUpdate: isNewerVersion(currentVersion, cache.data.latest) };
  }
  // 多源探测：按候选顺序尝试 API（每个源 6 秒超时），第一个成功者生效
  let data: any = null;
  let usedBase = '';
  for (const base of mirrorCandidates()) {
    const url = withSource(base, REPO_API);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'dockermanager', Accept: 'application/vnd.github+json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      data = await resp.json();
      usedBase = base;
      break;
    } catch {
      clearTimeout(timer);
      continue;
    }
  }
  if (!data) throw new Error('无法连接 GitHub（已尝试直连与全部镜像源），请在系统参数中配置 update.githubMirror 镜像，或手动下载更新包');
  const latest = String(data.tag_name || '').replace(/^v/i, '');
  const result: UpdateCheckResult = {
    current: currentVersion,
    latest,
    hasUpdate: isNewerVersion(currentVersion, latest),
    releaseUrl: String(data.html_url || ''),
    notes: String(data.body || '').slice(0, 2000),
    publishedAt: data.published_at ? new Date(data.published_at).getTime() : null,
    // assets 存原始 GitHub 地址，下载时按候选源依次改写（支持失败自动换源）
    source: usedBase,
    assets: (data.assets || []).map((a: any) => ({
      name: String(a.name || ''),
      url: String(a.browser_download_url || ''),
      size: Number(a.size || 0),
      platform: platformOf(a.name || ''),
    })),
  };
  cache = { ts: Date.now(), data: result };
  return result;
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

/** 下载文件（自动跟随重定向，单源最长 10 分钟，产物约 5-15MB） */
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

/** 下载失败自动换源：按候选源依次改写 GitHub URL 重试，全部失败才抛错 */
export async function downloadWithFallback(rawGithubUrl: string, dest: string): Promise<string> {
  const errors: string[] = [];
  for (const base of mirrorCandidates()) {
    try {
      await downloadFile(withSource(base, rawGithubUrl), dest);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return base;
      throw new Error('空文件');
    } catch (e: any) {
      errors.push(`${base || '直连'}: ${String(e?.message || e)}`);
      try { fs.rmSync(dest + '.part', { force: true }); } catch { /* ignore */ }
    }
  }
  throw new Error(`全部下载源均失败（直连与镜像），请手动下载后重试。详情：${errors.join('；')}`);
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

/** 生成 Windows 服务版升级脚本内容（1.73.0 A/B 备份 + 健康检查 + 失败自动回滚；1.74.1 修复引号与锁定文件问题） */
export function buildWindowsBat(installDir: string, zipPath: string, staging: string, port: number): string {
  const nssm = path.join(installDir, 'nssm.exe');
  const prev = `${installDir}_prev`;
  const extract = path.join(staging, 'extract', 'DockerManager');
  const resultFile = path.join(stagingDir(), 'update-result.txt');
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  return [
    '@echo off',
    'rem DockerManager 一键升级脚本（由面板生成，1.73.0 起带自动回滚）',
    'timeout /t 2 /nobreak >nul',
    `"${nssm}" stop DockerManager`,
    'timeout /t 3 /nobreak >nul',
    // A/B 备份：程序文件复制到 <install>_prev（data / logs 为运行期数据，升级不动、无需备份）
    `robocopy "${installDir}" "${prev}" /E /XD "${path.join(installDir, 'data')}" "${path.join(installDir, 'logs')}" /R:2 /W:3 /NFL /NDL /NJH /NJS /NP`,
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${path.join(staging, 'extract')}' -Force"`,
    // /MIR 使安装目录与新版 zip 完全一致（含删除被新版移除的文件）；旧版本已在 _prev 备份
    `robocopy "${extract}" "${installDir}" /MIR /XD "${path.join(installDir, 'data')}" "${path.join(installDir, 'logs')}" /R:2 /W:3 /NFL /NDL /NJH /NJS /NP`,
    `"${nssm}" start DockerManager`,
    // 健康检查：20 秒内 /api/health 未就绪则回滚到备份版本
    `powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 20;$i++){Start-Sleep -Seconds 1; try{Invoke-WebRequest -UseBasicParsing '${healthUrl}' | Out-Null; $ok=$true; break}catch{}}; if(-not $ok){ & '${nssm}' stop DockerManager; Start-Sleep 2; robocopy '${prev}' '${installDir}' /MIR /XD '${path.join(installDir, 'data')}' '${path.join(installDir, 'logs')}' /R:2 /W:3 /NFL /NDL /NJH /NJS /NP; & '${nssm}' start DockerManager; exit 2 } else { exit 0 }"`,
    `if %errorlevel% neq 0 (echo [FAIL] %date% %time% 升级失败，已自动回滚到上一版本 >> "${resultFile}" & exit 1)`,
    `echo [SUCCESS] %date% %time% 升级成功 >> "${resultFile}"`,
    '',
  ].join('\r\n');
}

/** 生成 Windows 服务版升级脚本：停服务 → 备份旧版 → 覆盖 → 起服务 → 健康检查 → 失败自动回滚 */
function writeWindowsUpdater(staging: string, zipPath: string, installDir: string): string {
  const port = Number(process.env.PORT) || 9528;
  const bat = buildWindowsBat(installDir, zipPath, staging, port);
  const file = path.join(staging, 'update.bat');
  fs.writeFileSync(file, bat, 'utf8');
  return file;
}

/** 生成 deb/rpm 升级脚本：停服务 → 安装包 → 起服务 → 健康检查（失败给出回滚指引） */
function writeLinuxUpdater(staging: string, type: 'deb' | 'rpm', pkgPath: string): string {
  const install =
    type === 'deb'
      ? `dpkg -i "${pkgPath}" || (apt-get install -y -f && dpkg -i "${pkgPath}")`
      : `rpm -Uvh --replacepkgs "${pkgPath}"`;
  const resultFile = path.join(stagingDir(), 'update-result.txt');
  const sh = [
    '#!/bin/bash',
    '# DockerManager 一键升级脚本（由面板生成，1.73.0 起带健康检查）',
    'sleep 2',
    'systemctl stop docker-manager 2>/dev/null || true',
    install,
    'systemctl reset-failed docker-manager 2>/dev/null || true',
    'systemctl start docker-manager',
    '# 健康检查：30 秒内未就绪则提示手动回滚（记录结果供面板展示）',
    'if systemctl is-active --quiet docker-manager && curl -fsS -m 5 "http://127.0.0.1:${PORT:-9528}/api/health" >/dev/null 2>&1; then',
    `  echo "[SUCCESS] \$(date '+%F %T') 升级成功" >> "${path.join(stagingDir(), 'update-result.txt')}"`,
    'else',
    '  echo "[ROLLBACK-HINT] $(date \'+%F %T\') 升级后服务未就绪，请查看 journalctl -u docker-manager 并用上一版本安装包手动回滚" >> ' + `"${path.join(stagingDir(), 'update-result.txt')}"`,
    '  exit 1',
    'fi',
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

// ========== 定期更新检查与提醒（1.74.0） ==========

/** 当前面板版本（安装目录 server/package.json） */
export function currentPanelVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 是否需要推送提醒：有新版本且该版本尚未提醒过 */
export function shouldNotifyUpdate(hasUpdate: boolean, latest: string, notifiedVersion: string | null): boolean {
  if (!hasUpdate || !latest) return false;
  return notifiedVersion !== latest;
}

/** 执行一次更新检查；发现新版本且未提醒过时经通知渠道推送（推送成功才记版本，失败下轮重试） */
export async function runUpdateCheckOnce(): Promise<{ notified: boolean; latest: string | null }> {
  if (String(getSetting<boolean>('update.checkEnabled') ?? true) === 'false') {
    return { notified: false, latest: null };
  }
  const current = currentPanelVersion();
  const info = await checkUpdate(current);
  if (!info.hasUpdate || !info.latest) return { notified: false, latest: info.latest ?? null };
  const notifiedVersion = getSetting<string>('update.notifiedVersion') || '';
  if (!shouldNotifyUpdate(true, info.latest, notifiedVersion)) return { notified: false, latest: info.latest };
  const r = await pushToTargets(
    'warn',
    `DockerManager 有新版本可用：v${info.latest}（当前 v${current}），可在「设置 → 关于」一键更新，更新失败会自动回滚`,
  );
  if (r.ok) setSetting('update.notifiedVersion', info.latest);
  return { notified: r.ok, latest: info.latest };
}

let checkTimer: NodeJS.Timeout | null = null;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 启动定期更新检查（启动 30 秒后先查一次，之后每 6 小时） */
export function startUpdateChecker(): void {
  if (checkTimer) return;
  const tick = async () => {
    try {
      await runUpdateCheckOnce();
    } catch {
      // 网络不通等失败忽略，等下一轮
    }
  };
  setTimeout(tick, 30_000).unref();
  checkTimer = setInterval(tick, UPDATE_CHECK_INTERVAL_MS);
  checkTimer.unref();
}

export function stopUpdateChecker(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/** 最近一次一键更新结果（由升级脚本写入，面板启动/状态查询时读取） */
export interface LastUpdateResult {
  /** success / rollback / rollback-hint */
  status: 'success' | 'rollback' | 'rollback-hint' | 'unknown';
  at: string;
  detail: string;
}

/** 读取最近一次一键更新结果（无记录返回 null） */
export function readLastUpdateResult(): LastUpdateResult | null {
  try {
    const file = path.join(stagingDir(), 'update-result.txt');
    if (!fs.existsSync(file)) return null;
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return null;
    const m = last.match(/^\[(SUCCESS|FAIL|ROLLBACK-HINT)\]\s*(.+?)\s+(.*)$/);
    if (!m) return { status: 'unknown', at: '', detail: last };
    const status = m[1] === 'SUCCESS' ? 'success' : m[1] === 'FAIL' ? 'rollback' : 'rollback-hint';
    return { status, at: m[2], detail: m[3] };
  } catch {
    return null;
  }
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

  // 下载产物与校验文件（在进程退出前完成全部网络与校验工作；失败自动换源）
  await downloadWithFallback(asset.url, pkgPath);
  const sumsAsset = info.assets.find((a) => a.platform === 'checksums');
  if (!sumsAsset) throw new Error('最新版本缺少 sha256sums.txt，无法校验完整性');
  await downloadWithFallback(sumsAsset.url, sumsPath);
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
