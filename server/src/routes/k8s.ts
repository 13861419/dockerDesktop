/**
 * Kubernetes 只读巡检路由（1.5.0 一期）
 *
 * - 全部为只读端点，挂载时统一 requireAuth
 * - 集群不可用（无 kubeconfig 且非 InCluster）时统一 503 + 可读引导
 * - 列表按 namespace 过滤（query.namespace 缺省或 'all' = 全命名空间，客户端过滤）
 * - client-node 1.x makeApiClient：方法接收单个参数对象，返回值即 body
 */
import { Router, Request, Response } from 'express';
import {
  coreApi,
  appsApi,
  metricsClient,
  isK8sAvailable,
  getK8sLoadError,
  listK8sContexts,
  setK8sContext,
  currentK8sContextName,
  parseQuantity,
  scaleDeployment,
  restartDeployment,
  deletePod,
  rolloutUndoDeployment,
  resizePvc,
  recreatePod,
  updateConfigMap,
  updateSecret,
  restartStatefulSet,
  restartDaemonSet,
} from '../k8s/k8sClient';
import { maybeGate } from '../approvals';
import { logOperation } from '../operationLog';
const router = Router();

/** 统一错误包装：K8s 不可用 → 503 引导；K8s API 404/403 等透传状态码 */
function wrap(handler: (req: Request, res: Response) => Promise<any>) {
  return async (req: Request, res: Response) => {
    if (!isK8sAvailable()) {
      res.status(503).json({
        error: 'Kubernetes 不可用',
        reason:
          getK8sLoadError() ||
          '未找到 kubeconfig：请放置于 ~/.kube/config 或设置 KUBECONFIG 环境变量；面板以 Pod 部署时自动使用 InCluster 配置',
      });
      return;
    }
    try {
      const data = await handler(req, res);
      // 门禁拦截（maybeGate 202）等场景已发送响应，避免 ERR_HTTP_HEADERS_SENT
      if (res.writableEnded) return;
      res.json(data ?? { ok: true });
    } catch (err: any) {
      const status = err?.statusCode || err?.response?.statusCode || 500;
      // 集群连接失败（kubeconfig 存在但集群不可达）与未配置一致，统一 503 引导
      const code = err?.code || err?.cause?.code || '';
      if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED'].includes(code)) {
        res.status(503).json({
          error: 'Kubernetes 不可用',
          reason: `集群连接失败（${code}）：请确认集群已启动且 kubeconfig 指向正确地址`,
        });
        return;
      }
      res.status(typeof status === 'number' ? status : 500).json({ error: err?.message || 'K8s 请求失败' });
    }
  };
}

/** ns 参数：'all' 或缺省 = 全命名空间 */
function nsParam(req: Request): string {
  const ns = String(req.query.namespace || '').trim();
  return !ns || ns === 'all' ? '' : ns;
}

/** 按命名空间过滤（items 为 K8s 列表对象） */
function filterNs(items: any[] | undefined, ns: string): any[] {
  return (items || []).filter((it) => !ns || it.metadata?.namespace === ns);
}

function nodeRoles(n: any): string[] {
  return Object.keys(n.metadata?.labels || {})
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.split('/')[1]);
}

function normalizePod(p: any): Record<string, any> {
  const containerStatuses: any[] = p.status?.containerStatuses || [];
  const restarts = containerStatuses.reduce((acc: number, c: any) => acc + (c.restartCount || 0), 0);
  const readyCount = containerStatuses.filter((c: any) => c.ready).length;
  return {
    name: p.metadata?.name,
    namespace: p.metadata?.namespace,
    phase: p.status?.phase || 'Unknown',
    detailStatus:
      containerStatuses.find((c: any) => c.state?.waiting?.reason)?.state?.waiting?.reason ||
      p.status?.phase ||
      'Unknown',
    ready: `${readyCount}/${containerStatuses.length}`,
    restarts,
    node: p.spec?.nodeName || '',
    createdAt: p.metadata?.creationTimestamp ? new Date(p.metadata.creationTimestamp).getTime() : null,
    labels: p.metadata?.labels || {},
    containers: (p.spec?.containers || []).map((c: any) => {
      const st = containerStatuses.find((cs) => cs.name === c.name);
      return { name: c.name, image: c.image, ready: st?.ready ?? false, restarts: st?.restartCount || 0 };
    }),
  };
}

