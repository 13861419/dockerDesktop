/**
 * Kubernetes 工作负载页（1.5.0 一期：只读）
 *
 * 标签页：Pod / Deployment / Service / PVC，支持命名空间过滤与关键字搜索。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, get, post } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Empty from '../components/Empty';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import { Select } from '../components/Form';
import { translateNow as t } from '../i18n';
import './k8s.less';

/** Pod 视图 */
interface K8sPod {
  name: string;
  namespace: string;
  phase: string;
  detailStatus: string;
  ready: string;
  restarts: number;
  node: string;
  createdAt: number | null;
}

/** Deployment 视图 */
interface K8sDeployment {
  name: string;
  namespace: string;
  replicasDesired: number;
  replicasReady: number;
  createdAt: number | null;
}

/** Service 视图 */
interface K8sService {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string;
  ports: string[];
}

/** PVC 视图 */
interface K8sPvc {
  name: string;
  namespace: string;
  status: string;
  capacity: string;
  storageClass: string;
}

/** ConfigMap 视图 */
interface K8sConfigMap {
  name: string;
  namespace: string;
  keys: string[];
  sizes: Record<string, number>;
  createdAt: number | null;
}

/** Secret 视图（脱敏：仅键名） */
interface K8sSecret {
  name: string;
  namespace: string;
  type: string;
  keys: string[];
  createdAt: number | null;
}

/** Helm Release 视图（只读元信息） */
interface K8sHelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chartName: string;
  chartVersion: string;
  lastDeployedAt: number | null;
  updatedAt: number | null;
}

/** Ingress 视图 */
interface K8sIngress {
  name: string;
  namespace: string;
  className: string;
  hosts: string[];
  tls: string[];
  createdAt: number | null;
}

type TabKey = 'pods' | 'deployments' | 'statefulsets' | 'daemonsets' | 'services' | 'pvc' | 'configmaps' | 'ingresses' | 'helm';

/** Pod 状态徽标 class */
function podStatusClass(status: string): string {
  if (status === 'Running') return 'k8s__badge k8s__badge--ok';
  if (status === 'Pending') return 'k8s__badge k8s__badge--warn';
  if (status === 'Succeeded') return 'k8s__badge k8s__badge--ok';
  return 'k8s__badge k8s__badge--bad';
}

