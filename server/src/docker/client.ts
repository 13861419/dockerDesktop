/**
 * Docker Engine API 客户端封装
 *
 * 兼容 Windows 下 Docker Desktop (WSL2) 的两种访问方式：
 *  1. named pipe (npipe): npipe:////./pipe/dockerDesktopLinuxEngine
 *  2. TCP: tcp://host:port
 *
 * 默认情况下自动探测，也可通过环境变量 DOCKER_HOST 覆盖。
 * 注意：Windows named pipe 无法用 fs.existsSync 检测，必须通过真实连接验证。
 */
import Dockerode from 'dockerode';
import os from 'os';
import { getDb } from '../storage';

/** 常见 Docker 访问端点的探测顺序，按优先级排列 */
const DEFAULT_ENDPOINTS: string[] = [
  // 环境变量显式指定时优先（通过 getClient 注入）
  'npipe:////./pipe/dockerDesktopLinuxEngine',
  // Windows 默认 pipe
  'npipe:////./pipe/docker_engine',
  // Linux/macOS 默认 socket
  'unix:///var/run/docker.sock',
];

/**
 * 将访问端点字符串转为 dockerode 连接配置
 * @param endpoint 形如 npipe://... / unix://... / tcp://host:port 的字符串
 * @returns dockerode 连接选项
 */
function resolveEndpoint(endpoint: string): Dockerode.DockerOptions {
  if (!endpoint) {
    throw new Error('Docker 端点为空');
  }

  if (endpoint.startsWith('npipe://')) {
    // 去掉 npipe:// 前缀，保留 //./pipe/... 形式，dockerode 用 socketPath 即可连接
    return { socketPath: endpoint.replace(/^npipe:\/\//, '') };
  }
  if (endpoint.startsWith('unix://')) {
    return { socketPath: endpoint.replace('unix://', '') };
  }
  if (endpoint.startsWith('tcp://')) {
    const url = new URL(endpoint);
    return { host: url.hostname, port: Number(url.port || '2375') };
  }
  // 若只给了路径（兼容老写法），视为 socket
  return { socketPath: endpoint };
}

/**
 * 尝试通过某个端点建立连接并执行轻量请求
 * @param endpoint 候选端点
 * @returns 连接成功返回 true，否则 false
 */
async function tryEndpoint(endpoint: string): Promise<boolean> {
  try {
    const docker = new Dockerode(resolveEndpoint(endpoint));
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * 自动探测可用的 Docker 引擎端点（通过真实连接验证）
 * @param candidates 候选端点数组
 * @returns 第一个可用的端点地址
 * @throws 当没有可用端点时抛出错误
 */
async function detectDockerEndpoint(candidates: string[]): Promise<string> {
  for (const endpoint of candidates) {
    if (!endpoint) continue;
    if (await tryEndpoint(endpoint)) {
      return endpoint;
    }
  }
  throw new Error(
    '无法连接 Docker 引擎。请确认 Docker Desktop 已启动，或通过 DOCKER_HOST 环境变量指定端点。',
  );
}

/** 缓存已探测到的默认端点，避免每次请求都重复探测 */
let cachedDetectedEndpoint: string | null = null;
/** 缓存默认引擎（回退分支）的 dockerode 实例，避免 monitor 等高频调用反复 new Dockerode 累积短命对象 */
let cachedDefaultDocker: Dockerode | null = null;

/**
 * 读取当前生效的 Docker 引擎端点（多引擎模式下）
 *
 * 从 docker_engines 表读取 is_current=1 的引擎端点；若为空返回 null，
 * 表示处于"默认引擎"（环境变量 / 自动探测）。
 * @returns 当前引擎端点，或 null
 */
function getCurrentEngineEndpoint(): string | null {
  try {
    const row = getDb()
      .prepare('SELECT endpoint FROM docker_engines WHERE is_current = 1 LIMIT 1')
      .get() as { endpoint: string } | undefined;
    return row ? row.endpoint : null;
  } catch {
    return null;
  }
}

/** 缓存的当前引擎签名（用于判断引擎是否变更） */
let cachedCurrentKey = '';
/** 缓存的当前引擎 dockerode 实例 */
let cachedCurrentDocker: Dockerode | null = null;

/**
 * 使 Docker 客户端缓存失效
 *
 * 当引擎被新增/修改/删除/切换时调用，强制下一次 getDockerClient 重新解析
 * 当前引擎或重新探测，从而让新引擎配置立即生效。
 */
export function resetDockerCache(): void {
  cachedDetectedEndpoint = null;
  cachedCurrentKey = '';
  cachedCurrentDocker = null;
  cachedDefaultDocker = null;
}

/**
 * 校验某个 Docker 引擎端点是否可连通（用于引擎新增/更新前测试）
 * @param endpoint 待校验端点（npipe:// / tcp:// / unix://）
 * @returns 可连通返回 true，否则 false
 */
export async function testEngineEndpoint(endpoint: string): Promise<boolean> {
  try {
    const docker = new Dockerode(resolveEndpoint(endpoint));
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * 按指定端点创建 dockerode 客户端实例（不参与缓存、不影响当前引擎）
 *
 * 供跨引擎操作（如镜像迁移）使用：可针对源/目标引擎分别建立独立的
 * dockerode 实例，而不会改动 getDockerClient() 对"当前引擎"的缓存逻辑。
 * @param endpoint 目标引擎端点（npipe:// / unix:// / tcp:// 或 socket 路径）
 * @returns 指向该端点的 dockerode 实例
 */
export function getDockerClientForEndpoint(endpoint: string): Dockerode {
  return new Dockerode(resolveEndpoint(endpoint));
}

/**
 * 获取 dockerode 客户端实例
 *
 * 若配置了"当前引擎"，则直连该引擎端点；否则回退到环境变量 DOCKER_HOST
 * 或本机自动探测（保留原有单引擎行为）。
 * @returns dockerode 客户端
 */
export async function getDockerClient(): Promise<Dockerode> {
  const current = getCurrentEngineEndpoint();
  if (current) {
    const key = 'engine:' + current;
    if (key !== cachedCurrentKey || !cachedCurrentDocker) {
      cachedCurrentKey = key;
      cachedCurrentDocker = new Dockerode(resolveEndpoint(current));
    }
    return cachedCurrentDocker;
  }

  // 回退：优先使用环境变量显式指定的端点，否则自动探测
  const envEndpoint = process.env.DOCKER_HOST;

  let endpoint = cachedDetectedEndpoint;
  if (!endpoint) {
    const candidates = [envEndpoint || '', ...DEFAULT_ENDPOINTS];
    endpoint = await detectDockerEndpoint(candidates);
    cachedDetectedEndpoint = endpoint;
  }

  // 复用缓存的默认实例，避免 monitor 等高频调用每次 new Dockerode 累积短命对象
  if (!cachedDefaultDocker) {
    cachedDefaultDocker = new Dockerode(resolveEndpoint(endpoint));
  }
  return cachedDefaultDocker;
}

/**
 * 获取当前连接的 Docker 引擎信息（版本、Server 信息等）
 * @returns Docker 版本信息
 */
export function getDockerInfo(): Promise<Dockerode.DockerVersion> {
  return getDockerClient().then((client) => client.version());
}

/**
 * 判断当前是否在 Windows 平台上
 * @returns 是否 Windows
 */
export function isWindows(): boolean {
  return os.platform() === 'win32';
}
