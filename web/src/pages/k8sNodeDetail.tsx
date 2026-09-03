/**
 * K8s 节点详情页（1.11.0）
 *
 * 展示节点基本信息与 CPU / 内存小时级聚合趋势曲线（1d/7d/30d/90d）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get } from '../api/client';
import Card from '../components/Card';
import Empty from '../components/Empty';
import Button from '../components/Button';
import { Select } from '../components/Form';
import LineChart from '../components/LineChart';
import { translateNow as t } from '../i18n';
import './k8s.less';

/** 节点详情 */
interface K8sNodeDetail {
  name: string;
  roles: string[];
  status: string;
  version: string;
  internalIP: string;
  os: string;
  architecture: string;
  unschedulable: boolean;
  cpuAllocatable: number;
  memAllocatable: number;
  podCapacity: number;
  createdAt: number | null;
}

/** 历史曲线点 */
interface HistPoint {
  bucket: number;
  cpuMillicores: number;
  memKib: number;
}

export default function K8sNodeDetail() {
  const { name = '' } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [node, setNode] = useState<K8sNodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState('7d');
  const [points, setPoints] = useState<HistPoint[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await get<{ node: K8sNodeDetail }>(`/api/k8s/nodes/${encodeURIComponent(name)}`);
      setNode(res.node);
    } catch (err) {
      setError((err as Error)?.message || t('加载失败'));
    }
  }, [name]);

  const loadHist = useCallback(async () => {
    try {
      const res = await get<{ points: HistPoint[] }>(`/api/k8s/nodes/${encodeURIComponent(name)}/metrics-history?duration=${duration}`);
      setPoints(res.points || []);
    } catch {
      setPoints([]);
    }
  }, [name, duration]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadHist();
  }, [loadHist]);

  if (error) {
    return (
      <div className="k8s">
        <Card title={name}>
          <Empty title={error} />
          <div style={{ textAlign: 'center' }}>
            <Button variant="ghost" onClick={() => navigate('/k8s')}>
              {t('返回集群概览')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="k8s">
      <div className="k8s__toolbar">
        <h2 className="k8s__title k8s__mono">{name}</h2>
        <div className="k8s__toolbar-controls">
          <Button variant="ghost" onClick={() => navigate('/k8s')}>
            {t('返回集群概览')}
          </Button>
        </div>
      </div>

      <Card title={t('基本信息')}>
        <dl className="k8s__kv">
          <dt>{t('角色')}</dt>
          <dd>{node?.roles?.join(', ') || '—'}</dd>
          <dt>{t('状态')}</dt>
          <dd>
            <span className={node?.status === 'Ready' ? 'k8s__badge k8s__badge--ok' : 'k8s__badge k8s__badge--bad'}>{node?.status}</span>
            {node?.unschedulable ? <span className="k8s__badge k8s__badge--warn">{t('不可调度')}</span> : null}
          </dd>
          <dt>{t('可分配 CPU')}</dt>
          <dd>{node?.cpuAllocatable ?? '—'} {t('核')}</dd>
          <dt>{t('可分配内存')}</dt>
          <dd>{node?.memAllocatable ? `${(node.memAllocatable / 1024 ** 3).toFixed(1)} GiB` : '—'}</dd>
          <dt>{t('Pod 容量')}</dt>
          <dd>{node?.podCapacity ?? '—'}</dd>
          <dt>OS</dt>
          <dd>{node?.os || '—'}</dd>
          <dt>{t('架构')}</dt>
          <dd>{node?.architecture || '—'}</dd>
          <dt>{t('kubelet 版本')}</dt>
          <dd>{node?.version || '—'}</dd>
          <dt>IP</dt>
          <dd className="k8s__mono">{node?.internalIP || '—'}</dd>
          <dt>{t('创建时间')}</dt>
          <dd>{node?.createdAt ? new Date(node.createdAt).toLocaleString() : '—'}</dd>
        </dl>
      </Card>

      <Card
        title={t('资源趋势')}
        extra={
          <Select className="k8s__select" value={duration} onChange={(e) => setDuration(e.target.value)}>
            <option value="1d">1d</option>
            <option value="7d">7d</option>
            <option value="30d">30d</option>
            <option value="90d">90d</option>
          </Select>
        }
      >
        {points.length === 0 ? (
          <Empty title={t('暂无历史数据：采样器运行约 1 小时后可用')} />
        ) : (
          <LineChart
            series={[
              { name: t('CPU 总量'), color: '#6366f1', data: points.map((p) => p.cpuMillicores) },
              { name: t('内存总量'), color: '#2e9e5b', data: points.map((p) => Math.round(p.memKib / 1024)) },
            ]}
            labels={points.map((p) => new Date(p.bucket).toLocaleString())}
            height={200}
            unit="m"
          />
        )}
      </Card>
    </div>
  );
}