/** 可用性 + context 列表（前端切换器数据源） */
router.get('/status', (_req, res) => {
  const available = isK8sAvailable();
  res.json({
    available,
    contexts: available ? listK8sContexts() : [],
    context: available ? currentK8sContextName() : '',
    reason: available ? null : getK8sLoadError(),
  });
});

/** 切换 context（内存态，不写回 kubeconfig） */
router.post('/context', wrap(async (req: Request) => {
  setK8sContext(String(req.body?.context || ''));
  return { ok: true, context: currentK8sContextName() };
}));

/** 集群概览：节点（含 metrics-server 资源占用）+ 资源计数 */
router.get('/overview', wrap(async () => {
  const core = coreApi();
  const [nodes, pods, services, pvcs] = (await Promise.all([
    core.listNode(),
    core.listPodForAllNamespaces(),
    core.listServiceForAllNamespaces(),
    core.listPersistentVolumeClaimForAllNamespaces(),
  ])) as any[];

  // metrics-server 节点占用（未安装时整体降级为 null）
  let metricsAvailable = true;
  const nodeMetricsMap = new Map<string, { cpuPercent: number; memPercent: number }>();
  try {
    const m = await metricsClient().getNodeMetrics();
    const alloc = new Map<string, { cpu: number; mem: number }>();
    for (const n of nodes.items || []) {
      alloc.set(n.metadata?.name, {
        cpu: parseQuantity(n.status?.allocatable?.cpu),
        mem: parseQuantity(n.status?.allocatable?.memory),
      });
    }
    for (const it of m.items || []) {
      const a = alloc.get(it.metadata?.name) || { cpu: 0, mem: 0 };
      const cpuUsed = parseQuantity(it.usage?.cpu);
      const memUsed = parseQuantity(it.usage?.memory);
      nodeMetricsMap.set(it.metadata?.name, {
        cpuPercent: a.cpu ? Math.min(100, Math.round((cpuUsed / a.cpu) * 100)) : 0,
        memPercent: a.mem ? Math.min(100, Math.round((memUsed / a.mem) * 100)) : 0,
      });
    }
  } catch {
    metricsAvailable = false;
    nodeMetricsMap.clear();
  }

  return {
    context: currentK8sContextName(),
    metricsAvailable,
    counts: {
      nodes: (nodes.items || []).length,
      pods: (pods.items || []).length,
      services: (services.items || []).length,
      pvc: (pvcs.items || []).length,
    },
    nodes: (nodes.items || []).map((n: any) => ({
      name: n.metadata?.name,
      roles: nodeRoles(n),
      status: (n.status?.conditions || []).find((c: any) => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
      version: n.status?.nodeInfo?.kubeletVersion || '',
      internalIP: (n.status?.addresses || []).find((a: any) => a.type === 'InternalIP')?.address || '',
      cpuPercent: nodeMetricsMap.get(n.metadata?.name)?.cpuPercent ?? null,
      memPercent: nodeMetricsMap.get(n.metadata?.name)?.memPercent ?? null,
    })),
  };
}));

/** 命名空间列表（切换器数据源） */
router.get('/namespaces', wrap(async () => {
  const core = coreApi();
  const res = await core.listNamespace();
  return { namespaces: (res.items || []).map((n: any) => n.metadata?.name).filter(Boolean) };
}));

/** Pod 列表 */
router.get('/pods', wrap(async (req: Request) => {
  const core = coreApi();
  const res = await core.listPodForAllNamespaces();
  return { pods: filterNs(res.items, nsParam(req)).map(normalizePod) };
}));

/** Pod 详情 */
router.get('/pods/:ns/:name', wrap(async (req: Request) => {
  const core = coreApi();
  const res = await core.readNamespacedPod({ name: req.params.name, namespace: req.params.ns });
  return { pod: normalizePod(res) };
}));

/** Pod 日志（tailLines ≤ 2000，只读） */
router.get('/pods/:ns/:name/logs', wrap(async (req: Request) => {
  const core = coreApi();
  const tailLines = Math.min(2000, Math.max(1, Number(req.query.tailLines) || 500));
  const container = req.query.container ? String(req.query.container) : undefined;
  const logs = await core.readNamespacedPodLog({
    name: req.params.name,
    namespace: req.params.ns,
    container,
    follow: false,
    tailLines,
  });
  return { logs: typeof logs === 'string' ? logs : '' };
}));

/** Pod 实时指标（metrics-server 快照；历史曲线由前端停留期间轮询采样） */
router.get('/pods/:ns/:name/metrics', wrap(async (req: Request) => {
  const res = await metricsClient().getPodMetrics(req.params.ns);
  const it = (res.items || []).find((x: any) => x.metadata?.name === req.params.name);
  return {
    available: true,
    containers: (it?.containers || []).map((c: any) => ({
      name: c.name,
      cpuCores: parseQuantity(c.usage?.cpu),
      memBytes: parseQuantity(c.usage?.memory),
    })),
  };
}));

/** Deployment 列表 */
router.get('/deployments', wrap(async (req: Request) => {
  const res = await appsApi().listDeploymentForAllNamespaces();
  return {
    deployments: filterNs(res.items, nsParam(req)).map((d: any) => ({
      name: d.metadata?.name,
      namespace: d.metadata?.namespace,
      replicasDesired: d.spec?.replicas,
      replicasReady: d.status?.readyReplicas ?? 0,
      createdAt: d.metadata?.creationTimestamp ? new Date(d.metadata.creationTimestamp).getTime() : null,
    })),
  };
}));

/** StatefulSet 列表（1.19.0） */
router.get('/statefulsets', wrap(async (req: Request) => {
  const res = await appsApi().listStatefulSetForAllNamespaces();
  return {
    statefulsets: filterNs(res.items, nsParam(req)).map((d: any) => ({
      name: d.metadata?.name,
      namespace: d.metadata?.namespace,
      replicasDesired: d.spec?.replicas,
      replicasReady: d.status?.readyReplicas ?? 0,
      createdAt: d.metadata?.creationTimestamp ? new Date(d.metadata.creationTimestamp).getTime() : null,
    })),
  };
}));

/** DaemonSet 列表（1.19.0） */
router.get('/daemonsets', wrap(async (req: Request) => {
  const res = await appsApi().listDaemonSetForAllNamespaces();
  return {
    daemonsets: filterNs(res.items, nsParam(req)).map((d: any) => ({
      name: d.metadata?.name,
      namespace: d.metadata?.namespace,
      replicasDesired: d.status?.desiredNumberScheduled,
      replicasReady: d.status?.numberReady ?? 0,
      createdAt: d.metadata?.creationTimestamp ? new Date(d.metadata.creationTimestamp).getTime() : null,
    })),
  };
}));

/** ConfigMap/Secret 详情（编辑用，1.19.0） */
router.get('/workload-config/:kind/:ns/:name', wrap(async (req: Request) => {
  const kind = req.params.kind === 'secret' ? 'secret' : 'configmap';
  if (kind === 'secret') {
    const s = await coreApi().readNamespacedSecret({ name: req.params.name, namespace: req.params.ns });
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries((s as any)?.data || {})) {
      data[k] = Buffer.from(String(v), 'base64').toString('utf8');
    }
    return { data, type: (s as any)?.type || '' };
  }
  const cm = await coreApi().readNamespacedConfigMap({ name: req.params.name, namespace: req.params.ns });
  return { data: (cm as any)?.data || {} };
}));

