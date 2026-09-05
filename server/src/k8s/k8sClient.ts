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

/** ApiextensionsV1 API 客户端（CRD 定义，1.22.0） */
export function apiextensionsApi(): k8s.ApiextensionsV1Api {
  return loadKubeConfig().makeApiClient(k8s.ApiextensionsV1Api);
}

/** CustomObjects API 客户端（自定义资源实例，1.22.0） */
export function customObjectsApi(): k8s.CustomObjectsApi {
  return loadKubeConfig().makeApiClient(k8s.CustomObjectsApi);
}

/** CRD 摘要 */
export interface K8sCrdSummary {
  name: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string;
  createdAt: number | null;
}

/** 列出集群中的 CRD 定义（1.22.0） */
export async function listCrds(): Promise<K8sCrdSummary[]> {
  const res = await apiextensionsApi().listCustomResourceDefinition();
  return (res.items || []).map((crd: any) => {
    const spec: any = (crd as any).spec || {};
    const versions = spec.versions || [];
    const stored = versions.find((v: any) => v.storage) || versions[0] || {};
    return {
      name: (crd as any).metadata?.name || '',
      group: spec.group || '',
      version: stored.name || '',
      kind: spec.names?.kind || '',
      plural: spec.names?.plural || '',
      scope: spec.scope || '',
      createdAt: (crd as any).metadata?.creationTimestamp
        ? new Date((crd as any).metadata.creationTimestamp).getTime()
        : null,
    };
  });
}

/** 列出某 CRD 的自定义资源实例（仅支持集群作用域名称为 name 的 CRD，1.22.0） */
export async function listCrdResources(crdName: string, limit = 100): Promise<Array<Record<string, unknown>>> {
  const crds = await listCrds();
  const crd = crds.find((c) => c.name === crdName);
  if (!crd) throw new Error(`CRD 不存在: ${crdName}`);
  const obj = (await customObjectsApi().listClusterCustomObject({
    group: crd.group,
    version: crd.version,
    plural: crd.plural,
  })) as { items?: Array<any> };
  return (obj.items || []).slice(0, limit).map((it) => ({
    name: it.metadata?.name || '',
    namespace: it.metadata?.namespace || '',
    kind: it.kind || crd.kind,
    createdAt: it.metadata?.creationTimestamp ? new Date(it.metadata.creationTimestamp).getTime() : null,
    labels: it.metadata?.labels || {},
    spec: it.spec ?? {},
  }));
}

/** ResourceQuota 摘要（1.24.0） */
export interface K8sQuotaSummary {
  name: string;
  namespace: string;
  hard: Record<string, string>;
  used: Record<string, string>;
  createdAt: number | null;
}

/** 列出 ResourceQuota（1.24.0） */
export async function listResourceQuotas(): Promise<K8sQuotaSummary[]> {
  const res = await coreApi().listResourceQuotaForAllNamespaces();
  return (res.items || []).map((q: any) => ({
    name: q.metadata?.name || '',
    namespace: q.metadata?.namespace || '',
    hard: q.status?.hard || {},
    used: q.status?.used || {},
    createdAt: q.metadata?.creationTimestamp ? new Date(q.metadata.creationTimestamp).getTime() : null,
  }));
}

/** LimitRange 摘要（1.24.0） */
export interface K8sLimitRangeSummary {
  name: string;
  namespace: string;
  limits: Array<{ type: string; min?: string; max?: string; default?: string; defaultRequest?: string }>;
  createdAt: number | null;
}

/** 列出 LimitRange（1.24.0） */
export async function listLimitRanges(): Promise<K8sLimitRangeSummary[]> {
  const res = await coreApi().listLimitRangeForAllNamespaces();
  return (res.items || []).map((lr: any) => ({
    name: lr.metadata?.name || '',
    namespace: lr.metadata?.namespace || '',
    limits: (lr.spec?.limits || []).map((l: any) => ({
      type: l.type || '',
      min: l.min ? Object.entries(l.min).map(([k, v]) => `${k}=${v}`).join(', ') : undefined,
      max: l.max ? Object.entries(l.max).map(([k, v]) => `${k}=${v}`).join(', ') : undefined,
      default: (l._default ?? l.default) ? Object.entries(l._default ?? l.default).map(([k, v]) => `${k}=${v}`).join(', ') : undefined,
      defaultRequest: l.defaultRequest ? Object.entries(l.defaultRequest).map(([k, v]) => `${k}=${v}`).join(', ') : undefined,
    })),
    createdAt: lr.metadata?.creationTimestamp ? new Date(lr.metadata.creationTimestamp).getTime() : null,
  }));
}

/** NetworkPolicy 摘要（1.24.0） */
export interface K8sNetPolicySummary {
  name: string;
  namespace: string;
  policyTypes: string[];
  podSelector: string;
  ingress: number;
  egress: number;
  createdAt: number | null;
}

