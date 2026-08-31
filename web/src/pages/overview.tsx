/**
 * 总览页
 *
 * 挂载时拉取 /api/overview 引擎信息，以清爽卡片（indigo 色系）展示
 * 容器 / 镜像 / 数据卷 / 网络数量及引擎基础信息。
 *
 * 顶部新增「资源监控」区域：
 * - 挂载后立即拉取 /api/monitor/now 显示当前 CPU / 内存 / 磁盘使用率；
 * - 每 2 秒轮询 /api/monitor/history 累积最近 10 分钟数据点，
 *   以折线图实时展示 CPU / 内存 / 磁盘曲线。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, download } from '../api/client';
import { Overview } from '../types';
import Card from '../components/Card';
import StatusBadge from '../components/StatusBadge';
import LineChart from '../components/LineChart';
import { PageLoading } from '../components/Loading';
import { useToast } from '../components/Toast';
import { useLang } from '../i18n';
import './overview.less';

/** 单个监控采样点的数据结构，与后端 /api/monitor/* 返回保持一致 */
interface DiskPartition {
  mount: string;
  total: number;
  used: number;
  free: number;
  percent: number;
}

interface MonitorPoint {
  timestamp: number;
  cpu: { percent: number; cores: number };
  mem: { percent: number; used: number; total: number };
  disk: { percent: number; used: number; total: number };
  disks: DiskPartition[];
  gpu: Array<{ index: number; name: string; utilization: number; memUsed: number; memTotal: number; temperature: number }>;
  net: { rx: number; tx: number };
  containers: { running: number; total: number };
  images: number;
  alerts: Array<{ type: string; level: 'warn' | 'danger'; message: string }>;
}

/** /api/monitor/history 返回的历史数据接口 */
interface MonitorHistory {
  points: MonitorPoint[];
}

/** 历史趋势时间范围（与后端 MetricsRange 一致） */
type MetricsRange = '10m' | '1h' | '24h' | '7d';

/** /api/monitor/history/range 返回的精简监控点（剔除 disks/gpu/alerts 等嵌套结构） */
interface MetricPoint {
  timestamp: number;
  cpu: { percent: number; cores: number };
  mem: { percent: number; used: number; total: number };
  disk: { percent: number; used: number; total: number };
  net: { rx: number; tx: number };
  containers: { running: number; total: number };
  images: number;
}

/** /api/monitor/history/range 返回结构 */
interface MetricRangeResponse {
  points: MetricPoint[];
}

/** 容器资源占用看板单项（GET /api/containers/stats/top 返回） */
interface TopContainerStat {
  id: string;
  name: string;
  image: string;
  state: string;
  cpuPercent: number;
  memPercent: number;
  memUsageMB: number;
  memLimitMB: number;
  netRxMB: number;
  netTxMB: number;
  pids: number;
}

/** /api/containers/stats/top 返回结构 */
interface TopStatsResponse {
  items: TopContainerStat[];
  sortBy: string;
}

/** 曲线渲染所需的最小数据结构（MonitorPoint 与 MetricPoint 均结构兼容） */
interface ChartPoint {
  timestamp: number;
  cpu: { percent: number };
  mem: { percent: number };
  disk: { percent: number };
}

/** 曲线所需的序列数据 */
interface SeriesData {
  name: string;
  color: string;
  data: number[];
}

/** 前端本地曲线保留的最大点数（2 秒一点，300 点约 10 分钟，与服务端 minutes=10 一致） */
const MAX_POINTS = 300;

/** 时间范围切换选项（按钮组，默认 10 分钟即实时轮询模式） */
const RANGE_OPTIONS: Array<{ value: MetricsRange; label: string }> = [
  { value: '10m', label: '10分钟' },
  { value: '1h', label: '1小时' },
  { value: '24h', label: '24小时' },
  { value: '7d', label: '7天' },
];

/**
 * 字节数格式化为 GB 字符串
 * @param bytes 字节数
 */