/** ConfigMap/Secret 更新（编辑用，1.19.0；门禁 k8s.configmap.edit / k8s.secret.edit） */
router.put('/workload-config/:kind/:ns/:name', wrap(async (req: Request, res: Response) => {
  const kind = req.params.kind === 'secret' ? 'secret' : 'configmap';
  const { ns, name } = req.params;
  const data = req.body?.data;
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    res.status(400).json({ error: 'data 不能为空' });
    return;
  }
  const target = `${ns}/${name}`;
  const action = kind === 'secret' ? 'k8s.secret.edit' : 'k8s.configmap.edit';
  if (maybeGate(req, res, kind === 'secret' ? 'k8s.secret.edit' : 'k8s.configmap.edit', target, { keys: Object.keys(data) })) return;
  let message: string;
  if (kind === 'secret') {
    const encoded: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      encoded[k] = Buffer.from(String(v), 'utf8').toString('base64');
    }
    message = await updateSecret(ns, name, encoded);
    logOperation(res.locals.username, '编辑 K8s Secret', 'k8s-secret', target);
  } else {
    message = await updateConfigMap(ns, name, data);
    logOperation(res.locals.username, '编辑 K8s ConfigMap', 'k8s-configmap', target);
  }
  res.json({ ok: true, message });
}));

