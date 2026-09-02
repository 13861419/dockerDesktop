/**
 * Kubernetes 工作负载页（1.5.0 一期：只读）
 *
 * 标签页：Pod / Deployment / Service / PVC，支持命名空间过滤与关键字搜索。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../api/client';
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

type TabKey = 'pods' | 'deployments' | 'services' | 'pvc';

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
  const [services, setServices] = useState<K8sService[]>([]);
  const [pvcs, setPvcs] = useState<K8sPvc[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [scaleTarget, setScaleTarget] = useState<K8sDeployment | null>(null);
  const [scaleReplicas, setScaleReplicas] = useState('3');
  const [restartTarget, setRestartTarget] = useState<K8sDeployment | null>(null);

  const load = useCallback(async (nsArg: string) => {
    setLoading(true);
    try {
      const q = nsArg && nsArg !== 'all' ? `?namespace=${encodeURIComponent(nsArg)}` : '';
      const [podRes, depRes, svcRes, pvcRes, nsRes] = await Promise.all([
        get<{ pods: K8sPod[] }>(`/api/k8s/pods${q}`),
        get<{ deployments: K8sDeployment[] }>(`/api/k8s/deployments${q}`),
        get<{ services: K8sService[] }>(`/api/k8s/services${q}`),
        get<{ pvcs: K8sPvc[] }>(`/api/k8s/pvc${q}`),
        get<{ namespaces: string[] }>(`/api/k8s/namespaces`),
      ]);
      setPods(podRes.pods || []);
      setDeployments(depRes.deployments || []);
      setServices(svcRes.services || []);
      setPvcs(pvcRes.pvcs || []);
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

  /** 关键字过滤 */
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return { pods, deployments, services, pvcs };
    return {
      pods: pods.filter((p) => `${p.namespace}/${p.name}`.toLowerCase().includes(kw)),
      deployments: deployments.filter((d) => `${d.namespace}/${d.name}`.toLowerCase().includes(kw)),
      services: services.filter((s) => `${s.namespace}/${s.name}`.toLowerCase().includes(kw)),
      pvcs: pvcs.filter((v) => `${v.namespace}/${v.name}`.toLowerCase().includes(kw)),
    };
  }, [search, pods, deployments, services, pvcs]);

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
              ['services', `Service (${filtered.services.length})`],
              ['pvc', `PVC (${filtered.pvcs.length})`],
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
                            </span>
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

      <ConfirmDialog
        open={!!restartTarget}
        title={t('滚动重启')}
        message={t(`确认滚动重启 Deployment ${restartTarget?.namespace || ''}/${restartTarget?.name || ''}？将触发滚动更新并逐步替换 Pod。`)}
        confirmText={t('确认重启')}
        onConfirm={() => void doRestart()}
        onCancel={() => setRestartTarget(null)}
      />
    </div>
  );
}
