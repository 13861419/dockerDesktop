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

/** 缓存已探测到的端点，避免每次请求都重复探测 */
let cachedEndpoint: string | null = null;

/**
 * 获取 dockerode 客户端实例
 *
 * 若 DOCKER_HOST 未设置，则自动探测本机可用的 Docker 引擎。
 * @returns dockerode 客户端
 */
export async function getDockerClient(): Promise<Dockerode> {
  // 优先使用环境变量显式指定的端点
  const envEndpoint = process.env.DOCKER_HOST;

  let endpoint = cachedEndpoint;
  if (!endpoint) {
    const candidates = [envEndpoint || '', ...DEFAULT_ENDPOINTS];
    endpoint = await detectDockerEndpoint(candidates);
    cachedEndpoint = endpoint;
  }
  return new Dockerode(resolveEndpoint(endpoint));
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