/** Service 列表 */
router.get('/services', wrap(async (req: Request) => {
  const res = await coreApi().listServiceForAllNamespaces();
  return {
    services: filterNs(res.items, nsParam(req)).map((s: any) => ({
      name: s.metadata?.name,
      namespace: s.metadata?.namespace,
      type: s.spec?.type,
      clusterIP: s.spec?.clusterIP,
      ports: (s.spec?.ports || []).map((pt: any) => `${pt.port}/${pt.protocol || 'TCP'}`),
    })),
  };
}));

/** PVC 列表 */
router.get('/pvc', wrap(async (req: Request) => {
  const res = await coreApi().listPersistentVolumeClaimForAllNamespaces();
  return {
    pvcs: filterNs(res.items, nsParam(req)).map((v: any) => ({
      name: v.metadata?.name,
      namespace: v.metadata?.namespace,
      status: v.status?.phase,
      capacity: v.status?.capacity?.storage,
      storageClass: v.spec?.storageClassName,
    })),
  };
}));

/** ConfigMap 列表（只读，含 data 键名与字节量，不含值） */
router.get('/configmaps', wrap(async (req: Request) => {
  const res = await coreApi().listConfigMapForAllNamespaces();
  return {
    configmaps: filterNs(res.items, nsParam(req)).map((m: any) => ({
      name: m.metadata?.name,
      namespace: m.metadata?.namespace,
      keys: Object.keys(m.data || {}),
      sizes: Object.fromEntries(Object.entries(m.data || {}).map(([k, v]) => [k, String(v).length])),
      createdAt: m.metadata?.creationTimestamp ? new Date(m.metadata.creationTimestamp).getTime() : null,
    })),
  };
}));

/** Secret 列表（安全脱敏：仅返回键名，永不返回值） */
router.get('/secrets', wrap(async (req: Request) => {
  const res = await coreApi().listSecretForAllNamespaces();
  return {
    secrets: filterNs(res.items, nsParam(req)).map((s: any) => ({
      name: s.metadata?.name,
      namespace: s.metadata?.namespace,
      type: s.type,
      keys: Object.keys(s.data || {}),
      createdAt: s.metadata?.creationTimestamp ? new Date(s.metadata.creationTimestamp).getTime() : null,
    })),
  };
}));

/** Ingress 列表（只读） */
router.get('/ingresses', wrap(async (req: Request) => {
  const { networkingApi } = await import('../k8s/k8sClient');
  const res = await networkingApi().listIngressForAllNamespaces();
  return {
    ingresses: filterNs(res.items, nsParam(req)).map((i: any) => ({
      name: i.metadata?.name,
      namespace: i.metadata?.namespace,
      className: i.spec?.ingressClassName,
      hosts: (i.spec?.rules || []).map((r: any) => r.host).filter(Boolean),
      tls: (i.spec?.tls || []).flatMap((t: any) => t.hosts || []),
      createdAt: i.metadata?.creationTimestamp ? new Date(i.metadata.creationTimestamp).getTime() : null,
    })),
  };
}));

