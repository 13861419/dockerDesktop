/**
 * 宿主机 root 提权通道（1.34.1）
 *
 * 面板服务常以低权限用户运行（如 systemd User=dockerman），此时：
 *  - 宿主机终端 / 命令执行器只能以该用户身份运行；
 *  - sudo 因服务账号无密码、不在 sudoers 以及 systemd NoNewPrivileges
 *    限制而不可用（setuid 提权被内核拒绝）。
 *
 * 服务账号天然具备 docker 组权限（docker 组本就等价 root），因此提供
 * 「Docker 助手容器」提权通道：以 --privileged --pid=host 启动一个一次性
 * 助手容器，用 nsenter 进入宿主机 PID 1 的全部命名空间，获得真正的
 * 宿主机 root shell。离线且本地无可用的助手镜像时自动回退为当前用户。
 */
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { isWindows } from './detect';

/** 本机是否为 root（Windows 恒为 null） */
export function currentEuid(): number | null {
  try {
    const p = process as NodeJS.Process & { geteuid?: () => number };
    if (typeof p.geteuid === 'function') return p.geteuid();
  } catch {
    // 平台不支持
  }
  return null;
}

/** 面板自身是否运行在 Docker 容器内 */
export function isPanelInContainer(): boolean {
  return existsSync('/.dockerenv');
}

/** 是否需要经由 Docker 助手容器获取宿主机 root */
export function needsHostEscalation(): boolean {
  if (isWindows()) return false;
  if (isPanelInContainer()) return true;
  const euid = currentEuid();
  return euid !== null && euid !== 0;
}

/** 查找可用的 docker CLI */
function findDockerBin(): string | null {
  for (const bin of ['docker', '/usr/bin/docker', '/usr/local/bin/docker']) {
    try {
      execFileSync(bin, ['version', '--format', 'ok'], { timeout: 4000, stdio: 'pipe' });
      return bin;
    } catch {
      // 尝试下一个
    }
  }
  return null;
}

/** 助手镜像候选（需包含 nsenter 与 sh，均为常见基础镜像） */
const HELPER_IMAGE_CANDIDATES = ['alpine', 'busybox', 'debian', 'ubuntu', 'rockylinux', 'centos', 'fedora', 'node'];

/** 从本地镜像列表里选一个可用助手镜像 */
function pickHelperImage(dockerBin: string): string | null {
  try {
    const out = execFileSync(dockerBin, ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      timeout: 6000,
      encoding: 'utf8',
    });
    const images = out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.includes('<none>'));
    for (const cand of HELPER_IMAGE_CANDIDATES) {
      if (images.includes(`${cand}:latest`) || images.includes(cand)) return cand;
    }
    // 容器化部署时面板自身镜像（如 dockermanager:1.x.y）也可充当助手
    for (const img of images) {
      if (/docker[-]?manager/i.test(img)) return img;
    }
    return null;
  } catch {
    return null;
  }
}

export type HostRootChannel =
  | { mode: 'direct' }
  | { mode: 'docker'; dockerBin: string; image: string }
  | { mode: 'unavailable' };

/** 解析可用的 root 通道 */
export function resolveHostRootChannel(): HostRootChannel {
  if (isWindows()) return { mode: 'direct' };
  if (!needsHostEscalation()) return { mode: 'direct' };
  const dockerBin = findDockerBin();
  if (!dockerBin) return { mode: 'unavailable' };
  const image = pickHelperImage(dockerBin);
  if (!image) return { mode: 'unavailable' };
  return { mode: 'docker', dockerBin, image };
}

/** 通道解析缓存（docker version/images 为同步调用，避免每次会话重复探测） */
let _cached: { at: number; channel: HostRootChannel } | null = null;
const CACHE_TTL_MS = 30000;

/** 带缓存的通道解析 */
export function resolveHostRootChannelCached(): HostRootChannel {
  if (_cached && Date.now() - _cached.at < CACHE_TTL_MS) return _cached.channel;
  const channel = resolveHostRootChannel();
  _cached = { at: Date.now(), channel };
  return channel;
}

/**
 * 构造 Docker 助手容器提权命令（交互与非交互通用）
 * @param channel docker 通道（含 dockerBin 与 image）
 * @param innerCmd 宿主机命名空间内执行的 shell 片段
 * @param interactive 是否分配 TTY（交互终端为 true，单命令执行为 false）
 */
export function dockerHelperArgs(
  channel: Extract<HostRootChannel, { mode: 'docker' }>,
  innerCmd: string,
  interactive: boolean,
): string[] {
  return [
    'run', '--rm',
    ...(interactive ? ['-i', '-t'] : []),
    '--privileged', '--pid=host', '--userns=host', '--network=none',
    '--name', `dm-hostroot-${process.pid}-${Date.now().toString(36)}`,
    channel.image,
    'nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
    '/bin/sh', '-c', innerCmd,
  ];
}

/** 当前服务运行用户名（仅用于提示信息） */
export function serviceUserName(): string {
  return process.env.USER || process.env.USERNAME || `uid ${currentEuid() ?? '?'}`;
}
