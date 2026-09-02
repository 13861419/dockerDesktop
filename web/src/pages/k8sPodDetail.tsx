/**
 * Kubernetes Pod 详情页（1.5.0 一期：只读）
 *
 * 展示 Pod 元信息、容器列表、日志（tail）与 CPU / 内存实时采样曲线。
 * 曲线数据来自页面停留期间每 15s 轮询 metrics-server 快照（不做后端存储）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Empty from '../components/Empty';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import { Select } from '../components/Form';
import LineChart from '../components/LineChart';
import { translateNow as t } from '../i18n';
import './k8s.less';

/** Pod 视图（详情） */
interface K8sPodDetail {
  name: string;
  namespace: string;
  phase: string;
  detailStatus: string;
  ready: string;
  restarts: number;
  node: string;
  createdAt: number | null;
  containers: Array<{ name: string; image: string; ready: boolean; restarts: number }>;
}

/** 指标快照容器项 */
interface MetricContainer {
  name: string;
  cpuCores: number;
  memBytes: number;
}

/** 曲线采样点 */
interface SamplePoint {
  time: number;
  cpu: number;
  mem: number;
}

/** 事件视图 */
interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  object: string;
  count: number;
  lastAt: number | null;
}

/** 字节格式化 */
function fmtBytes(b: number): string {
  if (!b) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function K8sPodDetail() {
  const { ns = '', name = '' } = useParams<{ ns: string; name: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const admin = isAdmin();
  const [pod, setPod] = useState<K8sPodDetail | null>(null);
  const [logs, setLogs] = useState('');
  const [container, setContainer] = useState('');
  const [events, setEvents] = useState<K8sEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /** 停留采样曲线（内存态，最多 120 点） */
  const [cpuSeries, setCpuSeries] = useState<Array<{ bucket: number; value: number }>>([]);
  const [memSeries, setMemSeries] = useState<Array<{ bucket: number; value: number }>>([]);
  const [metricsAvailable, setMetricsAvailable] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 加载 Pod 详情 */
  const loadPod = useCallback(async () => {
    try {
      const res = await get<{ pod: K8sPodDetail }>(`/api/k8s/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`);
      setPod(res.pod);
      if (res.pod.containers.length > 0) {
        setContainer((c) => c || res.pod.containers[0].name);
      }
    } catch (err) {
      setError((err as Error)?.message || t('加载失败'));
    }
  }, [ns, name]);

  /** 加载日志 */
  const loadLogs = useCallback(async (c: string) => {
    if (!ns || !name) return;
    setLogsLoading(true);
    try {
      const q = c ? `&container=${encodeURIComponent(c)}` : '';
      const res = await get<{ logs: string }>(
        `/api/k8s/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/logs?tailLines=500${q ? `&container=${encodeURIComponent(c)}` : ''}`,
      );
      setLogs(res.logs || '');
    } catch (err) {
      setLogs(`${t('日志加载失败')}: ${(err as Error)?.message || ''}`);
    } finally {
      setLogsLoading(false);
    }
  }, [ns, name]);

  /** 加载该 Pod 相关事件 + 指标采样 */
  const loadSide = useCallback(async () => {
    try {
      const ev = await get<{ events: K8sEvent[] }>(`/api/k8s/events?namespace=${encodeURIComponent(ns)}`);
      setEvents((ev.events || []).filter((e) => e.object === name).slice(0, 20));
    } catch {
      /* 事件加载失败不阻塞主流程 */
    }
    try {
      const res = await get<{ available: boolean; containers: MetricContainer[] }>(
        `/api/k8s/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/metrics`,
      );
      const sum = (res.containers || []).reduce((acc, c) => ({ cpu: acc.cpu + c.cpuCores, mem: acc.mem + c.memBytes }), { cpu: 0, mem: 0 });
      const now = Date.now();
      // CPU 聚合为毫核 (m)，内存聚合为 KiB，与曲线 unit 一致
      setCpuSeries((s) => [...s.slice(-119), { bucket: now, value: Math.round(sum.cpu * 1000) }]);
      setMemSeries((s) => [...s.slice(-119), { bucket: now, value: Math.round(sum.mem / 1024) }]);
      setMetricsAvailable(true);
    } catch {
      setMetricsAvailable(false);
    }
  }, [ns, name]);

  useEffect(() => {
    void loadPod();
  }, [loadPod]);

  useEffect(() => {
    if (!container) return;
    setLogsLoading(true);
    void loadLogs(container);
  }, [container, loadLogs]);

  // 指标采样：进入页面立即采一次，之后每 15s
  useEffect(() => {
    void loadSide();
    timerRef.current = setInterval(() => {
      void loadSide();
    }, 15000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loadSide]);

  if (error) {
    return (
      <div className="k8s">
        <Card title={name}>
          <Empty title={error} />
          <div style={{ textAlign: 'center' }}>
            <Button variant="ghost" onClick={() => navigate('/k8s/workloads')}>
              {t('返回工作负载')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!pod) return <div className="k8s__loading">{t('加载中…')}</div>;

  /** 删除 Pod（后端可能转 202 审批） */
  const doDelete = async () => {
    try {
      const body = await del<{ approvalPending?: boolean; message?: string; ticketNo?: string }>(
        `/api/k8s/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`,
      );
      setConfirmDelete(false);
      if (body?.approvalPending) {
        showToast(`${t('已转审批：等待管理员批准')} (${body.ticketNo || ''})`, 'info');
      } else {
        showToast(body?.message || t('Pod 已删除'), 'success');
        navigate('/k8s/workloads');
      }
    } catch (err) {
      showToast(`${t('操作失败')}: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="k8s">
      <div className="k8s__toolbar">
        <h2 className="k8s__title k8s__mono">{name}</h2>
        <div className="k8s__toolbar-controls">
          <Button variant="ghost" onClick={() => navigate('/k8s/workloads')}>
            {t('返回工作负载')}
          </Button>
          {admin ? (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t('删除 Pod')}
            </Button>
          ) : null}
        </div>
      </div>

      <Card title={t('基本信息')}>
        <dl className="k8s__kv">
          <dt>{t('命名空间')}</dt>
          <dd>{pod.namespace}</dd>
          <dt>{t('状态')}</dt>
          <dd>
            <span className={pod.detailStatus === 'Running' ? 'k8s__badge k8s__badge--ok' : pod.detailStatus === 'Pending' ? 'k8s__badge k8s__badge--warn' : 'k8s__badge k8s__badge--bad'}>
              {pod.detailStatus}
            </span>
          </dd>
          <dt>{t('就绪')}</dt>
          <dd>{pod.ready}</dd>
          <dt>{t('重启')}</dt>
          <dd>{pod.restarts}</dd>
          <dt>{t('节点')}</dt>
          <dd className="k8s__mono">{pod.node || '—'}</dd>
          <dt>{t('创建时间')}</dt>
          <dd>{pod.createdAt ? new Date(pod.createdAt).toLocaleString() : '—'}</dd>
        </dl>
      </Card>

      <Card title={t('容器')}>
        {pod.containers.length === 0 ? (
          <Empty title={t('暂无容器')} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pod.containers.map((c) => (
              <div key={c.name} className="k8s__container">
                <span className={c.ready ? 'k8s__badge k8s__badge--ok' : 'k8s__badge k8s__badge--bad'}>
                  {c.ready ? 'Ready' : 'NotReady'}
                </span>
                <span className="k8s__mono">{c.name}</span>
                <span style={{ opacity: 0.6, fontSize: 12.5 }}>{c.image}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12.5 }}>
                  {t('重启')} {c.restarts}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={t('资源占用（停留期间实时采样）')}>
        {!metricsAvailable ? (
          <Empty title={t('未检测到 metrics-server，资源曲线不可用')} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12.5, opacity: 0.65, marginBottom: 4 }}>CPU (m)</div>
              <LineChart
                series={[{ name: 'CPU', color: '#1677ff', data: cpuSeries.map((p) => p.value) }]}
                labels={cpuSeries.map((p) => new Date(p.bucket).toLocaleTimeString())}
                height={140}
                unit="m"
              />
            </div>
            <div>
              <div style={{ fontSize: 12.5, opacity: 0.65, marginBottom: 4 }}>{t('内存')}</div>
              <LineChart
                series={[{ name: t('内存'), color: '#2e9e5b', data: memSeries.map((p) => p.value) }]}
                labels={memSeries.map((p) => new Date(p.bucket).toLocaleTimeString())}
                height={140}
                unit="KiB"
              />
            </div>
          </div>
        )}
      </Card>

      <Card
        title={t('日志')}
        extra={
          <div className="k8s__toolbar-controls">
            {pod.containers.length > 1 ? (
              <Select className="k8s__select" value={container} onChange={(e) => setContainer(e.target.value)}>
                {pod.containers.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button variant="ghost" onClick={() => void loadLogs(container)}>
              {t('刷新日志')}
            </Button>
          </div>
        }
      >
        {logsLoading ? <div className="k8s__loading">{t('加载中…')}</div> : <pre className="k8s__logs">{logs || t('暂无日志')}</pre>}
      </Card>

      <Card title={t('相关事件')}>
        {events.length === 0 ? (
          <Empty title={t('暂无事件')} />
        ) : (
          <div className="k8s__table-wrap">
            <table className="k8s__table">
              <thead>
                <tr>
                  <th>{t('级别')}</th>
                  <th>{t('原因')}</th>
                  <th>{t('消息')}</th>
                  <th>{t('次数')}</th>
                  <th>{t('最近时间')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td>
                      <span className={e.type === 'Warning' ? 'k8s__badge k8s__badge--warn' : 'k8s__badge k8s__badge--ok'}>
                        {e.type}
                      </span>
                    </td>
                    <td>{e.reason}</td>
                    <td style={{ whiteSpace: 'normal' }}>{e.message}</td>
                    <td>{e.count ?? '—'}</td>
                    <td>{e.lastAt ? new Date(e.lastAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        title={t('删除 Pod')}
        message={t('确认删除该 Pod？受 Deployment 管理的 Pod 会被自动重建；独立 Pod 将被直接移除。')}
        confirmText={t('确认删除')}
        danger
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
