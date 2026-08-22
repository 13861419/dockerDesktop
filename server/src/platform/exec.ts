/**
 * 跨平台宿主命令执行辅助
 *
 * 统一封装宿主 shell 的二进制选择与命令/参数转义，
 * 供 backup / dbBackup / databases 等把原先写死 'cmd.exe' 的调用改为按平台取值，
 * 避免命令在 Linux /bin/bash 下因 shell 与引号差异而失效。
 */
import { isWindows } from './detect';

export interface HostShell {
  binary: string;
  flag: string;
  quote: (arg: string) => string;
}

/**
 * 获取当前平台的宿主 shell 配置
 * @returns shell 二进制、命令行执行标志与单参数转义函数
 */
export function getHostShell(): HostShell {
  if (isWindows()) {
    return {
      binary: 'cmd.exe',
      flag: '/C',
      quote: (arg) => `"${String(arg).replace(/"/g, '\\"')}"`,
    };
  }
  return {
    binary: '/bin/bash',
    flag: '-c',
    quote: (arg) => `'${String(arg).replace(/'/g, "'\\''")}'`,
  };
}

/** 供 child_process.exec 的 shell 选项使用：返回平台对应宿主 shell 二进制 */
export function hostShellForExec(): string {
  return getHostShell().binary;
}

/** 对含路径 / 空格的单个参数按平台做安全转义 */
export function quoteForHost(arg: string): string {
  return getHostShell().quote(arg);
}
