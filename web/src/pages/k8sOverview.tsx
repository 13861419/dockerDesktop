/**
 * Kubernetes 集群概览页（1.5.0 一期：只读巡检）
 *
 * 展示当前 context / namespace 下的节点列表与资源计数。
 * 集群不可用（无 kubeconfig 且非 InCluster）时展示配置引导。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../api/client';
import Card from '../components/Card';
import Empty from '../components/Empty';
import Button from '../components/Button';
import { Select } from '../components/Form';
import LineChart from '../components/LineChart';
import { translateNow as t } from '../i18n';
import './k8s.less';

/** K8s 状态响应 */
interface K8sStatus {
  available: boolean;
  contexts: Array<{ name: string; cluster: string; current: boolean }>;
  context: string;
  reason: string | null;
}

/** 节点信息（overview 返回） */
interface K8sNode {
  name: string;
  roles: string[];
  status: string;
  version: string;
  internalIP: string;
  cpuPercent: number | null;
  memPercent: number | null;
}

/** 概览响应 */
interface K8sOverview {
  context: string;
  metricsAvailable: boolean;
  counts: { nodes: number; pods: number; services: number; pvc: number };
  nodes: K8sNode[];
}

/** 资源占用条 */
function UsageBar({ percent }: { percent: number | null }) {
  if (percent === null || percent === undefined) return <span className="k8s__na">—</span>;
  const cls = percent >= 80 ? 'bar--high' : percent >= 50 ? 'bar--mid' : 'bar--low';
  return (
    <span className="k8s__bar" title={`${percent}%`}>
      <span className={`k8s__bar-fill ${cls}`} style={{ width: `${Math.min(100, percent)}%` }} />
      <span className="k8s__bar-text">{percent}%</span>
    </span>
  );
}