/** 列出 NetworkPolicy（1.24.0） */
export async function listNetworkPolicies(): Promise<K8sNetPolicySummary[]> {
  const res = await networkingApi().listNetworkPolicyForAllNamespaces();
  return (res.items || []).map((np: any) => {
    const sel = np.spec?.podSelector?.matchLabels || {};
    return {
      name: np.metadata?.name || '',
      namespace: np.metadata?.namespace || '',
      policyTypes: np.spec?.policyTypes || [],
      podSelector: Object.keys(sel).length ? Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(', ') : 'all pods',
      ingress: (np.spec?.ingress || []).length,
      egress: (np.spec?.egress || []).length,
      createdAt: np.metadata?.creationTimestamp ? new Date(np.metadata.creationTimestamp).getTime() : null,
    };
  });
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
 * 触发 StatefulSet 滚动重启（1.19.0，restartedAt 注解）
 */
export async function restartStatefulSet(namespace: string, name: string): Promise<string> {
  const now = new Date().toISOString();
  const body = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': now } } } } };
  await appsApi().patchNamespacedStatefulSet({ name, namespace, body });
  return `StatefulSet ${namespace}/${name} 已触发滚动重启`;
}

/**
 * 触发 DaemonSet 滚动重启（1.19.0，restartedAt 注解）
 */
export async function restartDaemonSet(namespace: string, name: string): Promise<string> {
  const now = new Date().toISOString();
  const body = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': now } } } } };
  await appsApi().patchNamespacedDaemonSet({ name, namespace, body });
  return `DaemonSet ${namespace}/${name} 已触发滚动重启`;
}

/**
 * 更新 ConfigMap 数据（1.19.0，整体替换 data）
 */
export async function updateConfigMap(namespace: string, name: string, data: Record<string, string>): Promise<string> {
  await coreApi().patchNamespacedConfigMap({ name, namespace, body: { data } });
  return `ConfigMap ${namespace}/${name} 已更新（${Object.keys(data).length} 个键）`;
}

/**
 * 更新 Secret 数据（1.19.0，data 值须为 base64；整体替换）
 */
export async function updateSecret(namespace: string, name: string, data: Record<string, string>): Promise<string> {
  for (const v of Object.values(data)) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new Error('Secret 值必须为 base64 编码');
  }
  await coreApi().patchNamespacedSecret({ name, namespace, body: { data } });
  return `Secret ${namespace}/${name} 已更新（${Object.keys(data).length} 个键）`;
}

/**
 * 删除 Pod 并由其控制器自动重建（1.17.0）。
 * 独立 Pod（无 ownerReferences）不支持重建，直接报错。
 */
export async function recreatePod(namespace: string, name: string): Promise<string> {
  const pod = await coreApi().readNamespacedPod({ name, namespace });
  const owners = (pod as any)?.metadata?.ownerReferences || [];
  if (!Array.isArray(owners) || owners.length === 0) {
    throw new Error('独立 Pod（无所属控制器）不支持重建，请直接删除或通过编排方式管理');
  }
  await coreApi().deleteNamespacedPod({ name, namespace });
  const owner = owners[0]?.kind || '';
  return `Pod ${namespace}/${name} 已删除，${owner} 控制器将自动重建`;
}

/**
 * Deployment 回滚到指定 revision（缺省回滚到上一个）。
 * 通过比对 ReplicaSet 的 revision 注解找到目标模板并 patch Deployment。
 */
export async function rolloutUndoDeployment(namespace: string, name: string, targetRevision?: number): Promise<string> {
  const apps = appsApi();
  const current = await apps.readNamespacedDeployment({ name, namespace });
  const dep: any = current;
  const currentRevision = Number(dep?.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 0;
  const selector = dep?.spec?.selector?.matchLabels || {};
  // 找出属于该 Deployment 的 ReplicaSet（ownerReferences 匹配）
  const rsList = await apps.listNamespacedReplicaSet({ namespace });
  const owned = (rsList.items || []).filter((rs: any) =>
    (rs.metadata?.ownerReferences || []).some((o: any) => o.kind === 'Deployment' && o.name === name),
  );
  const revisionOf = (rs: any) => Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 0;
  const candidates = owned
    .filter((rs: any) => revisionOf(rs) > 0 && revisionOf(rs) !== currentRevision)
    .sort((a: any, b: any) => revisionOf(b) - revisionOf(a));
  let target: any;
  if (targetRevision) {
    target = owned.find((rs: any) => revisionOf(rs) === targetRevision);
    if (!target) throw new Error(`未找到 revision ${targetRevision} 对应的历史版本`);
  } else {
    target = candidates[0];
  }
  if (!target) throw new Error('没有可回滚的历史版本');
  const targetRevision2 = revisionOf(target);
  const body = {
    spec: {
      template: target.spec?.template,
      replicas: target.spec?.replicas ?? dep?.spec?.replicas,
    },
  };
  await apps.patchNamespacedDeployment({ name, namespace, body });
  return `Deployment ${namespace}/${name} 已回滚到 revision ${revisionOf(target)}`;
}

/**
 * PVC 扩容（仅支持增大容量；K8s 不允许缩小存储）。
 */
export async function resizePvc(namespace: string, name: string, storage: string): Promise<string> {
  if (!/^\d+(\.\d+)?\s*(Mi|Gi|Ti)$/i.test(storage.trim())) {
    throw new Error(`容量格式非法: ${storage}（示例：10Gi）`);
  }
  const pvc = await coreApi().readNamespacedPersistentVolumeClaim({ name, namespace });
  const current = String((pvc as any)?.spec?.resources?.requests?.storage || '');
  const parseGi = (s: string): number => {
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(Mi|Gi|Ti)$/i);
    if (!m) return 0;
    const mult: Record<string, number> = { Mi: 1 / 1024, Gi: 1, Ti: 1024 };
    return Number(m[1]) * (mult[m[2]] || 1);
  };
  if (current && parseGi(storage) < parseGi(current)) {
    throw new Error(`不允许缩小容量（当前 ${current}，目标 ${storage}）`);
  }
  const body = { spec: { resources: { requests: { storage: storage.trim() } } } };
  await coreApi().patchNamespacedPersistentVolumeClaim({ name, namespace, body });
  return `PVC ${namespace}/${name} 扩容请求已提交（${current || '?'} → ${storage}）`;
}

/** NetworkingV1 API 客户端（Ingress 等） */
export function networkingApi(): k8s.NetworkingV1Api {
  return loadKubeConfig().makeApiClient(k8s.NetworkingV1Api);
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
