/**
 * 平台与发行版检测抽象
 *
 * 全项目唯一直接调用 os.platform() 与 /etc/os-release 的模块，
 * 供其它业务模块通过此处判断 Windows / Linux / Ubuntu / CentOS 及默认 shell，
 * 避免平台判断散落到各业务代码中。
 */
import os from 'os';
import fs from 'fs';

export type PlatformName = 'win32' | 'linux' | 'darwin' | 'unknown';

/** 当前操作系统平台 */
export function getPlatform(): PlatformName {
  const p = os.platform();
  if (p === 'win32' || p === 'linux' || p === 'darwin') return p;
  return 'unknown';
}

/** 是否 Windows */
export function isWindows(): boolean {
  return getPlatform() === 'win32';
}

/** 是否 Linux（含 Ubuntu / CentOS） */
export function isLinux(): boolean {
  return getPlatform() === 'linux';
}

/** 发行版信息（来自 /etc/os-release） */
export interface DistroInfo {
  id: string;
  versionId: string;
  name: string;
}

let cachedDistro: DistroInfo | null = null;

/**
 * 读取当前 Linux 发行版信息
 * @returns 发行版信息；非 Linux 平台返回 null，读取失败返回带空字段的对象
 */
export function getDistro(): DistroInfo | null {
  if (!isLinux()) return null;
  if (cachedDistro) return cachedDistro;
  const info: DistroInfo = { id: '', versionId: '', name: '' };
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf8');
    const pick = (key: string): string => {
      const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (!m) return '';
      let v = m[1].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return v;
    };
    info.id = pick('ID');
    info.versionId = pick('VERSION_ID');
    info.name = pick('NAME');
    cachedDistro = info;
  } catch {
    return info;
  }
  return cachedDistro;
}

export type ShellName = 'powershell' | 'cmd' | 'bash' | 'sh' | 'zsh';

/** 当前平台可用的宿主 shell 列表（优先级在前） */
export function getDefaultShells(): ShellName[] {
  if (isWindows()) return ['cmd', 'powershell'];
  if (isLinux()) return ['bash', 'sh'];
  // macOS（darwin）：默认 zsh
  return ['zsh', 'sh'];
}

/** 当前平台默认 shell */
export function getDefaultShell(): ShellName {
  return getDefaultShells()[0];
}

/** 是否 Ubuntu（需 Linux 平台） */
export function isUbuntu(): boolean {
  const d = getDistro();
  return !!d && d.id === 'ubuntu';
}

/** 是否 CentOS（需 Linux 平台） */
export function isCentOS(): boolean {
  const d = getDistro();
  return !!d && d.id === 'centos';
}