/** 节点资源历史曲线（小时级聚合，duration=1d|7d|30d|90d，缺省 7d） */
router.get('/metrics-history', wrap(async (req: Request) => {
  const { queryK8sClusterHourly } = await import('../k8s/metrics');
  const duration = String(req.query.duration || '7d');
  const ms: Record<string, number> = {
    '1d': 24 * 3600_000,
    '7d': 7 * 24 * 3600_000,
    '30d': 30 * 24 * 3600_000,
    '90d': 90 * 24 * 3600_000,
  };
  const since = Date.now() - (ms[duration] || ms['7d']);
  const points = queryK8sClusterHourly(since);
  return {
    duration,
    points: points.map((p) => ({
      bucket: p.bucket,
      cpuMillicores: Math.round(p.cpuCores * 1000),
      memKib: Math.round(p.memBytes / 1024),
    })),
  };
}));

/** 节点详情（基本信息 + 可调度状态） */
router.get('/nodes/:name', wrap(async (req: Request) => {
  const core = coreApi();
  const res: any = await core.readNode({ name: req.params.name });
  const n: any = (res && typeof res.body === 'object' ? res.body : res) || {};
  return {
    node: {
      name: n.metadata?.name,
      roles: Object.keys(n.metadata?.labels || {})
        .filter((k) => k.startsWith('node-role.kubernetes.io/'))
        .map((k) => k.split('/')[1]),
      status: (n.status?.conditions || []).find((c: any) => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
      version: n.status?.nodeInfo?.kubeletVersion || '',
      internalIP: (n.status?.addresses || []).find((a: any) => a.type === 'InternalIP')?.address || '',
      os: n.status?.nodeInfo?.osImage || '',
      architecture: n.status?.nodeInfo?.architecture || '',
      unschedulable: n.spec?.unschedulable === true,
      cpuAllocatable: parseQuantity(n.status?.allocatable?.cpu),
      memAllocatable: parseQuantity(n.status?.allocatable?.memory),
      podCapacity: Number(n.status?.capacity?.pods) || 0,
      createdAt: n.metadata?.creationTimestamp ? new Date(n.metadata.creationTimestamp).getTime() : null,
    },
  };
}));

/** 单节点资源历史曲线（小时级聚合） */
router.get('/nodes/:name/metrics-history', wrap(async (req: Request) => {
  const { queryK8sNodeHourly } = await import('../k8s/metrics');
  const duration = String(req.query.duration || '7d');
  const ms: Record<string, number> = {
    '1d': 24 * 3600_000,
    '7d': 7 * 24 * 3600_000,
    '30d': 30 * 24 * 3600_000,
    '90d': 90 * 24 * 3600_000,
  };
  const since = Date.now() - (ms[duration] || ms['7d']);
  const points = queryK8sNodeHourly(req.params.name, since);
  return {
    duration,
    node: req.params.name,
    points: points.map((p) => ({
      bucket: p.ts_hour,
      cpuMillicores: Math.round(p.cpu_avg * 1000),
      memKib: Math.round(p.mem_avg / 1024),
    })),
  };
}));

/** Pod 资源历史曲线（小时级聚合，k8s-pod scope） */
router.get('/pods/:ns/:name/metrics-history', wrap(async (req: Request) => {
  const { queryK8sPodHourly } = await import('../k8s/metrics');
  const duration = String(req.query.duration || '1d');
  const ms: Record<string, number> = {
    '1d': 24 * 3600_000,
    '7d': 7 * 24 * 3600_000,
    '30d': 30 * 24 * 3600_000,
    '90d': 90 * 24 * 3600_000,
  };
  const since = Date.now() - (ms[duration] || ms['7d']);
  const points = queryK8sPodHourly(`${req.params.ns}/${req.params.name}`, since);
  return {
    duration,
    points: points.map((p) => ({
      bucket: p.ts_hour,
      cpuMillicores: Math.round(p.cpu_avg * 1000),
      memKib: Math.round(p.mem_avg / 1024),
    })),
  };
}));

/** Helm Release 只读列表（解析 helm release secret 名与 labels + 深度解码 protobuf payload） */
router.get('/helm-releases', wrap(async () => {
  const res = await coreApi().listSecretForAllNamespaces({ labelSelector: 'owner=helm' });
  const { decodeHelmRelease } = await import('../k8s/helmDecode');
  const seen = new Map<string, {
    name: string; namespace: string; revision: number; status: string;
    chartName: string; chartVersion: string; lastDeployedAt: number | null; updatedAt: number | null;
  }>();
  for (const s of res.items || []) {
    const m = String(s.metadata?.name || '').match(/^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/);
    if (!m) continue;
    const key = `${s.metadata?.namespace}/${m[1]}`;
    const rev = Number(m[2]) || 0;
    const updatedAt = s.metadata?.creationTimestamp ? new Date(s.metadata.creationTimestamp).getTime() : null;
    // Helm 3 release secret 自带 labels：name / owner / status / version；data.release 为 protobuf 深度解码源
    const labelStatus = String(s.metadata?.labels?.status || '');
    let chartName = '';
    let chartVersion = '';
    let status = labelStatus;
    let lastDeployedAt: number | null = null;
    const payload = (s.data as Record<string, string> | undefined)?.release;
    if (payload) {
      const decoded = decodeHelmRelease(payload);
      if (decoded) {
        chartName = decoded.chartName;
        chartVersion = decoded.chartVersion;
        if (decoded.status) status = decoded.status;
        if (decoded.lastDeployedAt) lastDeployedAt = decoded.lastDeployedAt;
      }
    }
    const prev = seen.get(key);
    if (!prev || rev > prev.revision) {
      seen.set(key, { name: m[1], namespace: s.metadata?.namespace || '', revision: rev, status, chartName, chartVersion, lastDeployedAt, updatedAt });
    }
  }
  return { releases: [...seen.values()].sort((a, b) => b.revision - a.revision) };
}));

/** 集群事件 */
router.get('/events', wrap(async (req: Request) => {
  const ns = nsParam(req);
  const core = coreApi();
  const res = ns ? await core.listNamespacedEvent({ namespace: ns }) : await core.listEventForAllNamespaces();
  return {
    events: (res.items || []).map((e: any) => ({
      type: e.type,
      reason: e.reason,
      message: e.message,
      object: e.involvedObject?.name,
      kind: e.involvedObject?.kind,
      count: e.count,
      lastAt: e.lastTimestamp ? new Date(e.lastTimestamp).getTime() : null,
    })),
  };
}));

/** 本地历史事件（1.12.0 落库）：集群不可达时仍可回看最近 7 天事件 */
router.get('/events-history', wrap(async (req: Request) => {
  const { queryK8sEventsHistory } = await import('../k8s/eventWatcher');
  const ns = nsParam(req);
  const limit = Number(req.query.limit) || 200;
  return { events: queryK8sEventsHistory(ns || undefined, limit) };
}));


/** Deployment 扩缩容（非管理员且无 k8s.write 权限时转审批） */
router.post('/deployments/:ns/:name/scale', wrap(async (req: Request, res: Response) => {
  const { ns, name } = req.params;
  const replicas = Math.floor(Number(req.body?.replicas));
  if (!Number.isFinite(replicas) || replicas < 0 || replicas > 500) {
    res.status(400).json({ error: `副本数不合法: ${req.body?.replicas}（应为 0-500 整数）` });
    return;
  }
  const target = `${ns}/${name}`;
  if (maybeGate(req, res, 'k8s.deployment.scale', target, { replicas })) return;
  await scaleDeployment(ns, name, replicas);
  logOperation(res.locals.username, 'K8s 扩缩容', 'k8s-deployment', target, `replicas=${replicas}`);
  res.json({ ok: true, message: `副本数已调整为 ${replicas}` });
}));

/** Deployment 滚动重启（非管理员且无 k8s.write 权限时转审批） */
router.post('/deployments/:ns/:name/restart', wrap(async (req: Request, res: Response) => {
  const { ns, name } = req.params;
  const target = `${ns}/${name}`;
  if (maybeGate(req, res, 'k8s.deployment.restart', target, {})) return;
  await restartDeployment(ns, name);
  logOperation(res.locals.username, 'K8s 滚动重启', 'k8s-deployment', target);
  res.json({ ok: true, message: '已触发滚动重启' });
}));

/** 删除 Pod（非管理员且无 k8s.delete 权限时转审批） */
router.delete('/pods/:ns/:name', wrap(async (req: Request, res: Response) => {
  const { ns, name } = req.params;
  const target = `${ns}/${name}`;
  if (maybeGate(req, res, 'k8s.pod.delete', target, {})) return;
  await deletePod(ns, name);
  logOperation(res.locals.username, '删除 K8s Pod', 'k8s-pod', target);
  res.json({ ok: true, message: 'Pod 已删除' });
}));

/** Deployment 回滚到指定 revision（1.17.0，缺省回滚到上一个版本） */
router.post('/deployments/:ns/:name/rollback', wrap(async (req: Request, res: Response) => {
  const { ns, name } = req.params;
  const target = `${ns}/${name}`;
  const revision = req.body?.revision ? Number(req.body.revision) : undefined;
  if (revision !== undefined && (!Number.isFinite(revision) || revision < 1)) {
    res.status(400).json({ error: `revision 不合法: ${req.body?.revision}` });
    return;
  }
  if (maybeGate(req, res, 'k8s.deployment.rollback', target, { revision: revision || null })) return;
  const message = await rolloutUndoDeployment(ns, name, revision);
  logOperation(res.locals.username, 'K8s Deployment 回滚', 'k8s-deployment', target, message);
  res.json({ ok: true, message });
}));

/** PVC 扩容（1.17.0，仅允许增大容量） */
router.post('/pvc/:ns/:name/resize', wrap(async (req: Request, res: Response) => {
  const { ns, name } = req.params;
  const storage = String(req.body?.storage || '').trim();
  const target = `${ns}/${name}`;
  if (maybeGate(req, res, 'k8s.pvc.resize', target, { storage })) return;
  try {
    const message = await resizePvc(ns, name, storage);
    logOperation(res.locals.username, 'K8s PVC 扩容', 'k8s-pvc', target, `${storage}`);
    res.json({ ok: true, message });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '扩容失败' });
  }
}));

