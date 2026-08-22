/**
 * 跨平台宿主机磁盘分区信息采集
 *
 * Windows：通过 wmic logicaldisk where DriveType=3 获取固定磁盘分区
 * Linux：通过 df -kP 获取真实磁盘分区（过滤 tmpfs/devtmpfs 等虚拟文件系统）
 *
 * 输出统一为 { mount, total, free, used, percent } 结构，
 * 供 monitor.ts 的 getDiskPartitions() 调用。
 */
import { isWindows } from './detect';

/** 单个磁盘分区信息 */
export interface DiskPartition {
  /** 挂载点：Windows 为盘符如 "C:"；Linux 为路径如 "/" */
  mount: string;
  /** 分区总容量（字节） */
  total: number;
  /** 分区剩余空间（字节） */
  free: number;
  /** 分区已用空间（字节） */
  used: number;
  /** 使用率百分比（0-100） */
  percent: number;
}

/** 需要过滤的 Linux 虚拟文件系统类型 */
const LINUX_VIRTUAL_FS = new Set([
  'tmpfs', 'devtmpfs', 'sysfs', 'proc', 'devpts', 'securityfs',
  'cgroup', 'cgroup2', 'pstore', 'bpf', 'debugfs', 'hugetlbfs',
  'mqueue', 'fusectl', 'configfs', 'overlay', 'squashfs',
]);

/**
 * 通过 wmic 获取 Windows 固定磁盘分区
 * DriveType=3 表示本地固定磁盘（排除光驱、可移动盘等）
 */
function getWindowsPartitions(): DiskPartition[] {
  try {
    const cp = require('child_process');
    const out: string = cp.execSync(
      'wmic logicaldisk where DriveType=3 get DeviceID,Size,FreeSpace /value',
      { encoding: 'utf8' },
    );
    const result: DiskPartition[] = [];
    let current: { mount: string; total: number; free: number } | null = null;
    for (const raw of out.split(/\r+\n?/)) {
      const line = raw.trim();
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'DeviceID') {
        if (current && current.total > 0) {
          result.push({
            mount: current.mount,
            total: current.total,
            free: current.free,
            used: current.total - current.free,
            percent: Number((((current.total - current.free) / current.total) * 100).toFixed(1)),
          });
        }
        current = { mount: value, total: 0, free: 0 };
      } else if (current) {
        if (key === 'Size') current.total = Number(value) || 0;
        else if (key === 'FreeSpace') current.free = Number(value) || 0;
      }
    }
    if (current && current.total > 0) {
      result.push({
        mount: current.mount,
        total: current.total,
        free: current.free,
        used: current.total - current.free,
        percent: Number((((current.total - current.free) / current.total) * 100).toFixed(1)),
      });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 通过 df -kP 获取 Linux 真实磁盘分区
 * -k 以 KB 为单位；-P 使用 POSIX 输出格式（挂载点无空格时每行一个分区）
 * 过滤掉 tmpfs/devtmpfs 等虚拟文件系统
 */
function getLinuxPartitions(): DiskPartition[] {
  try {
    const cp = require('child_process');
    const out: string = cp.execSync('df -kP', { encoding: 'utf8' });
    const result: DiskPartition[] = [];
    let headerSkipped = false;
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (!headerSkipped) { headerSkipped = true; continue; }
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      const [filesystem, , totalK, usedK, availK, , mount] = parts;
      // 过滤虚拟文件系统（按文件系统名称和挂载点前缀判断）
      const fsBase = filesystem.split('/').pop() || '';
      if (LINUX_VIRTUAL_FS.has(fsBase)) continue;
      if (mount.startsWith('/dev') || mount.startsWith('/sys') || mount.startsWith('/proc')) continue;
      const total = Number(totalK) * 1024;
      const used = Number(usedK) * 1024;
      const free = Number(availK) * 1024;
      if (total <= 0) continue;
      result.push({
        mount,
        total,
        free,
        used,
        percent: Number(((used / total) * 100).toFixed(1)),
      });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * 获取当前平台的宿主机磁盘分区信息（统一接口）
 * @returns 各分区明细数组
 */
export function getDiskPartitions(): DiskPartition[] {
  if (isWindows()) return getWindowsPartitions();
  return getLinuxPartitions();
}
