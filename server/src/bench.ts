/**
 * Docker Bench 安全基线扫描引擎
 *
 * 参考 CIS Docker Benchmark 的重点检查项，对宿主机 / Docker 守护进程 /
 * 镜像 / 容器运行时做一键体检并输出等级化报告（pass/warn/fail/info/skip）。
 *
 * 与「安全基线」页（/policy，容器维度 6 项规则 + 在线修复）互补：
 * 本引擎侧重守护进程配置、宿主机文件权限与镜像运行用户等主机侧检查，
 * 结果持久化到 bench_runs 表供历史比对。
 */
import fsp from 'fs/promises';
import path from 'path';
import Dockerode from 'dockerode';
import { getDockerClient } from './docker/client';

/** 检查等级：pass 通过 / warn 建议加固 / fail 高危 / info 提示 / skip 不适用 */
export type BenchLevel = 'pass' | 'warn' | 'fail' | 'info' | 'skip';

/** 检查分类 */
export type BenchCategory = 'host' | 'daemon' | 'images' | 'containers';

/** 单条检查结果 */
export interface BenchCheck {
  /** 检查项 ID（稳定，前端定位用） */
  id: string;
  /** 分类 */
  category: BenchCategory;
  /** 等级 */
  level: BenchLevel;
  /** 标题 */
  title: string;
  /** 结果说明（含命中对象明细） */
  desc: string;
  /** 加固建议 */
  remediation: string;
  /** 命中对象清单（如容器名），可为空 */
  targets?: string[];
}

/** 完整扫描报告 */
export interface BenchReport {
  startedAt: number;
  durationMs: number;
  summary: Record<Exclude<BenchLevel, 'skip'>, number> & { skip: number };
  checks: BenchCheck[];
}

/** 单个检查项定义（生产检查函数） */
interface BenchItem {
  id: string;
  category: BenchCategory;
  title: string;
  remediation: string;
  run: (ctx: BenchContext) => Promise<{ level: BenchLevel; desc: string; targets?: string[] }>;
}

/** 检查上下文：一次扫描内复用 */
interface BenchContext {
  info: Record<string, any>;
  containers: Dockerode.ContainerInfo[];
  inspects: Array<Dockerode.ContainerInspectInfo & { name: string }>;
  isWindows: boolean;
}

/** daemon.json 常见路径（Linux / Windows Docker Desktop） */
function daemonJsonPaths(isWindows: boolean): string[] {
  if (isWindows) {
    return [
      path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'docker', 'config', 'daemon.json'),
      path.join(process.env.USERPROFILE || '', '.docker', 'daemon.json'),
    ];
  }
  return ['/etc/docker/daemon.json', path.join(process.env.HOME || '', '.config', 'docker', 'daemon.json')];
}