/** 资源删除（1.21.0：Ingress / Service / PVC / ConfigMap，门禁统一 k8s.delete） */
const DELETE_KINDS: Array<{ kind: string; path: string; del: (ns: string, name: string) => Promise<unknown> }> = [
  {
    kind: 'ingress',
    path: '/ingresses/:ns/:name',
    del: async (ns, name) => {
      const { networkingApi } = await import('../k8s/k8sClient');
      await networkingApi().deleteNamespacedIngress({ name, namespace: ns });
    },
  },
  {
    kind: 'service',
    path: '/services/:ns/:name',
    del: async (ns, name) => {
      const { coreApi } = await import('../k8s/k8sClient');
      await coreApi().deleteNamespacedService({ name, namespace: ns });
    },
  },
  {
    kind: 'pvc',
    path: '/pvc/:ns/:name',
    del: async (ns, name) => {
      const { coreApi } = await import('../k8s/k8sClient');
      await coreApi().deleteNamespacedPersistentVolumeClaim({ name, namespace: ns });
    },
  },
  {
    kind: 'configmap',
    path: '/configmaps/:ns/:name',
    del: async (ns, name) => {
      const { coreApi } = await import('../k8s/k8sClient');
      await coreApi().deleteNamespacedConfigMap({ name, namespace: ns });
    },
  },
];