export default function K8sOverview() {
  const [status, setStatus] = useState<K8sStatus | null>(null);
  const [overview, setOverview] = useState<K8sOverview | null>(null);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [ns, setNs] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [histDuration, setHistDuration] = useState('7d');
  const [histPoints, setHistPoints] = useState<Array<{ bucket: number; cpuMillicores: number; memKib: number }>>([]);
  const [histAvailable, setHistAvailable] = useState(true);

  /** 加载 status + 概览 */
  const load = useCallback(async (nsArg: string, histDur: string) => {
    setLoading(true);
    try {
      const st = await get<K8sStatus>('/api/k8s/status');
      setStatus(st);
      if (st.available) {
        const [ov, nss, hist] = await Promise.all([
          get<K8sOverview>(`/api/k8s/overview`),
          get<{ namespaces: string[] }>(`/api/k8s/namespaces`),
          get<{ points: Array<{ bucket: number; cpuMillicores: number; memKib: number }> }>(`/api/k8s/metrics-history?duration=${histDur}`).catch(() => null),
        ]);
        setOverview(ov);
        setNamespaces(nss.namespaces || []);
        setHistPoints(hist?.points || []);
        setHistAvailable(!!hist);
      }
    } catch {
      setStatus((s) => s ?? { available: false, contexts: [], context: '', reason: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(ns, histDuration);
  }, [load, ns, histDuration]);

  /** 切换 context */
  const switchContext = async (name: string) => {
    try {
      await post('/api/k8s/context', { context: name });
      await load(ns, histDuration);
    } catch {
      /* toast 由全局错误处理 */
    }
  };

  if (loading && !status) return <div className="k8s__loading">{t('加载中…')}</div>;

  // 集群不可用：引导配置 kubeconfig
  if (status && !status.available) {
    return (
      <div className="k8s">
        <Card title={t('Kubernetes 集群概览')}>
          <Empty title={t('Kubernetes 不可用：未检测到 kubeconfig')} />
          <div className="k8s__guide">
            <p>{t('启用方式（三选一）：')}</p>
            <ol>
              <li>{t('将 kubeconfig 放置在面板运行用户的 ~/.kube/config')}</li>
              <li>{t('设置环境变量 KUBECONFIG 指向 kubeconfig 文件后重启面板')}</li>
              <li>{t('面板以 Pod 方式部署时自动使用 InCluster 配置')}</li>
            </ol>
            {status.reason ? <p className="k8s__reason">{status.reason}</p> : null}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="k8s">
      <div className="k8s__toolbar">
        <h2 className="k8s__title">{t('Kubernetes 集群概览')}</h2>
        <div className="k8s__toolbar-controls">
          {status && status.contexts.length > 1 ? (
            <Select
              className="k8s__select"
              value={status.context}
              onChange={(e) => void switchContext(e.target.value)}
              aria-label={t('切换集群')}
            >
              {status.contexts.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Select className="k8s__select" value={ns} onChange={(e) => setNs(e.target.value)} aria-label={t('切换命名空间')}>
            <option value="all">{t('全部命名空间')}</option>
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Button variant="ghost" onClick={() => void load(ns, histDuration)}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      {overview ? (
        <>
          <div className="k8s__cards">
            <Card>
              <div className="k8s__stat">
                <span className="k8s__stat-num">{overview.counts.nodes}</span>
                <span className="k8s__stat-label">{t('节点')}</span>
              </div>
            </Card>
            <Card>
              <div className="k8s__stat">
                <span className="k8s__stat-num">{overview.counts.pods}</span>
                <span className="k8s__stat-label">{t('Pod')}</span>
              </div>
            </Card>
            <Card>
              <div className="k8s__stat">
                <span className="k8s__stat-num">{overview.counts.services}</span>
                <span className="k8s__stat-label">{t('Service')}</span>
              </div>
            </Card>
          <Card>
            <div className="k8s__stat">
              <span className="k8s__stat-num">{overview.counts.pvc}</span>
              <span className="k8s__stat-label">{t('存储卷 (PVC)')}</span>
            </div>
          </Card>
        </div>

        <Card
          title={t('节点资源趋势')}
          extra={
            <Select className="k8s__select" value={histDuration} onChange={(e) => setHistDuration(e.target.value)}>
              <option value="1d">1d</option>
              <option value="7d">7d</option>
              <option value="30d">30d</option>
              <option value="90d">90d</option>
            </Select>
          }
        >
          {histAvailable && histPoints.length > 0 ? (
            <LineChart
              series={[
                { name: t('CPU 总量'), color: '#6366f1', data: histPoints.map((p) => p.cpuMillicores) },
                { name: t('内存总量'), color: '#2e9e5b', data: histPoints.map((p) => Math.round(p.memKib / 1024)) },
              ]}
              labels={histPoints.map((p) => new Date(p.bucket).toLocaleString())}
              height={180}
              unit="m"
            />
          ) : (
            <Empty title={t('暂无历史数据：采样器运行约 1 小时后可用')} />
          )}
        </Card>

          <Card title={t('节点')}>
            {overview.nodes.length === 0 ? (
              <Empty title={t('暂无节点')} />
            ) : (
              <div className="k8s__table-wrap">
                <table className="k8s__table">
                  <thead>
                    <tr>
                      <th>{t('名称')}</th>
                      <th>{t('角色')}</th>
                      <th>{t('状态')}</th>
                      <th>{t('CPU')}</th>
                      <th>{t('内存')}</th>
                      <th>{t('版本')}</th>
                      <th>IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.nodes.map((n) => (
                      <tr key={n.name}>
                        <td className="k8s__mono">{n.name}</td>
                        <td>{n.roles.join(', ') || '—'}</td>
                        <td>
                          <span className={`k8s__badge ${n.status === 'Ready' ? 'k8s__badge--ok' : 'k8s__badge--bad'}`}>
                            {n.status}
                          </span>
                        </td>
                        <td>
                          <UsageBar percent={n.cpuPercent} />
                        </td>
                        <td>
                          <UsageBar percent={n.memPercent} />
                        </td>
                        <td>{n.version || '—'}</td>
                        <td className="k8s__mono">{n.internalIP || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!overview.metricsAvailable ? (
              <p className="k8s__hint">{t('未检测到 metrics-server，资源占用列不可用')}</p>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