/** 读取 daemon.json（不存在返回 null） */
async function readDaemonJson(isWindows: boolean): Promise<Record<string, unknown> | null> {
  for (const p of daemonJsonPaths(isWindows)) {
    try {
      const raw = await fsp.readFile(p, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 尝试下一个路径
    }
  }
  return null;
}

/** 检查项定义（顺序即报告顺序） */
const ITEMS: BenchItem[] = [
  // ==================== Docker 守护进程 ====================
  {
    id: 'daemon-live-restore',
    category: 'daemon',
    title: '开启 live-restore',
    remediation: '在 daemon.json 中配置 "live-restore": true，可保证重启 Docker 守护进程时容器不中断',
    run: async (ctx) => {
      const enabled = Boolean((ctx.info as { LiveRestoreEnabled?: boolean }).LiveRestoreEnabled);
      return {
        level: enabled ? 'pass' : 'warn',
        desc: enabled ? 'live-restore 已开启' : '未开启 live-restore，重启守护进程会导致全部容器中断',
      };
    },
  },
  {
    id: 'daemon-log-rotation',
    category: 'daemon',
    title: '容器日志轮转（log-opts max-size）',
    remediation: '在 daemon.json 配置 "log-opts": {"max-size": "10m", "max-file": "3"}，避免 json 日志无限膨胀',
    run: async (ctx) => {
      const dj = await readDaemonJson(ctx.isWindows);
      if (!dj) return { level: 'info', desc: '未找到 daemon.json（使用默认配置，未设置日志轮转）' };
      const opts = (dj['log-opts'] || {}) as Record<string, unknown>;
      if (opts['max-size']) {
        return { level: 'pass', desc: `已配置 max-size=${String(opts['max-size'])}` };
      }
      return { level: 'warn', desc: 'daemon.json 存在但未配置 log-opts max-size，json 日志文件可能无限增长' };
    },
  },
  {
    id: 'daemon-swarm',
    category: 'daemon',
    title: 'Swarm 模式状态',
    remediation: '未使用集群编排时建议保持 Swarm 关闭，减少攻击面',
    run: async (ctx) => {
      const swarm = (ctx.info as { Swarm?: { LocalNodeState?: string; Active?: boolean } }).Swarm;
      if (swarm?.LocalNodeState === 'active' || swarm?.LocalNodeState === 'pending') {
        return { level: 'info', desc: '节点处于 Swarm 模式（active），请确认确有集群需求' };
      }
      return { level: 'pass', desc: 'Swarm 未启用（单机模式）' };
    },
  },
  {
    id: 'daemon-remote-tls',
    category: 'daemon',
    title: '远程访问 TLS 校验',
    remediation: '若需要远程访问 Docker API，应启用 TLS 双向认证（daemon.json 的 tlsverify/labels）',
    run: async (ctx) => {
      const security = (ctx.info as { SecurityOptions?: string[] }).SecurityOptions || [];
      const hasTls = security.some((s) => s.toLowerCase().includes('tls'));
      if (security.length === 0) {
        return { level: 'info', desc: '守护进程未启用额外安全特性（如 TLS），仅本机 socket 使用时风险可控' };
      }
      if (hasTls) return { level: 'pass', desc: '已启用 TLS 相关安全选项' };
      return { level: 'info', desc: `SecurityOptions: ${security.join(', ')}` };
    },
  },
  // ==================== 宿主机 ====================
  {
    id: 'host-docker-sock-perm',
    category: 'host',
    title: 'docker.sock 文件权限',
    remediation: 'Linux 建议将 /var/run/docker.sock 权限设为 0660（root:docker 组），避免任意用户直连 Docker API',
    run: async (ctx) => {
      if (ctx.isWindows) return { level: 'skip', desc: 'Windows 平台无 docker.sock，不适用' };
      try {
        const st = await fsp.stat('/var/run/docker.sock');
        const mode = st.mode & 0o777;
        if ((mode & 0o007) === 0) {
          return { level: 'pass', desc: `权限 ${mode.toString(8)}（其他用户不可读写）` };
        }
        return { level: 'fail', desc: `权限 ${mode.toString(8)} 过宽，其他用户可直连 Docker API（等于宿主机 root）` };
      } catch {
        return { level: 'info', desc: '未找到 /var/run/docker.sock（可能使用非标准 socket 路径）' };
      }
    },
  },
  {
    id: 'host-daemon-json-perm',
    category: 'host',
    title: 'daemon.json 文件权限',
    remediation: 'Linux 建议将 /etc/docker/daemon.json 设为 0644 或更严格，属主 root',
    run: async (ctx) => {
      if (ctx.isWindows) return { level: 'skip', desc: 'Windows 平台 ACL 权限模型不同，不适用' };
      const p = daemonJsonPaths(false)[0];
      try {
        const st = await fsp.stat(p);
        const mode = st.mode & 0o777;
        if ((mode & 0o022) === 0) return { level: 'pass', desc: `权限 ${mode.toString(8)}（组与其他用户不可写）` };
        return { level: 'warn', desc: `权限 ${mode.toString(8)} 过宽，daemon.json 可被非 root 用户篡改` };
      } catch {
        return { level: 'info', desc: '未找到 /etc/docker/daemon.json（使用默认配置）' };
      }
    },
  },
  {
    id: 'host-remote-2375',
    category: 'host',
    title: '未加密的 2375 端口',
    remediation: '避免开放 0.0.0.0:2375；需要远程 API 时使用 2376 + TLS',
    run: async (ctx) => {
      // Docker info 中无法直接判断 -H 监听；退化检查本机 2375 端口是否监听
      const net = require('net') as typeof import('net');
      const open = await new Promise<boolean>((resolve) => {
        const s = net.connect({ port: 2375, host: '127.0.0.1', timeout: 800 });
        s.on('connect', () => {
          s.destroy();
          resolve(true);
        });
        s.on('error', () => resolve(false));
        s.on('timeout', () => {
          s.destroy();
          resolve(false);
        });
      });
      if (open) return { level: 'fail', desc: '本机 2375 端口在监听，未加密 Docker API 已暴露' };
      return { level: 'pass', desc: '2375 未监听' };
    },
  },
  // ==================== 镜像与容器运行时 ====================
  {
    id: 'image-no-latest',
    category: 'images',
    title: '避免使用 latest / 无标签镜像',
    remediation: '生产环境固定镜像版本标签（如 nginx:1.27），保证可追溯与可回滚',
    run: async (ctx) => {
      const bad = ctx.inspects
        .map((c) => c.Config?.Image || '')
        .filter((img) => !img || img.endsWith(':latest'))
        .map((img) => img || '(无标签)');
      if (bad.length === 0) return { level: 'pass', desc: '全部运行容器使用固定版本标签' };
      return { level: 'warn', desc: `${bad.length} 个容器使用 latest/无标签镜像`, targets: bad };
    },
  },
  {
    id: 'image-root-user',
    category: 'images',
    title: '避免以 root 运行容器',
    remediation: '镜像内创建专用用户，或在运行时指定 --user（如 1000:1000）',
    run: async (ctx) => {
      const bad = ctx.inspects
        .filter((c) => !c.Config?.User || c.Config.User === '0' || c.Config.User === 'root')
        .map((c) => c.name);
      if (bad.length === 0) return { level: 'pass', desc: '全部容器以非 root 用户运行' };
      return {
        level: 'info',
        desc: `${bad.length} 个容器以 root 运行（常见且多数场景可接受，涉密负载建议降权）`,
        targets: bad,
      };
    },
  },
  {
    id: 'container-seccomp',
    category: 'containers',
    title: 'Seccomp 配置',
    remediation: '保持默认 seccomp profile（未显式关闭即视为通过）',
    run: async (ctx) => {
      if (ctx.isWindows) return { level: 'skip', desc: 'Windows 容器不支持 seccomp，不适用' };
      const bad = ctx.inspects
        .filter((c) => (c.HostConfig?.SecurityOpt || []).some((o: string) => o === 'seccomp=unconfined'))
        .map((c) => c.name);
      if (bad.length === 0) return { level: 'pass', desc: '未发现 seccomp=unconfined 的容器' };
      return { level: 'warn', desc: `${bad.length} 个容器关闭了 seccomp（unconfined）`, targets: bad };
    },
  },
  {
    id: 'container-pid-limit',
    category: 'containers',
    title: 'PIDs 限制',
    remediation: '运行时指定 --pids-limit（如 100）防止 fork 炸弹',
    run: async (ctx) => {
      const bad = ctx.inspects.filter((c) => !c.HostConfig?.PidsLimit || c.HostConfig.PidsLimit <= 0).map((c) => c.name);
      if (bad.length === 0) return { level: 'pass', desc: '全部容器配置了 PIDs 上限' };
      return { level: 'info', desc: `${bad.length} 个容器未设置 pids-limit（低风险提示）`, targets: bad };
    },
  },
];

/**
 * 执行一次安全基线扫描（不落库；落库见 routes/bench.ts）
 */
export async function runSecurityBench(): Promise<BenchReport> {
  const startedAt = Date.now();
  const docker = await getDockerClient();
  const info = await docker.info();
  const containers = await docker.listContainers({ all: false });
  const inspects = await Promise.all(
    containers.map(async (c) => {
      try {
        const raw = await docker.getContainer(c.Id).inspect();
        return { ...raw, name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, '') };
      } catch {
        return { name: c.Id.slice(0, 12), Config: {}, HostConfig: {} } as unknown as Dockerode.ContainerInspectInfo & { name: string };
      }
    }),
  );
  const ctx: BenchContext = {
    info,
    containers,
    inspects,
    isWindows: process.platform === 'win32',
  };

  const checks: BenchCheck[] = [];
  for (const item of ITEMS) {
    try {
      const r = await item.run(ctx);
      checks.push({
        id: item.id,
        category: item.category,
        level: r.level,
        title: item.title,
        desc: r.desc,
        remediation: item.remediation,
        targets: r.targets && r.targets.length > 0 ? r.targets.slice(0, 20) : undefined,
      });
    } catch (err) {
      checks.push({
        id: item.id,
        category: item.category,
        level: 'skip',
        title: item.title,
        desc: `检查执行失败：${(err as Error)?.message || '未知错误'}`,
        remediation: item.remediation,
      });
    }
  }

  const summary = { pass: 0, warn: 0, fail: 0, info: 0, skip: 0 };
  for (const c of checks) summary[c.level] += 1;
  return { startedAt, durationMs: Date.now() - startedAt, summary, checks };
}