for (const { kind, path: p, del } of DELETE_KINDS) {
  router.delete(p, wrap(async (req: Request, res: Response) => {
    const { ns, name } = req.params;
    const target = `${ns}/${name}`;
    if (maybeGate(req, res, `k8s.${kind}.delete`, target, {})) return;
    await del(ns, name);
    logOperation(res.locals.username, `删除 K8s ${kind}`, `k8s-${kind}`, target);
    res.json({ ok: true, message: `${kind} ${target} 已删除` });
  }));
}

/** Pod 重建（1.17.0，删除后由控制器自动重建；独立 Pod 不支持） */
router.post('/pods/:ns/:name/recreate', wrap(async (req: Request, res: Response) => {
  const { ns, name } = req.params;
  const target = `${ns}/${name}`;
  if (maybeGate(req, res, 'k8s.pod.recreate', target, {})) return;
  const message = await recreatePod(ns, name);
  logOperation(res.locals.username, '重建 K8s Pod', 'k8s-pod', target);
  res.json({ ok: true, message });
}));

/** Helm Release 历史版本（1.20.0：列出该 release 的全部 revision，含深度解码元信息） */
router.get('/helm-history/:ns/:name', wrap(async (req: Request) => {
  const { ns, name } = req.params;
  const res = await coreApi().listSecretForAllNamespaces({
    labelSelector: 'owner=helm',
  });
  const { decodeHelmRelease } = await import('../k8s/helmDecode');
  const history: Array<{
    revision: number; status: string; chartName: string; chartVersion: string;
    chartNameDecoded: boolean; lastDeployedAt: number | null; updatedAt: number | null;
  }> = [];
  for (const s of res.items || []) {
    if (s.metadata?.namespace !== ns) continue;
    const m = String(s.metadata?.name || '').match(/^sh\.helm\.release\.v1\.(.+)\.v(\d+)$/);
    if (!m || m[1] !== name) continue;
    const updatedAt = s.metadata?.creationTimestamp ? new Date(s.metadata.creationTimestamp).getTime() : null;
    const labelStatus = String(s.metadata?.labels?.status || '');
    let chartName = '';
    let chartVersion = '';
    let status = labelStatus;
    let lastDeployedAt: number | null = null;
    const payload = (s.data as Record<string, string> | undefined)?.release;
    if (payload) {
      const decoded = decodeHelmRelease(payload);
      if (decoded) {
        chartName = decoded.chartName;
        chartVersion = decoded.chartVersion;
        if (decoded.status) status = decoded.status;
        if (decoded.lastDeployedAt) lastDeployedAt = decoded.lastDeployedAt;
      }
    }
    history.push({
      revision: Number(m[2]) || 0,
      status,
      chartName,
      chartVersion,
      chartNameDecoded: !!chartName,
      lastDeployedAt,
      updatedAt,
    });
  }
  return { history: history.sort((a, b) => b.revision - a.revision) };
}));

/** StatefulSet 滚动重启（1.19.0） */
router.post('/statefulsets/:ns/:name/restart', wrap(async (req: Request, res: Response) => {
  const { ns, name } = req.params;
  const target = `${ns}/${name}`;
  if (maybeGate(req, res, 'k8s.sts.restart', target, {})) return;
  const message = await restartStatefulSet(ns, name);
  logOperation(res.locals.username, 'K8s StatefulSet 重启', 'k8s-statefulset', target);
  res.json({ ok: true, message });
}));

/** DaemonSet 滚动重启（1.19.0） */
router.post('/daemonsets/:ns/:name/restart', wrap(async (req: Request, res: Response) => {
  const { ns, name } = req.params;
  const target = `${ns}/${name}`;
  if (maybeGate(req, res, 'k8s.ds.restart', target, {})) return;
  const message = await restartDaemonSet(ns, name);
  logOperation(res.locals.username, 'K8s DaemonSet 重启', 'k8s-daemonset', target);
  res.json({ ok: true, message });
}));

export default router;
