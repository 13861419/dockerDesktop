/**
 * Kubernetes 客户端封装（1.5.0 一期：只读巡检）
 *
 * - kubeconfig 加载优先级：KUBECONFIG 环境变量 > ~/.kube/config > InCluster（面板以 Pod 部署时）
 * - 多 context：kubeconfig 内全部 context 可列出并在运行期切换（对应"多集群"）
 * - 面板所在机器无 kubeconfig 且非集群内部署时，isK8sAvailable() 为 false，前端展示引导说明
 */
import * as k8s from '@kubernetes/client-node';
import os from 'os';
import path from 'path';
import fs from 'fs';

/** 运行期选中的 context（null = kubeconfig 默认） */
let currentContext: string | null = null;

/** 加载失败的可读原因（供前端引导） */
let lastLoadError: string | null = null;

/**
 * 解析 kubeconfig 文件路径（KUBECONFIG 环境变量 > ~/.kube/config）
 */
export function kubeconfigPath(): string {
  const env = process.env.KUBECONFIG?.trim();
  if (env) return env;
  return path.join(os.homedir(), '.kube', 'config');
}

/**
 * 是否处于 Kubernetes 集群内部署（InCluster 模式）
 * 依据：KUBERNETES_SERVICE_HOST 环境变量 + ServiceAccount token 文件
 */
function hasInClusterEnv(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST) && fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');
}

/**
 * 加载 kubeconfig 并应用当前选中的 context
 * @throws 无 kubeconfig 且非集群内部署时抛带可读信息的错误
 */
export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  const file = kubeconfigPath();
  try {
    if (fs.existsSync(file)) {
      kc.loadFromFile(file);
    } else if (hasInClusterEnv()) {
      // 面板以 Pod 部署：InCluster 配置
      kc.loadFromCluster();
    } else {
      // client-node 无配置时会静默回退 localhost:8080，这里显式抛出以便前端引导
      throw new Error(`kubeconfig 不存在（${file}），且未检测到 InCluster 部署环境`);
    }
  } catch (err) {
    lastLoadError = (err as Error)?.message || 'kubeconfig 加载失败';
    throw err;
  }
  lastLoadError = null;
  if (currentContext) {
    const exists = kc.getContexts().some((c) => c.name === currentContext);
    if (exists) kc.setCurrentContext(currentContext);
  }
  return kc;
}

/** kubeconfig 是否可加载（决定 K8s 域是否可用） */
export function isK8sAvailable(): boolean {
  try {
    loadKubeConfig();
    return true;
  } catch {
    return false;
  }
}

/** 最近一次加载失败原因（前端引导用） */
export function getK8sLoadError(): string | null {
  return lastLoadError;
}

/** 可用 context 列表与当前选中项 */
export function listK8sContexts(): Array<{ name: string; cluster: string; current: boolean }> {
  const kc = loadKubeConfig();
  const current = kc.getCurrentContext();
  return kc.getContexts().map((c) => ({
    name: c.name,
    cluster: c.cluster || '',
    current: c.name === current,
  }));
}

/** 运行期切换 context（内存态，不写回 kubeconfig 文件） */
export function setK8sContext(name: string): void {
  const kc = loadKubeConfig();
  if (!kc.getContexts().some((c) => c.name === name)) {
    throw new Error(`context 不存在: ${name}`);
  }
  currentContext = name;
}

/** 当前 context 名称 */
export function currentK8sContextName(): string {
  const kc = loadKubeConfig();
  return kc.getCurrentContext() || '';
}

/** CoreV1 API 客户端 */
export function coreApi(): k8s.CoreV1Api {
  return loadKubeConfig().makeApiClient(k8s.CoreV1Api);
}

/** AppsV1 API 客户端 */
export function appsApi(): k8s.AppsV1Api {
  return loadKubeConfig().makeApiClient(k8s.AppsV1Api);
}

/** metrics-server 客户端（未安装 metrics-server 的集群调用会抛 404） */
export function metricsClient(): k8s.Metrics {
  return new k8s.Metrics(loadKubeConfig());
}

/**
 * 调整 Deployment 副本数（1.6.0 二期写操作）
 * @returns 执行说明（审批执行器与路由共用）
 */
export async function scaleDeployment(namespace: string, name: string, replicas: number): Promise<string> {
  const n = Math.floor(replicas);
  if (!Number.isFinite(n) || n < 0 || n > 500) throw new Error(`副本数不合法: ${replicas}（应为 0-500 整数）`);
  const body = { spec: { replicas: n } };
  await appsApi().patchNamespacedDeployment({ name, namespace, body });
  return `Deployment ${namespace}/${name} 副本数已调整为 ${n}`;
}

/**
 * 滚动重启 Deployment（更新 restartedAt 注解触发滚动）
 */
export async function restartDeployment(namespace: string, name: string): Promise<string> {
  const now = new Date().toISOString();
  const body = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': now } } } } };
  await appsApi().patchNamespacedDeployment({ name, namespace, body });
  return `Deployment ${namespace}/${name} 已触发滚动重启`;
}

/**
 * 删除 Pod（受 Deployment 管理时会被自动重建；独立 Pod 直接移除）
 */
export async function deletePod(namespace: string, name: string): Promise<string> {
  await coreApi().deleteNamespacedPod({ name, namespace });
  return `Pod ${namespace}/${name} 已删除`;
}

/**
 * K8s 资源量（Quantity）转数值：
 * - CPU：'500m'（毫核）→ 0.5 核；'2500m' → 2.5
 * - 内存：'128Mi' / '1Gi' 等二进制单位 → 字节
 */
export function parseQuantity(raw: string | undefined | null): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  // 二进制后缀：Ki Mi Gi Ti Pi Ei
  const binMatch = s.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|Pi|Ei)$/);
  if (binMatch) {
    const base = Number(binMatch[1]);
    const mult: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
    return base * mult[binMatch[2]];
  }
  // 十进制后缀：k M G T（SI）
  const siMatch = s.match(/^(\d+(?:\.\d+)?)\s*(m|k|M|G|T|P|E)?$/);
  if (siMatch) {
    const base = Number(siMatch[1]);
    const suffix = siMatch[2] || '';
    if (!suffix) return base;
    if (suffix === 'm') return base / 1000;
    const mult: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
    return base * mult[suffix];
  }
  return 0;
}