function formatGB(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb.toFixed(1)} GB`;
}

/**
 * 百分比数值格式化
 * @param value 百分比数值
 */
function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * 格式化 X 轴时间标签
 *
 * 10 分钟跨度用 HH:MM:SS（秒级，便于观察实时变化）；
 * 1 小时及以上跨度用 MM-DD HH:mm（日期+时分，避免长跨度下秒级标签拥挤）。
 * @param ts 时间戳（毫秒）
 * @param range 当前时间范围
 */
function formatTimeLabel(ts: number, range: MetricsRange): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (range === '10m') {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 总览页组件
 */
export default function OverviewPage() {
  const { t } = useLang();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 首启引导"快速开始"是否已被用户关闭（本地记忆，跨会话不重复打扰）
  const [qsDismissed, setQsDismissed] = useState<boolean>(
    () => localStorage.getItem('quickstart_dismissed') === '1',
  );

  // ---- 资源监控状态 ----
  const [now, setNow] = useState<MonitorPoint | null>(null);
  const pointsRef = useRef<MonitorPoint[]>([]);
  const [hist, setHist] = useState<MonitorPoint[]>([]);

  // ---- 历史趋势状态 ----
  /** 当前选中的时间范围，默认 10 分钟（实时轮询模式） */
  const [range, setRange] = useState<MetricsRange>('10m');
  /** 长跨度（1h/24h/7d）历史趋势数据；10m 模式下不使用 */
  const [rangeHist, setRangeHist] = useState<MetricPoint[]>([]);

  // ---- 容器资源占用看板状态 ----
  const [topStats, setTopStats] = useState<TopContainerStat[]>([]);
  const [topSort, setTopSort] = useState<'cpu' | 'mem'>('cpu');
  /** 容器看板是否加载中（首次） */
  const [topLoading, setTopLoading] = useState(true);

  /**
   * 拉取总览数据
   */
  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await get<Overview>('/api/overview');
      setData(res);
    } catch (e: any) {
      const msg = e?.message || t('加载失败');
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }

  /**
   * 拉取单点实时监控数据并更新当前数值
   *
   * 同时将最新采样点追加到本地曲线数组（按 timestamp 去重并截断），
   * 这样后续轮询无需再全量重拉 history。
   */
  async function loadNow() {
    try {
      const res = await get<MonitorPoint>('/api/monitor/now');
      setNow(res);
      // 追加最新点：按 timestamp 去重（同一个采样点不重复追加）
      const list = pointsRef.current;
      const last = list[list.length - 1];
      if (!last || res.timestamp > last.timestamp) {
        pointsRef.current = [...list, res].slice(-MAX_POINTS);
        setHist(pointsRef.current);
      }
    } catch {
      // 实时监控失败静默处理，避免频繁弹窗
    }
  }

  /**
   * 拉取历史监控数据；仅在首次加载时整体替换本地曲线。
   * 后续轮询仅依赖 loadNow 追加新点，避免每 2 秒全量重拉 history。
   * @param replace 是否以服务端数据整体替换（首次加载）
   */
  async function loadHistory(replace = true) {
    try {
      const res = await get<MonitorHistory>('/api/monitor/history', { minutes: 10 });
      const incoming = Array.isArray(res?.points) ? res.points : [];
      if (replace) {
        pointsRef.current = incoming.slice(-MAX_POINTS);
        setHist(pointsRef.current);
      }
    } catch {
      // 历史监控失败静默处理
    }
  }

  /**
   * 拉取长跨度历史趋势数据（1h/24h/7d）
   *
   * 仅在切换到非 10m 范围时调用；拉取后停止实时追加，曲线以历史数据渲染。
   * @param r 时间范围
   */
  async function loadRange(r: MetricsRange) {
    try {
      const res = await get<MetricRangeResponse>('/api/monitor/history/range', { range: r });
      setRangeHist(Array.isArray(res?.points) ? res.points : []);
    } catch {
      // 历史趋势拉取失败静默处理，保留空曲线
      setRangeHist([]);
    }
  }

  // 总览数据仅在挂载时拉取一次
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监控数据随时间范围切换：
  // - 10m：恢复实时轮询（拉取当前点 + 首次整体历史，随后每 2 秒追加新点）
  // - 1h/24h/7d：拉取一次历史趋势，停止实时追加
  useEffect(() => {
    if (range === '10m') {
      loadNow();
      loadHistory(true);
      // 每 2 秒轮询一次，仅刷新当前值并把最新点追加到本地曲线（避免每次全量重拉 history）
      const timer = setInterval(() => {
        loadNow();
      }, 2000);
      // 切换或卸载时清理定时器
      return () => clearInterval(timer);
    }
    // 长跨度模式：拉取历史趋势，不启动轮询
    loadRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // 容器资源占用看板：每 3 秒轮询 Top 统计（随排序 Tab 变化）
  useEffect(() => {
    let cancelled = false;
    async function loadTop() {
      try {
        const res = await get<TopStatsResponse>('/api/containers/stats/top', { sort: topSort, limit: 10 });
        if (cancelled) return;
        setTopStats(res?.items || []);
        setTopLoading(false);
      } catch {
        if (!cancelled) {
          setTopStats([]);
          setTopLoading(false);
        }
      }
    }
    loadTop();
    const timer = setInterval(loadTop, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [topSort]);

  if (loading) return <PageLoading />;

  if (error) {
    return (
      <div className="overview-page">
        <Card>
          <div className="overview__error">
            <p>{error}</p>
            <button className="btn btn--primary" onClick={load}>
              {t('重试')}
            </button>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) return <PageLoading />;

  const stats = [
    { label: '容器总数', value: data.containers.total, color: 'indigo' },
    { label: '运行中', value: data.containers.running, color: 'indigo' },
    { label: '已停止', value: data.containers.stopped, color: 'indigo' },
    { label: '镜像', value: data.images, color: 'indigo' },
    { label: '数据卷', value: data.volumes, color: 'indigo' },
    { label: '网络', value: data.networks, color: 'indigo' },
  ].map((s) => ({ ...s, label: t(s.label) }));

  const engine = [
    { label: '引擎名称', value: data.name },
    { label: '版本', value: data.serverVersion },
    { label: '驱动', value: data.driver },
    { label: '操作系统', value: data.os },
    { label: '架构', value: data.architecture },
    { label: '内核', value: data.kernelVersion },
    { label: 'CPU', value: t('{{n}} 核', { n: data.nCPU }) },
    { label: '内存', value: formatGB(data.memTotal) },
    { label: '数据目录', value: data.dockerRootDir },
  ].map((e) => ({ ...e, label: t(e.label) }));

  // ---- 监控数据换算 ----
  // 曲线数据源：10m 用本地实时缓冲，长跨度用历史趋势；两者结构兼容 ChartPoint
  const chartData: ChartPoint[] = range === '10m' ? hist : rangeHist;
  const cpuSeries: SeriesData = { name: 'CPU', color: 'var(--primary, #6366f1)', data: chartData.map((p) => p.cpu.percent) };
  const memSeries: SeriesData = { name: t('内存'), color: '#22c55e', data: chartData.map((p) => p.mem.percent) };
  const diskSeries: SeriesData = { name: t('磁盘'), color: '#f59e0b', data: chartData.map((p) => p.disk.percent) };

  // X 轴时间标签：10m 用 HH:MM:SS，长跨度用 MM-DD HH:mm
  const timeLabels = chartData.map((p) => formatTimeLabel(p.timestamp, range));

  // 各磁盘分区明细（来自实时监控点）
  const diskPartitions = now?.disks || [];

  // NVIDIA GPU 状态（来自实时监控点，无 GPU 时为空数组）
  const gpus = now?.gpu || [];

  // 高占用告警条目（来自实时监控点，无告警时为空数组）
  const alerts = now?.alerts || [];

  const monitorCards = [
    {
      label: 'CPU',
      value: now ? formatPercent(now.cpu.percent) : '--',
      extra: now ? t('{{n}} 核', { n: now.cpu.cores }) : '',
      percent: now ? now.cpu.percent : undefined,
    },
    {
      label: '内存',
      value: now ? formatPercent(now.mem.percent) : '--',
      extra: now ? `${formatGB(now.mem.used)} / ${formatGB(now.mem.total)}` : '',
      percent: now ? now.mem.percent : undefined,
    },
    {
      label: '磁盘',
      value: now ? formatPercent(now.disk.percent) : '--',
      extra: now ? `${formatGB(now.disk.used)} / ${formatGB(now.disk.total)}` : '',
      percent: now ? now.disk.percent : undefined,
    },
    {
      label: '容器',
      value: now ? `${now.containers.running} / ${now.containers.total}` : '--',
      extra: now ? t('运行中 / 总数') : '',
    },
    {
      label: '镜像',
      value: now ? String(now.images) : '--',
      extra: t('镜像数量'),
    },
  ];

  /**
   * 根据占用率返回进度条配色：>90 红、>70 橙、其余绿
   * @param pct 占用百分比
   * @returns 样式类别
   */
  function gaugeTone(pct: number): string {
    if (pct > 90) return 'ov-monitor__fill--high';
    if (pct > 70) return 'ov-monitor__fill--warn';
    return 'ov-monitor__fill--ok';
  }

  // 首启引导：仅当环境为空（无容器且无镜像）且未被用户关闭时展示"快速开始"向导
  const showQuickStart = !qsDismissed && data && data.containers.total === 0 && data.images === 0;
  /**
   * 快速开始引导步骤：描述 + 跳转目标
   */
  const quickStartSteps = [
    { title: '① 拉取镜像', desc: '从镜像中心拉取 nginx、redis 等常用镜像', to: '/images' },
    { title: '② 从应用商店安装', desc: '一键部署常见应用，无需手动配置', to: '/appstore' },
    { title: '③ 创建容器', desc: '基于镜像创建你的第一个容器', to: '/containers' },
    { title: '④ 搭建 Compose 项目', desc: '用 Compose 编排多容器应用', to: '/compose' },
  ];

  return (
    <div className="overview-page">
      <h1 className="overview-page__title">{t('总览')}</h1>

      {showQuickStart && (
        <Card className="ov-quickstart">
          <div className="ov-quickstart__head">
            <div>
              <div className="ov-quickstart__title">{t('快速开始')}</div>
              <div className="ov-quickstart__sub">{t('环境初步就绪，带你用四步跑通首个应用')}</div>
            </div>
            <button className="ov-quickstart__dismiss" onClick={() => { setQsDismissed(true); localStorage.setItem('quickstart_dismissed', '1'); }}>
              {t('不再显示')}
            </button>
          </div>
          <div className="ov-quickstart__steps">
            {quickStartSteps.map((step) => (
              <div key={step.title} className="ov-quickstart__step">
                <div className="ov-quickstart__step-title">{t(step.title)}</div>
                <div className="ov-quickstart__step-desc">{t(step.desc)}</div>
                <button className="btn btn--primary btn--sm" onClick={() => navigate(step.to)}>
                  {t('前往')}
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="overview__stats">
        {stats.map((s) => (
          <div key={s.label} className={`overview__stat overview__stat--${s.color}`}>
            <div className="overview__stat-value">{s.value}</div>
            <div className="overview__stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {/* 高占用告警提示条 */}
      <div className="overview__monitor">
        {alerts.length > 0 ? (
          <div className="overview-alerts">
            {alerts.map((a, idx) => (
              <div key={`${a.type}-${idx}`} className={`overview-alert is-${a.level}`}>
                <span className="overview-alert__dot" />
                <span className="overview-alert__message">{a.message}</span>
                <span className="overview-alert__tag">{a.type.toUpperCase()}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="overview-alerts overview-alerts--ok">
            <span className="overview-alert__dot" />
            <span className="overview-alert__message">{t('资源占用正常')}</span>
          </div>
        )}
      </div>

      {/* 资源监控区 */}
      <div className="overview__monitor">
        <Card
          title={t('资源监控')}
          extra={
            <button
              type="button"
              onClick={() => download('/api/system/grafana-dashboard', 'dockermanager-grafana-dashboard.json')}
              style={{ padding: '4px 12px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border, #e5e7eb)', background: 'transparent', color: 'var(--text-secondary, #6b7280)', cursor: 'pointer' }}
              title={t('导出可导入 Grafana 的 Dashboard JSON（引用 /metrics 暴露的 dm_* 指标）')}
            >
              {t('导出 Grafana')}
            </button>
          }
        >
          {/* 时间范围切换：10 分钟实时轮询 / 1h·24h·7d 历史趋势 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {RANGE_OPTIONS.map((opt) => {
              const active = range === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRange(opt.value)}
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    borderRadius: 6,
                    border: '1px solid var(--border, #e5e7eb)',
                    background: active ? 'var(--primary, #6366f1)' : 'transparent',
                    color: active ? '#fff' : 'var(--text-secondary, #6b7280)',
                    cursor: 'pointer',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {t(opt.label)}
                </button>
              );
            })}
          </div>
          <div className="monitor__now">
            {monitorCards.map((m) => {
              const pct = (m as { percent?: number }).percent;
              return (
                <div key={m.label} className="monitor__now-item">
                  <div className="monitor__now-label">{t(m.label)}</div>
                  <div className="monitor__now-value">{m.value}</div>
                  {pct !== undefined && (
                    <div className="ov-monitor__bar">
                      <span className="ov-monitor__bar-fillwrap">
                        <span
                          className={`ov-monitor__bar-fill ${gaugeTone(pct)}`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </span>
                    </div>
                  )}
                  <div className="monitor__now-extra">{m.extra}</div>
                </div>
              );
            })}
          </div>
          <div className="monitor__charts">
            <div className="monitor__chart">
              <LineChart series={[cpuSeries, memSeries]} labels={timeLabels} height={180} unit="%" max={100} />
            </div>
            <div className="monitor__chart">
              <LineChart series={[diskSeries]} labels={timeLabels} height={180} unit="%" max={100} />
            </div>
          </div>

          {/* 各磁盘分区使用情况 */}
          {diskPartitions.length > 0 && (
            <div className="monitor__disks">
              <div className="monitor__disks-title">{t('磁盘分区')}</div>
              <div className="monitor__disks-grid">
                {diskPartitions.map((d) => (
                  <div className="monitor__disk" key={d.mount}>
                    <div className="monitor__disk-head">
                      <span className="monitor__disk-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="7" width="20" height="12" rx="2" />
                          <path d="M2 12h20" />
                          <circle cx="17" cy="15" r="1.2" fill="currentColor" stroke="none" />
                        </svg>
                      </span>
                      <span className="monitor__disk-mount">{d.mount}</span>
                      <span className="monitor__disk-percent">{d.percent}%</span>
                    </div>
                    <div className="monitor__disk-bar">
                      <div
                        className={`monitor__disk-bar__fill ${gaugeTone(d.percent)}`}
                        style={{ width: `${Math.min(100, d.percent)}%` }}
                      />
                    </div>
                    <div className="monitor__disk-meta">
                      <span className="monitor__disk-used">{formatGB(d.used)} / {formatGB(d.total)}</span>
                      <span className="monitor__disk-free">{t('可用 {{v}}', { v: formatGB(d.free) })}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* NVIDIA GPU 状态（nvidia-smi 可用时展示） */}
          {gpus.length > 0 && (
            <div className="monitor__disks">
              <div className="monitor__disks-title">GPU</div>
              <div className="monitor__disks-grid">
                {gpus.map((g) => (
                  <div className="monitor__disk" key={g.index}>
                    <div className="monitor__disk-head">
                      <span className="monitor__disk-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 9v6l2.5-1.5v-3z" fill="currentColor" stroke="none" />
                          <rect x="6" y="8" width="16" height="8" rx="1.4" />
                          <path d="M9 11.5h3M9 13.5h5" />
                        </svg>
                      </span>
                      <span className="monitor__disk-mount">{g.name}</span>
                      <span className="monitor__disk-percent">{g.utilization}%</span>
                    </div>
                    <div className="monitor__disk-bar">
                      <div
                        className={`monitor__disk-bar__fill ${gaugeTone(g.utilization)}`}
                        style={{ width: `${Math.min(100, g.utilization)}%` }}
                      />
                    </div>
                    <div className="monitor__disk-meta">
                      <span className="monitor__disk-used">{t('显存 {{a}} / {{b}}', { a: formatGB(g.memUsed * 1024 * 1024), b: formatGB(g.memTotal * 1024 * 1024) })}</span>
                      <span className="monitor__disk-free">{g.temperature}°C</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* 容器资源占用看板 */}
      <Card
        title={t('容器资源占用')}
        extra={
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`ov-top__tab${topSort === 'cpu' ? ' ov-top__tab--active' : ''}`}
              onClick={() => setTopSort('cpu')}
            >
              {t('按 CPU')}
            </button>
            <button
              type="button"
              className={`ov-top__tab${topSort === 'mem' ? ' ov-top__tab--active' : ''}`}
              onClick={() => setTopSort('mem')}
            >
              {t('按内存')}
            </button>
          </div>
        }
      >
        {topLoading && topStats.length === 0 ? (
          <div className="ov-top__tip">{t('加载容器资源统计中…')}</div>
        ) : topStats.length === 0 ? (
          <div className="ov-top__tip">{t('当前无运行中容器')}</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('容器')}</th>
                <th style={{ width: 90 }}>{t('状态')}</th>
                <th style={{ width: 180 }}>CPU</th>
                <th style={{ width: 180 }}>{t('内存')}</th>
                <th style={{ width: 120 }}>{t('内存使用')}</th>
                <th style={{ width: 150 }}>{t('网络 IO')}</th>
              </tr>
            </thead>
            <tbody>
              {topStats.map((c) => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/containerDetail/${c.id}`)}>
                  <td>
                    <div className="ov-top__name" title={c.name}>
                      {c.name}
                    </div>
                    <div className="ov-top__image" title={c.image}>
                      {c.image}
                    </div>
                  </td>
                  <td>
                    <span className={`ov-top__state ov-top__state--${c.state === 'running' ? 'running' : 'stopped'}`}>
                      {c.state === 'running' ? t('运行中') : t('已停止')}
                    </span>
                  </td>
                  <td>
                    <div className="ov-top__bar">
                      <div
                        className={`ov-top__bar-fill ${gaugeTone(c.cpuPercent)}`}
                        style={{ width: `${Math.min(100, c.cpuPercent)}%` }}
                      />
                    </div>
                    <span className="ov-top__num">{c.cpuPercent.toFixed(1)}%</span>
                  </td>
                  <td>
                    <div className="ov-top__bar">
                      <div
                        className={`ov-top__bar-fill ${gaugeTone(c.memPercent)}`}
                        style={{ width: `${Math.min(100, c.memPercent)}%` }}
                      />
                    </div>
                    <span className="ov-top__num">{c.memPercent.toFixed(1)}%</span>
                  </td>
                  <td className="ov-top__mem">{c.memUsageMB} / {c.memLimitMB} MB</td>
                  <td className="ov-top__net">
                    {t('收 {{rx}} MB / 发 {{tx}} MB', { rx: c.netRxMB, tx: c.netTxMB })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={t('引擎信息')}>
        <div className="overview__engine-status">
          <span className="overview__engine-dot" />
          {t('Docker 引擎运行中')}
        </div>
        <div className="overview__engine">
          {engine.map((e) => (
            <div key={e.label} className="overview__engine-item">
              <div className="overview__engine-label">{e.label}</div>
              <div className="overview__engine-value">{e.value}</div>
            </div>
          ))}
        </div>
        <div className="overview__swarm">
          <StatusBadge status={data.swarm} />
        </div>
      </Card>
    </div>
  );
}