export default function K8sWorkloads() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const admin = isAdmin();
  const [tab, setTab] = useState<TabKey>('pods');
  const [ns, setNs] = useState('');
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [pods, setPods] = useState<K8sPod[]>([]);
  const [deployments, setDeployments] = useState<K8sDeployment[]>([]);
  const [statefulsets, setStatefulsets] = useState<K8sDeployment[]>([]);
  const [daemonsets, setDaemonsets] = useState<K8sDeployment[]>([]);
  const [services, setServices] = useState<K8sService[]>([]);
  const [pvcs, setPvcs] = useState<K8sPvc[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [scaleTarget, setScaleTarget] = useState<K8sDeployment | null>(null);
  const [scaleReplicas, setScaleReplicas] = useState('3');
  const [restartTarget, setRestartTarget] = useState<K8sDeployment | null>(null);
  const [resizeTarget, setResizeTarget] = useState<K8sPvc | null>(null);
  const [delTarget, setDelTarget] = useState<{ kind: string; namespace: string; name: string } | null>(null);
  const [resizeStorage, setResizeStorage] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editKind, setEditKind] = useState<'cm' | 'secret' | null>(null);
  const [editNs, setEditNs] = useState('');
  const [editName, setEditName] = useState('');
  const [editData, setEditData] = useState<Record<string, string>>({});
  const [helmHistoryOpen, setHelmHistoryOpen] = useState(false);
  const [helmHistoryNs, setHelmHistoryNs] = useState('');
  const [helmHistoryName, setHelmHistoryName] = useState('');
  const [helmHistory, setHelmHistory] = useState<Array<{ revision: number; status: string; chartName: string; chartVersion: string; lastDeployedAt: number | null; updatedAt: number | null }>>([]);
  const [configmaps, setConfigmaps] = useState<K8sConfigMap[]>([]);
  const [secrets, setSecrets] = useState<K8sSecret[]>([]);
  const [ingresses, setIngresses] = useState<K8sIngress[]>([]);
  const [helm, setHelm] = useState<K8sHelmRelease[]>([]);

  const load = useCallback(async (nsArg: string) => {
    setLoading(true);
    try {
      const q = nsArg && nsArg !== 'all' ? `?namespace=${encodeURIComponent(nsArg)}` : '';
      const [podRes, depRes, stsRes, dsRes, svcRes, pvcRes, nsRes, cmRes, secretRes, ingRes, helmRes] = await Promise.all([
        get<{ pods: K8sPod[] }>(`/api/k8s/pods${q}`),
        get<{ deployments: K8sDeployment[] }>(`/api/k8s/deployments${q}`),
        get<{ statefulsets: K8sDeployment[] }>(`/api/k8s/statefulsets${q}`),
        get<{ daemonsets: K8sDeployment[] }>(`/api/k8s/daemonsets${q}`),
        get<{ services: K8sService[] }>(`/api/k8s/services${q}`),
        get<{ pvcs: K8sPvc[] }>(`/api/k8s/pvc${q}`),
        get<{ namespaces: string[] }>(`/api/k8s/namespaces`),
        get<{ configmaps: K8sConfigMap[] }>(`/api/k8s/configmaps${q}`),
        get<{ secrets: K8sSecret[] }>(`/api/k8s/secrets${q}`),
        get<{ ingresses: K8sIngress[] }>(`/api/k8s/ingresses${q}`),
        get<{ releases: K8sHelmRelease[] }>(`/api/k8s/helm-releases${q}`),
      ]);
      setPods(podRes.pods || []);
      setDeployments(depRes.deployments || []);
      setStatefulsets(stsRes.statefulsets || []);
      setDaemonsets(dsRes.daemonsets || []);
      setServices(svcRes.services || []);
      setPvcs(pvcRes.pvcs || []);
      setConfigmaps(cmRes.configmaps || []);
      setSecrets(secretRes.secrets || []);
      setIngresses(ingRes.ingresses || []);
      setHelm(helmRes.releases || []);
      setNamespaces(nsRes.namespaces || []);
      setUnavailable(false);
    } catch (err) {
      const msg = (err as Error)?.message || '';
      if (msg.includes('503') || msg.includes('不可用')) setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(ns);
  }, [load, ns]);

  /** 扩缩容提交（后端可能转 202 审批） */
  const doScale = async () => {
    if (!scaleTarget) return;
    try {
      const body = await post<{ approvalPending?: boolean; message?: string; ticketNo?: string }>(
        `/api/k8s/deployments/${encodeURIComponent(scaleTarget.namespace)}/${encodeURIComponent(scaleTarget.name)}/scale`,
        { replicas: Number(scaleReplicas) },
      );
      if (body?.approvalPending) {
        showToast(`${t('已转审批：等待管理员批准后执行')} (${body.ticketNo || ''})`, 'info');
      } else {
        showToast(body?.message || t('副本数已调整'), 'success');
      }
      setScaleTarget(null);
      void load(ns);
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  /** 滚动重启提交 */
  const doRestart = async () => {
    if (!restartTarget) return;
    try {
      const body = await post<{ approvalPending?: boolean; message?: string; ticketNo?: string }>(
        `/api/k8s/deployments/${encodeURIComponent(restartTarget.namespace)}/${encodeURIComponent(restartTarget.name)}/restart`,
        {},
      );
      if (body?.approvalPending) {
        showToast(`${t('已转审批：等待管理员批准')} (${body.ticketNo || ''})`, 'info');
      } else {
        showToast(body?.message || t('已触发滚动重启'), 'success');
      }
      setRestartTarget(null);
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  /** 回滚到上一个版本（1.17.0） */
  const doRollback = async (d: K8sDeployment) => {
    try {
      const body = await post<{ approvalPending?: boolean; message?: string; ticketNo?: string }>(
        `/api/k8s/deployments/${encodeURIComponent(d.namespace)}/${encodeURIComponent(d.name)}/rollback`,
        {},
      );
      if (body?.approvalPending) {
        showToast(`${t('已转审批：等待管理员批准')} (${body.ticketNo || ''})`, 'info');
      } else {
        showToast(body?.message || t('已触发回滚'), 'success');
      }
      void load(ns);
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  /** PVC 扩容提交 */
  const doResize = async () => {
    if (!resizeTarget) return;
    try {
      const body = await post<{ approvalPending?: boolean; message?: string; ticketNo?: string }>(
        `/api/k8s/pvc/${encodeURIComponent(resizeTarget.namespace)}/${encodeURIComponent(resizeTarget.name)}/resize`,
        { storage: resizeStorage },
      );
      if (body?.approvalPending) {
        showToast(`${t('已转审批：等待管理员批准')} (${body.ticketNo || ''})`, 'info');
      } else {
        showToast(body?.message || t('扩容请求已提交'), 'success');
      }
      setResizeTarget(null);
      void load(ns);
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  /** 资源删除（1.21.0，后端可能转 202 审批） */
  const doDelete = async () => {
    if (!delTarget) return;
    try {
      const body = await del<{ ok?: boolean; message?: string; approvalPending?: boolean; ticketNo?: string }>(
        `/api/k8s/${delTarget.kind}/${encodeURIComponent(delTarget.namespace)}/${encodeURIComponent(delTarget.name)}`,
      );
      if (body?.approvalPending) {
        showToast(`${t('已转审批：等待管理员批准')} (${body.ticketNo || ''})`, 'info');
      } else {
        showToast(body?.message || t('已删除'), 'success');
      }
      setDelTarget(null);
      void load(ns);
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  /** ConfigMap/Secret 在线编辑（1.19.0） */
  const openEdit = async (kind: 'cm' | 'secret', ns2: string, name: string) => {
    try {
      const res = await get<{ data: Record<string, string> }>(
        `/api/k8s/workload-config/${kind}/${encodeURIComponent(ns2)}/${encodeURIComponent(name)}`,
      );
      setEditKind(kind);
      setEditNs(ns2);
      setEditName(name);
      setEditData({ ...(res.data || {}) });
      setEditOpen(true);
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  const doSaveEdit = async () => {
    if (!editKind || !editNs || !editName) return;
    try {
      const body = await post<{ approvalPending?: boolean; message?: string; ticketNo?: string }>(
        `/api/k8s/workload-config/${editKind}/${encodeURIComponent(editNs)}/${encodeURIComponent(editName)}`,
        { data: editData },
      );
      if (body?.approvalPending) {
        showToast(`${t('已转审批：等待管理员批准')} (${body.ticketNo || ''})`, 'info');
      } else {
        showToast(body?.message || t('已保存'), 'success');
      }
      setEditOpen(false);
      void load(ns);
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  /** Helm release 历史版本查看（1.20.0） */
  const openHelmHistory = async (ns2: string, name: string) => {
    try {
      const res = await get<{ history: Array<{ revision: number; status: string; chartName: string; chartVersion: string; lastDeployedAt: number | null; updatedAt: number | null }> }>(
        `/api/k8s/helm-history/${encodeURIComponent(ns2)}/${encodeURIComponent(name)}`,
      );
      setHelmHistoryNs(ns);
      setHelmHistoryName(name);
      setHelmHistory(res.history || []);
      setHelmHistoryOpen(true);
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  /** 关键字过滤 */
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const match = (s: string) => s.toLowerCase().includes(kw);
    if (!kw) return { pods, deployments, statefulsets, daemonsets, services, pvcs, configmaps, secrets, ingresses, helm };
    return {
      pods: pods.filter((p) => `${p.namespace}/${p.name}`.toLowerCase().includes(kw)),
      deployments: deployments.filter((d) => `${d.namespace}/${d.name}`.toLowerCase().includes(kw)),
      statefulsets: statefulsets.filter((d) => `${d.namespace}/${d.name}`.toLowerCase().includes(kw)),
      daemonsets: daemonsets.filter((d) => `${d.namespace}/${d.name}`.toLowerCase().includes(kw)),
      services: services.filter((s) => `${s.namespace}/${s.name}`.toLowerCase().includes(kw)),
      pvcs: pvcs.filter((v) => `${v.namespace}/${v.name}`.toLowerCase().includes(kw)),
      configmaps: configmaps.filter((m) => `${m.namespace}/${m.name}`.toLowerCase().includes(kw)),
      secrets: secrets.filter((s) => `${s.namespace}/${s.name}`.toLowerCase().includes(kw)),
      ingresses: ingresses.filter((i) => `${i.namespace}/${i.name}`.toLowerCase().includes(kw)),
      helm: helm.filter((h) => `${h.namespace}/${h.name}`.toLowerCase().includes(kw)),
    };
  }, [search, pods, deployments, statefulsets, daemonsets, services, pvcs, configmaps, secrets, ingresses, helm]);

  if (unavailable) {
    return (
      <div className="k8s">
        <Card title={t('工作负载')}>
          <Empty title={t('Kubernetes 不可用：请先配置 kubeconfig')} />
        </Card>
      </div>
    );
  }

  return (
    <div className="k8s">
      <div className="k8s__toolbar">
        <h2 className="k8s__title">{t('工作负载')}</h2>
        <div className="k8s__toolbar-controls">
          <input
            className="input k8s__search"
            placeholder={t('搜索名称…')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select className="k8s__select" value={ns || 'all'} onChange={(e) => setNs(e.target.value)}>
            <option value="all">{t('全部命名空间')}</option>
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Button variant="ghost" onClick={() => void load(ns)}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      <Card>
        <div className="k8s__tabs">
          {(
            [
              ['pods', `Pod (${filtered.pods.length})`],
              ['deployments', `Deployment (${filtered.deployments.length})`],
              ['statefulsets', `StatefulSet (${filtered.statefulsets.length})`],
              ['daemonsets', `DaemonSet (${filtered.daemonsets.length})`],
              ['services', `Service (${filtered.services.length})`],
              ['pvc', `PVC (${filtered.pvcs.length})`],
              ['configmaps', `ConfigMap (${filtered.configmaps.length})`],
              ['ingresses', `Ingress (${filtered.ingresses.length})`],
              ['helm', `Helm (${filtered.helm.length})`],
            ] as Array<[TabKey, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`k8s__tab ${tab === key ? 'k8s__tab--active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="k8s__loading">{t('加载中…')}</div>
        ) : (
          <div className="k8s__table-wrap">
            {tab === 'pods' ? (
              filtered.pods.length === 0 ? (
                <Empty title={t('暂无 Pod')} />
              ) : (
                <table className="k8s__table">
                  <thead>
                    <tr>
                      <th>{t('名称')}</th>
                      <th>{t('命名空间')}</th>
                      <th>{t('状态')}</th>
                      <th>{t('就绪')}</th>
                      <th>{t('重启')}</th>
                      <th>{t('节点')}</th>
                      <th>{t('创建时间')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.pods.map((p) => (
                      <tr
                        key={`${p.namespace}/${p.name}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/k8s/pod/${encodeURIComponent(p.namespace)}/${encodeURIComponent(p.name)}`)}
                      >
                        <td className="k8s__mono">{p.name}</td>
                        <td>{p.namespace}</td>
                        <td>
                          <span className={podStatusClass(p.detailStatus)}>{p.detailStatus}</span>
                        </td>
                        <td>{p.ready}</td>
                        <td>{p.restarts}</td>
                        <td className="k8s__mono">{p.node || '—'}</td>
                        <td>{p.createdAt ? new Date(p.createdAt).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}

            {tab === 'deployments' ? (
              filtered.deployments.length === 0 ? (
                <Empty title={t('暂无 Deployment')} />
              ) : (
                <table className="k8s__table">
                  <thead>
                    <tr>
                      <th>{t('名称')}</th>
                      <th>{t('命名空间')}</th>
                      <th>{t('副本')}</th>
                      <th>{t('创建时间')}</th>
                      {admin ? <th>{t('操作')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.deployments.map((d) => (
                      <tr key={`${d.namespace}/${d.name}`}>
                        <td className="k8s__mono">{d.name}</td>
                        <td>{d.namespace}</td>
                        <td>
                          {d.replicasReady}/{d.replicasDesired}
                        </td>
                        <td>{d.createdAt ? new Date(d.createdAt).toLocaleString() : '—'}</td>
                        {admin ? (
                          <td>
                            <span style={{ display: 'inline-flex', gap: 6 }}>
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  setScaleTarget(d);
                                  setScaleReplicas(String(d.replicasDesired ?? 1));
                                }}
                              >
                                {t('扩缩容')}
                              </Button>
                              <Button variant="ghost" onClick={() => setRestartTarget(d)}>
                                {t('滚动重启')}
                              </Button>
                              <Button variant="ghost" onClick={() => void doRollback(d)}>
                                {t('回滚')}
                              </Button>
                            </span>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}

            {tab === 'statefulsets' || tab === 'daemonsets' ? (
              (tab === 'statefulsets' ? filtered.statefulsets : filtered.daemonsets).length === 0 ? (
                <Empty title={tab === 'statefulsets' ? t('暂无 StatefulSet') : t('暂无 DaemonSet')} />
              ) : (
                <table className="k8s__table">
                  <thead>
                    <tr>
                      <th>{t('名称')}</th>
                      <th>{t('命名空间')}</th>
                      <th>{tab === 'statefulsets' ? t('期望/就绪') : t('就绪/期望')}</th>
                      <th>{t('创建时间')}</th>
                      {admin ? <th>{t('操作')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {(tab === 'statefulsets' ? filtered.statefulsets : filtered.daemonsets).map((d) => (
                      <tr key={`${d.namespace}/${d.name}`}>
                        <td className="k8s__mono">{d.name}</td>
                        <td>{d.namespace}</td>
                        <td>
                          {d.replicasReady}/{d.replicasDesired}
                        </td>
                        <td>{d.createdAt ? new Date(d.createdAt).toLocaleString() : '—'}</td>
                        {admin ? (
                          <td>
                            <Button
                              variant="ghost"
                              onClick={() =>
                                void (async () => {
                                  try {
                                    const kindPath = tab === 'statefulsets' ? 'statefulsets' : 'daemonsets';
                                    const body = await post<{ approvalPending?: boolean; message?: string; ticketNo?: string }>(
                                      `/api/k8s/${kindPath}/${encodeURIComponent(d.namespace)}/${encodeURIComponent(d.name)}/restart`,
                                      {},
                                    );
                                    if (body?.approvalPending) {
                                      showToast(`${t('已转审批：等待管理员批准')} (${body.ticketNo || ''})`, 'info');
                                    } else {
                                      showToast(body?.message || t('已触发滚动重启'), 'success');
                                    }
                                    void load(ns);
                                  } catch (err) {
                                    showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
                                  }
                                })()
                              }
                            >
                              {t('滚动重启')}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}

            {tab === 'services' ? (
              filtered.services.length === 0 ? (
                <Empty title={t('暂无 Service')} />
              ) : (
                <table className="k8s__table">
                  <thead>
                    <tr>
                      <th>{t('名称')}</th>
                      <th>{t('命名空间')}</th>
                      <th>{t('类型')}</th>
                      <th>ClusterIP</th>
                      <th>{t('端口')}</th>
                      {admin ? <th>{t('操作')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.services.map((s) => (
                      <tr key={`${s.namespace}/${s.name}`}>
                        <td className="k8s__mono">{s.name}</td>
                        <td>{s.namespace}</td>
                        <td>{s.type || '—'}</td>
                        <td className="k8s__mono">{s.clusterIP || '—'}</td>
                        <td>{s.ports.join(', ') || '—'}</td>
                        {admin ? (
                          <td>
                            <Button variant="ghost" onClick={() => setDelTarget({ kind: 'services', namespace: s.namespace, name: s.name })}>
                              {t('删除')}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}

            {tab === 'pvc' ? (
              filtered.pvcs.length === 0 ? (
                <Empty title={t('暂无 PVC')} />
              ) : (
                <table className="k8s__table">
                  <thead>
                    <tr>
                      <th>{t('名称')}</th>
                      <th>{t('命名空间')}</th>
                      <th>{t('状态')}</th>
                      <th>{t('容量')}</th>
                      <th>StorageClass</th>
                      {admin ? <th>{t('操作')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.pvcs.map((v) => (
                      <tr key={`${v.namespace}/${v.name}`}>
                        <td className="k8s__mono">{v.name}</td>
                        <td>{v.namespace}</td>
                        <td>
                          <span className={v.status === 'Bound' ? 'k8s__badge k8s__badge--ok' : 'k8s__badge k8s__badge--warn'}>
                            {v.status || '—'}
                          </span>
                        </td>
                        <td>{v.capacity || '—'}</td>
                        <td>{v.storageClass || '—'}</td>
                        {admin ? (
                          <td>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setResizeTarget(v);
                                setResizeStorage(v.capacity || '');
                              }}
                            >
                              {t('扩容')}
                            </Button>{' '}
                            <Button variant="ghost" onClick={() => setDelTarget({ kind: 'pvc', namespace: v.namespace, name: v.name })}>
                              {t('删除')}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}

            {tab === 'configmaps' ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0' }}>{t('ConfigMap')}</div>
                {filtered.configmaps.length === 0 ? (
                  <Empty title={t('暂无 ConfigMap')} />
                ) : (
                  <table className="k8s__table" style={{ marginBottom: 16 }}>
                    <thead>
                      <tr>
                        <th>{t('名称')}</th>
                        <th>{t('命名空间')}</th>
                        <th>{t('键')}</th>
                        <th>{t('创建时间')}</th>
                        {admin ? <th>{t('操作')}</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.configmaps.map((m) => (
                        <tr key={`${m.namespace}/${m.name}`}>
                          <td className="k8s__mono">{m.name}</td>
                          <td>{m.namespace}</td>
                          <td style={{ whiteSpace: 'normal' }}>
                            {m.keys.map((k) => `${k} (${m.sizes[k] ?? 0}B)`).join(', ') || '—'}
                          </td>
                          <td>{m.createdAt ? new Date(m.createdAt).toLocaleString() : '—'}</td>
                          {admin ? (
                            <td>
                              <Button variant="ghost" onClick={() => void openEdit('cm', m.namespace, m.name)}>
                                {t('编辑')}
                              </Button>{' '}
                              <Button variant="ghost" onClick={() => setDelTarget({ kind: 'configmaps', namespace: m.namespace, name: m.name })}>
                                {t('删除')}
                              </Button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0' }}>{t('Secret（仅显示键名，值已脱敏）')}</div>
                {filtered.secrets.length === 0 ? (
                  <Empty title={t('暂无 Secret')} />
                ) : (
                  <table className="k8s__table">
                    <thead>
                      <tr>
                        <th>{t('名称')}</th>
                        <th>{t('命名空间')}</th>
                        <th>{t('类型')}</th>
                        <th>{t('键')}</th>
                        <th>{t('创建时间')}</th>
                        {admin ? <th>{t('操作')}</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.secrets.map((s) => (
                        <tr key={`${s.namespace}/${s.name}`}>
                          <td className="k8s__mono">{s.name}</td>
                          <td>{s.namespace}</td>
                          <td>{s.type || '—'}</td>
                          <td style={{ whiteSpace: 'normal' }}>{s.keys.join(', ') || '—'}</td>
                          <td>{s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
                          {admin ? (
                            <td>
                              <Button variant="ghost" onClick={() => void openEdit('secret', s.namespace, s.name)}>
                                {t('编辑')}
                              </Button>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            ) : null}

            {tab === 'ingresses' ? (
              filtered.ingresses.length === 0 ? (
                <Empty title={t('暂无 Ingress')} />
              ) : (
                <table className="k8s__table">
                  <thead>
                    <tr>
                      <th>{t('名称')}</th>
                      <th>{t('命名空间')}</th>
                      <th>Class</th>
                      <th>{t('主机')}</th>
                      <th>TLS</th>
                      <th>{t('创建时间')}</th>
                      {admin ? <th>{t('操作')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.ingresses.map((i) => (
                      <tr key={`${i.namespace}/${i.name}`}>
                        <td className="k8s__mono">{i.name}</td>
                        <td>{i.namespace}</td>
                        <td>{i.className || '—'}</td>
                        <td>{i.hosts.join(', ') || '—'}</td>
                        <td>{i.tls.length > 0 ? t('已启用') : '—'}</td>
                        <td>{i.createdAt ? new Date(i.createdAt).toLocaleString() : '—'}</td>
                        {admin ? (
                          <td>
                            <Button variant="ghost" onClick={() => setDelTarget({ kind: 'ingresses', namespace: i.namespace, name: i.name })}>
                              {t('删除')}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}

            {tab === 'helm' ? (
              filtered.helm.length === 0 ? (
                <Empty title={t('暂无 Helm Release')} />
              ) : (
                <table className="k8s__table">
                  <thead>
                    <tr>
                      <th>{t('名称')}</th>
                      <th>{t('命名空间')}</th>
                      <th>Chart</th>
                      <th>Revision</th>
                      <th>{t('状态')}</th>
                      <th>{t('最近发布')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.helm.map((h) => (
                      <tr
                        key={`${h.namespace}/${h.name}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => void openHelmHistory(h.namespace, h.name)}
                      >
                        <td className="k8s__mono">{h.name}</td>
                        <td>{h.namespace}</td>
                        <td className="k8s__mono">{h.chartName ? (h.chartVersion ? `${h.chartName}-${h.chartVersion}` : h.chartName) : '—'}</td>
                        <td>v{h.revision}</td>
                        <td>
                          <span className={h.status === 'deployed' ? 'k8s__badge k8s__badge--ok' : 'k8s__badge k8s__badge--warn'}>
                            {h.status || '—'}
                          </span>
                        </td>
                        <td>{(() => { const ts = h.lastDeployedAt ?? h.updatedAt; return ts ? new Date(ts).toLocaleString() : '—'; })()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}
          </div>
        )}
      </Card>

      <Modal open={!!scaleTarget} title={`${t('扩缩容')} · ${scaleTarget?.name || ''}`} onClose={() => setScaleTarget(null)} width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, opacity: 0.7 }}>
            {t('调整副本数（0-500）：')}
          </div>
          <input
            className="input"
            type="number"
            min={0}
            max={500}
            value={scaleReplicas}
            onChange={(e) => setScaleReplicas(e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" onClick={() => setScaleTarget(null)}>
              {t('取消')}
            </Button>
            <Button variant="primary" onClick={() => void doScale()}>
              {t('确认')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!resizeTarget} title={`${t('扩容 PVC')} · ${resizeTarget?.name || ''}`} onClose={() => setResizeTarget(null)} width={400}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, opacity: 0.7 }}>{t('输入新容量（仅支持增大，示例：10Gi）：')}</div>
          <input
            className="input"
            value={resizeStorage}
            onChange={(e) => setResizeStorage(e.target.value)}
            placeholder="10Gi"
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" onClick={() => setResizeTarget(null)}>
              {t('取消')}
            </Button>
            <Button variant="primary" onClick={() => void doResize()}>
              {t('确认')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={editOpen}
        title={`${editKind === 'secret' ? t('编辑 Secret') : t('编辑 ConfigMap')} · ${editNs}/${editName}`}
        onClose={() => setEditOpen(false)}
        width={640}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '60vh', overflow: 'auto' }}>
          {Object.entries(editData).map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }} className="k8s__mono">
                {k}
              </div>
              <textarea
                className="input"
                style={{ width: '100%', minHeight: 80, fontFamily: 'monospace' }}
                value={v}
                onChange={(e) => setEditData((prev) => ({ ...prev, [k]: e.target.value }))}
              />
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              {t('取消')}
            </Button>
            <Button variant="primary" onClick={() => void doSaveEdit()}>
              {t('保存')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={helmHistoryOpen}
        title={`${t('Helm 历史版本')} · ${helmHistoryNs}/${helmHistoryName}`}
        onClose={() => setHelmHistoryOpen(false)}
        width={640}
      >
        {helmHistory.length === 0 ? (
          <Empty title={t('暂无历史版本')} />
        ) : (
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <table className="k8s__table">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Chart</th>
                  <th>{t('状态')}</th>
                  <th>{t('最近发布')}</th>
                </tr>
              </thead>
              <tbody>
                {helmHistory.map((v) => (
                  <tr key={v.revision}>
                    <td>v{v.revision}</td>
                    <td className="k8s__mono">{v.chartName ? (v.chartVersion ? `${v.chartName}-${v.chartVersion}` : v.chartName) : '—'}</td>
                    <td>
                      <span className={v.status === 'deployed' ? 'k8s__badge k8s__badge--ok' : 'k8s__badge k8s__badge--warn'}>
                        {v.status || '—'}
                      </span>
                    </td>
                    <td>{(v.lastDeployedAt) ? new Date(v.lastDeployedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!restartTarget}
        title={t('滚动重启')}
        message={t(`确认滚动重启 Deployment ${restartTarget?.namespace || ''}/${restartTarget?.name || ''}？将触发滚动更新并逐步替换 Pod。`)}
        confirmText={t('确认重启')}
        onConfirm={() => void doRestart()}
        onCancel={() => setRestartTarget(null)}
      />

      <ConfirmDialog
        open={!!delTarget}
        title={t('删除资源')}
        message={t(`确认删除 ${delTarget?.kind || ''} ${delTarget?.namespace || ''}/${delTarget?.name || ''}？该操作不可恢复（可能需要管理员审批）。`)}
        confirmText={t('确认删除')}
        onConfirm={() => void doDelete()}
        onCancel={() => setDelTarget(null)}
      />
    </div>
  );
}
