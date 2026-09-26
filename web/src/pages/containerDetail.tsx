/**
 * 容器详情页
 *
 * 通过路由参数 id 展示指定容器的完整详情，并提供三个视图：
 *  - 详情：完整元数据（基本信息 / 挂载卷 / 网络 / 环境变量 / 端口 / 健康检查）
 *  - 日志：实时日志（SSE 流，可连接/断开/清空/自动滚动）
 *  - 终端：容器内 Web 终端（需容器内置 shell）
 *  - 资源监控：CPU / 内存 / 网络实时统计与曲线
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { get, del, post, download } from '../api/client';
import { isAdmin } from '../api/auth';
import { ContainerDetailInfo, ContainerStats } from '../types';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import EnvEditModal from '../components/EnvEditModal';
import MountEditModal from '../components/MountEditModal';
import NetEditModal from '../components/NetEditModal';
import PortEditModal from '../components/PortEditModal';
import ConfigRunModal from '../components/ConfigRunModal';
import HistoryLogModal from '../components/HistoryLogModal';
import CloneModal from '../components/CloneModal';
import SaveTemplateModal from '../components/SaveTemplateModal';
import CommitImageModal from '../components/CommitImageModal';
import ExecCommandModal from '../components/ExecCommandModal';
import UpdateConfigModal from '../components/UpdateConfigModal';
import HealthCheckModal from '../components/HealthCheckModal';
import { Field, Input, Select } from '../components/Form';
import StatusBadge from '../components/StatusBadge';
import Empty from '../components/Empty';
import ConfirmDialog from '../components/ConfirmDialog';
import { PageLoading } from '../components/Loading';
import LineChart from '../components/LineChart';
import ContainerTerminal from '../components/ContainerTerminal';
import FileExplorer from '../components/FileExplorer';
import { useContainerLogs } from '../hooks/useContainerLogs';
import { detectLogLevel } from '../utils/logLevel';
import LogLevelFilter, { LogLevelFilterValue } from '../components/LogLevelFilter';
import { useToast } from '../components/Toast';
import { ContainerPortConflicts, ContainerListItem } from '../types';
import { useLang, translateNow } from '../i18n';
import './containerDetail.less';

/** Tab 类型 */
type TabKey = 'detail' | 'logs' | 'terminal' | 'stats' | 'files' | 'inspect';

/** Tab 配置 */
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'detail', label: '详情' },
  { key: 'logs', label: '日志' },
  { key: 'terminal', label: '终端' },
  { key: 'stats', label: '资源监控' },
  { key: 'files', label: '文件' },
  { key: 'inspect', label: '检查' },
];

/** 镜像自动更新条目 */
interface AutoUpdItem {
  id: number;
  container_id: string;
  container_name: string;
  image_ref: string;
  last_check_at: number | null;
  last_status: string | null;
  last_result: string | null;
  enabled: number;
}

/**
 * 将字节数格式化为人类可读大小
 * @param bytes 字节数
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 将 ISO 时间字符串格式化为本地时间；空值返回 '-'
 * @param str 原始时间字符串
 */
function formatTime(str: string): string {
  if (!str) return '-';
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 根据启动时间计算并格式化已运行时长；空值返回 '-'
 * 规则：不足 1 小时显示 "X分"；不足 1 天显示 "X小时X分"；否则显示 "X天X小时X分"
 * @param startedAt 启动时间（ISO 字符串）
 * @returns 格式化后的运行时长，如 "2天3小时5分"
 */
function formatDuration(startedAt: string): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  if (isNaN(start)) return '-';
  const totalSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return translateNow('{{days}}天{{hours}}小时{{minutes}}分', { days, hours, minutes });
  if (hours > 0) return translateNow('{{hours}}小时{{minutes}}分', { hours, minutes });
  return translateNow('{{minutes}}分', { minutes });
}

/** 容器历史资源指标数据点（与后端 ContainerMetricPoint 对应） */
interface ContainerMetricPoint {
  timestamp: number;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
  rxDelta: number;
  txDelta: number;
}

/** 资源监控时间范围：实时 / 1 小时 / 24 小时 / 7 天 */
type StatsRange = 'realtime' | '1h' | '24h' | '7d' | '30d' | '90d';

/**
 * 将毫秒时间戳格式化为历史曲线 X 轴标签（MM-DD HH:mm）
 * @param ts 毫秒时间戳
 */
function formatHistTime(ts: number): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 将毫秒时间戳格式化为实时曲线 X 轴标签（HH:MM:SS）
 * @param ts 毫秒时间戳
 */
function formatRealtimeTime(ts: number): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 容器详情页组件
 */
export default function ContainerDetailPage() {
  const { t } = useLang();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [detail, setDetail] = useState<ContainerDetailInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>(() => {
    // 支持 ?tab= 直达指定标签页（如 Compose 页服务跳转终端）
    const t = new URLSearchParams(window.location.search).get('tab');
    return (['detail', 'logs', 'terminal', 'stats', 'files', 'inspect'].includes(t || '') ? (t as TabKey) : 'detail');
  });
  // 镜像自动更新：条目（null = 未加入）
  const [autoUpd, setAutoUpd] = useState<AutoUpdItem | null>(null);
  const [autoUpdBusy, setAutoUpdBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [starting, setStarting] = useState(false);
  // 停止 / 暂停 / 恢复处理中状态
  const [stopping, setStopping] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [unpausing, setUnpausing] = useState(false);
  // 环境变量 / 挂载卷 / 网络 / 端口映射 / 运行配置编辑弹窗：仅持有开关，
  // 草稿与提交逻辑在 EnvEditModal / MountEditModal / NetEditModal / PortEditModal / ConfigRunModal 内部（1.92.0 拆分）
  const [envEditOpen, setEnvEditOpen] = useState(false);
  const [mountEditOpen, setMountEditOpen] = useState(false);
  const [netEditOpen, setNetEditOpen] = useState(false);
  const [portEditOpen, setPortEditOpen] = useState(false);
  const [cfgEditOpen, setCfgEditOpen] = useState(false);
  // 提交为镜像 / 克隆 / 保存为模板 / 执行命令弹窗：仅持有开关，
  // 草稿与提交逻辑在 CommitImageModal / CloneModal / SaveTemplateModal / ExecCommandModal 内部（1.92.0 拆分）
  const [commitOpen, setCommitOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
  // 宿主机端口占用冲突映射（key 为宿主端口，值为占用该端口的其他容器）
  const [portConflicts, setPortConflicts] = useState<ContainerPortConflicts>({});
  // 更新配置 / 健康检查 / 历史日志弹窗：仅持有开关，
  // 草稿与提交逻辑在 UpdateConfigModal / HealthCheckModal / HistoryLogModal 内部（1.92.0 拆分）
  const [updateOpen, setUpdateOpen] = useState(false);
  const [hcEditOpen, setHcEditOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);

  /** 实时日志 hook（容器 id 存在时自动连接） */
  const { lines, connected, error, start, stop, clear } = useContainerLogs(id || null, {
    tail: 200,
    autoStart: false,
  });

  // 级别筛选 chips（1.92.0）：全部 / 错误 / 警告，纯前端过滤

  const [logLevelFilter, setLogLevelFilter] = useState<LogLevelFilterValue>('all');
  const leveledLines = useMemo(
    () => lines.map((l) => ({ ...l, level: detectLogLevel(l.text) })),
    [lines],
  );
  const logLevelCounts = useMemo(
    () => ({
      error: leveledLines.filter((l) => l.level === 'error').length,
      warn: leveledLines.filter((l) => l.level === 'warn').length,
    }),
    [leveledLines],
  );
  const shownLines = logLevelFilter === 'all' ? leveledLines : leveledLines.filter((l) => l.level === logLevelFilter);

  // 日志滚动相关
  const logBoxRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // 资源监控数据
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  // 实时曲线各点的 X 轴时间标签（与 cpuHist/memHist 一一对应，HH:MM:SS）
  const [realtimeLabels, setRealtimeLabels] = useState<string[]>([]);
  // 资源监控时间范围（实时 / 1h / 24h / 7d），切换后影响曲线数据来源与轮询行为
  const [statsRange, setStatsRange] = useState<StatsRange>('realtime');
  // 历史趋势数据点（仅 1h/24h/7d 模式使用，来自 /stats/history 接口）
  const [metricsPoints, setMetricsPoints] = useState<ContainerMetricPoint[]>([]);
  // 历史趋势加载中状态（用于首拉空数据时展示加载提示）
  const [metricsLoading, setMetricsLoading] = useState(false);
  // 检查 (Inspect) 原始 JSON
  const [inspectJson, setInspectJson] = useState<string>('');
  const [inspectLoading, setInspectLoading] = useState(false);
  // 容器内进程列表 (docker top)
  const [topData, setTopData] = useState<{ titles: string[]; processes: string[][] } | null>(null);
  const [topLoading, setTopLoading] = useState(false);
  // 容器文件系统变更 (docker diff)
  const [diffItems, setDiffItems] = useState<Array<{ path: string; kind: number; kindLabel: string }> | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffFilter, setDiffFilter] = useState<'all' | 'added' | 'modified' | 'deleted'>('all');
  // 容器配置快照对比
  const [snapshots, setSnapshots] = useState<Array<{ id: number; username: string; createdAt: number }>>([]);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapFrom, setSnapFrom] = useState('');
  const [snapTo, setSnapTo] = useState('');
  const [snapDiff, setSnapDiff] = useState<Array<{ field: string; label: string; from: string; to: string }> | null>(null);
  const [snapSaving, setSnapSaving] = useState(false);
  // 容器相关操作记录 (最近 20 条)
  const [operations, setOperations] = useState<
    Array<{ id: number; username: string; action: string; detail: string | null; success: boolean; createdAt: number }>
  >([]);
  const [opsLoading, setOpsLoading] = useState(false);

  /**
   * 拉取容器完整详情
   */
  const fetchDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await get<ContainerDetailInfo>(`/api/containers/${encodeURIComponent(id)}/detail`);
      setDetail(data || null);
    } catch (e: any) {
      showToast(e?.message || t('拉取容器详情失败'), 'error');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id, showToast]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  /** 拉取 Inspect 原始 JSON */
  const fetchInspect = useCallback(async () => {
    if (!id) return;
    setInspectLoading(true);
    try {
      const data = await get<{ inspect: unknown }>(`/api/containers/${encodeURIComponent(id)}/inspect`);
      setInspectJson(JSON.stringify(data?.inspect ?? {}, null, 2));
    } catch (e: any) {
      showToast(e?.message || t('拉取 Inspect 失败'), 'error');
    } finally {
      setInspectLoading(false);
    }
  }, [id, showToast]);

  useEffect(() => {
    if (tab === 'inspect' && !inspectJson) fetchInspect();
  }, [tab, inspectJson, fetchInspect]);

  /** 拉取容器内进程列表 (docker top) */
  const fetchTop = useCallback(async () => {
    if (!id) return;
    setTopLoading(true);
    try {
      const data = await get<{ titles: string[]; processes: string[][] }>(`/api/containers/${encodeURIComponent(id)}/top`);
      setTopData(data || { titles: [], processes: [] });
    } catch {
      setTopData({ titles: [], processes: [] });
    } finally {
      setTopLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (tab === 'detail' && detail?.state === 'running') fetchTop();
  }, [tab, detail?.state, fetchTop]);

  /** 拉取容器文件系统变更 (docker diff) */
  const fetchDiff = useCallback(async () => {
    if (!id) return;
    setDiffLoading(true);
    try {
      const data = await get<{ items: Array<{ path: string; kind: number; kindLabel: string }> }>(
        `/api/containers/${encodeURIComponent(id)}/diff`
      );
      setDiffItems(data?.items || []);
    } catch {
      setDiffItems([]);
    } finally {
      setDiffLoading(false);
    }
  }, [id]);

  /** 拉取配置快照列表 */
  const fetchSnapshots = useCallback(async () => {
    if (!id) return;
    setSnapLoading(true);
    try {
      const data = await get<{ items: Array<{ id: number; username: string; createdAt: number }> }>(
        `/api/containers/${encodeURIComponent(id)}/snapshots`
      );
      setSnapshots(data?.items || []);
    } catch {
      setSnapshots([]);
    } finally {
      setSnapLoading(false);
    }
  }, [id]);

  /** 保存当前配置为快照 */
  const saveSnapshot = useCallback(async () => {
    if (!id) return;
    setSnapSaving(true);
    try {
      await post(`/api/containers/${encodeURIComponent(id)}/snapshot`);
      showToast(t('快照已保存'), 'success');
      fetchSnapshots();
    } catch (e: any) {
      showToast(e?.message || t('保存快照失败'), 'error');
    } finally {
      setSnapSaving(false);
    }
  }, [id, fetchSnapshots, showToast]);

  /** 删除一条快照 */
  const deleteSnapshot = useCallback(
    async (snapId: number) => {
      try {
        await del(`/api/containers/snapshots/${snapId}`);
        showToast(t('快照已删除'), 'success');
        fetchSnapshots();
      } catch (e: any) {
        showToast(e?.message || t('删除快照失败'), 'error');
      }
    },
    [fetchSnapshots, showToast]
  );

  /** 对比两份快照 */
  const runSnapshotDiff = useCallback(async () => {
    if (!id || !snapFrom || !snapTo) {
      showToast(t('请选择要对比的两份快照'), 'error');
      return;
    }
    if (snapFrom === snapTo) {
      showToast(t('两份快照相同，无需对比'), 'error');
      return;
    }
    try {
      const data = await get<{ diffs: Array<{ field: string; label: string; from: string; to: string }> }>(
        `/api/containers/${encodeURIComponent(id)}/snapshot-diff?from=${snapFrom}&to=${snapTo}`
      );
      setSnapDiff(data?.diffs || []);
    } catch (e: any) {
      showToast(e?.message || t('对比失败'), 'error');
    }
  }, [id, snapFrom, snapTo, showToast]);


  /** 拉取该容器的操作记录 */
  const fetchOperations = useCallback(async () => {
    if (!id || !detail?.name) return;
    setOpsLoading(true);
    try {
      const data = await get<{ items: Array<{ id: number; username: string; action: string; detail: string | null; success: boolean; createdAt: number }> }>(
        `/api/containers/${encodeURIComponent(id)}/operations`
      );
      setOperations(data?.items || []);
    } catch {
      setOperations([]);
    } finally {
      setOpsLoading(false);
    }
  }, [id, detail?.name]);

  useEffect(() => {
    if (detail?.name) fetchOperations();
  }, [detail?.name, fetchOperations]);

  /**
   * 拉取全部容器并计算当前容器宿主端口与其他容器的占用冲突
   *
   * 规则：遍历所有容器，收集每个容器发布的宿主端口；若某个宿主端口被除当前容器外的其他容器占用，
   * 则记录为冲突，key 为宿主端口字符串。
   */
  const loadPortConflicts = useCallback(async () => {
    if (!id) return;
    try {
      // 拉取全部容器（含已停止）用于比对端口占用
      const all = await get<ContainerListItem[]>('/api/containers', { all: true });
      const map: ContainerPortConflicts = {};
      // 收集除当前容器外，各容器发布的宿主端口集合
      for (const c of all || []) {
        if (c.Id === id) continue;
        const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '');
        for (const p of c.Ports || []) {
          if (p.PublicPort === undefined || p.PublicPort === null) continue;
          const key = String(p.PublicPort);
          if (!map[key]) map[key] = [];
          // 避免同一容器重复占用同一端口时重复记录
          if (!map[key].some((x) => x.containerId === c.Id)) {
            map[key].push({ containerId: c.Id, containerName: name });
          }
        }
      }
      setPortConflicts(map);
    } catch {
      // 拉取冲突失败不阻塞详情展示
      setPortConflicts({});
    }
  }, [id]);

  useEffect(() => {
    loadPortConflicts();
  }, [loadPortConflicts]);

  /**
   * 获取占用某个宿主端口的其他容器列表（不含当前容器）
   * @param hostPort 宿主端口
   * @returns 占用该端口的其他容器名称数组
   */
  function getPortConflicters(hostPort: string): Array<{ containerId: string; containerName: string }> {
    return portConflicts[hostPort] || [];
  }

  /**
   * 断开实时日志连接
   */
  const handleDisconnect = useCallback(() => {
    stop();
  }, [stop]);

  /**
   * 连接实时日志
   *
   * SSE 接口自带 tail 历史，连接时会一次性回放最近日志，无需单独拉取历史。
   * 拉取历史仅在断开场景下作为备用方案，此处失败不阻塞连接。
   */
  const handleConnect = useCallback(async () => {
    if (!id) return;
    try {
      // 断开场景：先一次性拉取最近 200 行历史（SSE 同样会回放，这里用于兼容）
      await get<{ logs: string }>(`/api/containers/${encodeURIComponent(id)}/logs`, { tail: 200 });
    } catch {
      // 拉取历史失败不阻塞连接
    }
    clear();
    start();
  }, [id, start, clear]);

  /**
   * 下载容器的完整日志文件（调用后端 /logs/download，返回完整日志而非当前缓冲）
   */
  const handleDownloadLogs = useCallback(async () => {
    if (!id) return;
    try {
      await download(
        `/api/containers/${encodeURIComponent(id)}/logs/download`,
        `${detail?.name || id || 'container'}.log`
      );
      showToast(t('已下载完整日志'));
    } catch (e: any) {
      showToast(e?.message || t('下载日志失败'), 'error');
    }
  }, [id, detail?.name, showToast]);

  /**
   * 日志区自动滚动到底部（仅开启时生效）
   */
  useEffect(() => {
    if (autoScroll && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  /**
   * 拉取一次容器资源统计
   */
  const fetchStats = useCallback(async () => {
    if (!id) return;
    try {
      const s = await get<ContainerStats>(`/api/containers/${encodeURIComponent(id)}/stats`);
      setStats(s);
    } catch {
      // 忽略统计拉取失败
    }
  }, [id]);

  // ===== 镜像自动更新 =====
  const loadAutoUpd = useCallback(async () => {
    if (!id) return;
    try {
      const res = await get<{ items: AutoUpdItem[] }>('/api/image-updates');
      setAutoUpd(res.items?.find((i) => i.container_id === id) || null);
    } catch {
      // 静默：不影响详情展示
    }
  }, [id]);

  useEffect(() => {
    loadAutoUpd();
  }, [loadAutoUpd]);

  /** 加入 / 退出自动更新 */
  const handleAutoUpdToggle = useCallback(async () => {
    if (!id) return;
    setAutoUpdBusy(true);
    try {
      if (autoUpd) {
        await del(`/api/image-updates/${encodeURIComponent(id)}`);
        showToast(t('已退出镜像自动更新'));
      } else {
        await post('/api/image-updates', { containerId: id, enabled: true });
        showToast(t('已加入镜像自动更新'));
      }
      await loadAutoUpd();
    } catch (e: any) {
      showToast(e?.message || t('操作失败'), 'error');
    } finally {
      setAutoUpdBusy(false);
    }
  }, [id, autoUpd, loadAutoUpd, showToast]);

  /** 立即检查并按需更新 */
  const handleAutoUpdCheck = useCallback(async () => {
    if (!id) return;
    setAutoUpdBusy(true);
    try {
      const res = await post<{ status: string; detail: string }>('/api/image-updates/check', { containerId: id });
      showToast(res.detail || t('检查完成'), res.status === 'fail' ? 'error' : undefined);
      await loadAutoUpd();
    } catch (e: any) {
      showToast(e?.message || t('检查失败'), 'error');
    } finally {
      setAutoUpdBusy(false);
    }
  }, [id, loadAutoUpd, showToast]);


  /**
   * 实时模式：进入资源监控 Tab 时拉取初始统计，并每 2 秒轮询 + 积累实时曲线
   *
   * 仅在 statsRange === 'realtime' 时启用轮询；切换到历史模式时停止轮询，
   * 再次切回实时时清空缓冲重新积累，避免新旧数据混叠。
   */
  useEffect(() => {
    if (tab !== 'stats' || !id || statsRange !== 'realtime') return;
    let alive = true;
    // 切换到实时模式时清空历史缓冲，重新积累曲线
    setCpuHist([]);
    setMemHist([]);
    setRealtimeLabels([]);
    fetchStats();
    const timer = window.setInterval(async () => {
      try {
        const s = await get<ContainerStats>(`/api/containers/${encodeURIComponent(id)}/stats`);
        if (!alive) return;
        setStats(s);
        const ts = Date.now();
        setCpuHist((prev) => [...prev.slice(-29), Number(s.cpuPercent.toFixed(1))]);
        setMemHist((prev) => [...prev.slice(-29), Number(s.memory.percent.toFixed(1))]);
        setRealtimeLabels((prev) => [...prev.slice(-29), formatRealtimeTime(ts)]);
      } catch {
        // 单个采样失败忽略
      }
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [tab, id, statsRange, fetchStats]);

  /**
   * 历史模式：选择 1h/24h/7d 时拉取历史趋势，并每 30 秒刷新以获取最新采样点
   *
   * 切换时间范围或容器时重新拉取；拉取失败时清空数据点避免展示残留。
   */
  useEffect(() => {
    if (tab !== 'stats' || !id || statsRange === 'realtime') return;
    let alive = true;
    const load = async () => {
      setMetricsLoading(true);
      try {
        const data = await get<{ points: ContainerMetricPoint[] }>(
          `/api/containers/${encodeURIComponent(id)}/stats/history`,
          { range: statsRange }
        );
        if (!alive) return;
        setMetricsPoints(data?.points || []);
      } catch {
        if (!alive) return;
        setMetricsPoints([]);
      } finally {
        if (alive) setMetricsLoading(false);
      }
    };
    load();
    // 每 30 秒刷新一次历史数据，获取最新采样点
    const timer = window.setInterval(load, 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [tab, id, statsRange]);

  /**
   * 重启容器
   */
  async function handleRestart() {
    if (!id) return;
    setRestarting(true);
    try {
      await post(`/api/containers/${id}/restart`);
      showToast(t('已重启容器'));
      fetchDetail();
    } catch (e: any) {
      showToast(t('重启失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setRestarting(false);
    }
  }

  /**
   * 启动容器（用于未运行容器连接终端前置操作）
   */
  async function handleStart() {
    if (!id) return;
    setStarting(true);
    try {
      await post(`/api/containers/${id}/start`);
      showToast(t('容器已启动'));
      fetchDetail();
    } catch (e: any) {
      showToast(t('启动失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setStarting(false);
    }
  }

  /** 停止容器 */
  async function handleStop() {
    if (!id) return;
    setStopping(true);
    try {
      await post(`/api/containers/${id}/stop`);
      showToast(t('容器已停止'));
      fetchDetail();
    } catch (e: any) {
      showToast(t('停止失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setStopping(false);
    }
  }

  /** 暂停容器 */
  async function handlePause() {
    if (!id) return;
    setPausing(true);
    try {
      await post(`/api/containers/${id}/pause`);
      showToast(t('容器已暂停'));
      fetchDetail();
    } catch (e: any) {
      showToast(t('暂停失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setPausing(false);
    }
  }

  /** 恢复暂停的容器 */
  async function handleUnpause() {
    if (!id) return;
    setUnpausing(true);
    try {
      await post(`/api/containers/${id}/unpause`);
      showToast(t('容器已恢复'));
      fetchDetail();
    } catch (e: any) {
      showToast(t('恢复失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setUnpausing(false);
    }
  }

  /** 打开编辑弹窗（草稿与提交逻辑在各自 Modal 组件内部） */
  function openEnvEdit() {
    setEnvEditOpen(true);
  }

  function openMountEdit() {
    setMountEditOpen(true);
  }

  function openNetEdit() {
    setNetEditOpen(true);
  }

  function openPortEdit() {
    setPortEditOpen(true);
  }

  function openCfgEdit() {
    setCfgEditOpen(true);
  }

  /**
   * 删除容器（确认后执行，成功后返回列表）
   */
  async function confirmDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      const resp = await del<any>(`/api/containers/${id}`, { force: true, v: deleteVolumes });
      // 审批门禁：后端返回 202 表示操作已转为待审批
      if (resp?.approvalPending) {
        showToast(t('该操作已提交审批，待管理员批准后执行'), 'info');
        navigate('/approvals');
        return;
      }
      showToast(t('已删除容器'));
      navigate('/containers');
    } catch (e: any) {
      showToast(t('删除失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
      setDeleteVolumes(false);
    }
  }

  /**
   * 一键重建容器：基于现有容器原样重建（保留全部配置，不改动任何设置）。
   * 用于解决容器异常/配置漂移，或让最新镜像分层/挂载引用重新生效。
   */
  async function confirmRebuild() {
    if (!id) return;
    setRebuilding(true);
    try {
      await post(`/api/containers/${id}/recreate`, {});
      showToast(t('容器已重建'));
      setRebuildOpen(false);
      await fetchDetail();
    } catch (e: any) {
      showToast(t('重建失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setRebuilding(false);
    }
  }

  /**
   * 导出容器完整配置为 JSON 文件（供备份 / 迁移 / 从配置重建）
   */
  async function exportConfig() {
    if (!id) return;
    try {
      const res = await get<any>(`/api/containers/${id}/config`);
      const payload = res?.config ? res : { schema: 'docker-manager.container.config/v1', config: res };
      const fileName = `${(res?.config?.name || detail?.name || 'container')}-config.json`;
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('容器配置已导出'));
    } catch (e: any) {
      showToast(t('导出失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    }
  }

  /** 打开弹窗（草稿与提交逻辑在各自 Modal 组件内部） */
  function openSaveTemplate() {
    setSaveTplOpen(true);
  }

  function openHistoryLogs() {
    setHistOpen(true);
  }

  function openCommit() {
    setCommitOpen(true);
  }

  function openUpdate() {
    setUpdateOpen(true);
  }

  function openHealthEdit() {
    setHcEditOpen(true);
  }

  function openClone() {
    setCloneOpen(true);
  }

  function openExec() {
    setExecOpen(true);
  }

  /** 日志框的滚动处理 */
  const onLogScroll = () => {
    const el = logBoxRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  };

  /** 当前是否处于日志视图 */
  const isLogTab = tab === 'logs';

  /** 运行状态判断 */
  const running = detail?.state === 'running';
  /** 是否为暂停状态 */
  const paused = detail?.state === 'paused';
  /** 是否已退出（停止） */
  const exited = detail?.state === 'exited';

  /** 资源监控网格数值：实时模式取最新 stats，历史模式取最新历史点 */
  const latestHist = metricsPoints.length > 0 ? metricsPoints[metricsPoints.length - 1] : null;
  const cpuValue =
    statsRange === 'realtime'
      ? stats
        ? stats.cpuPercent.toFixed(1) + '%'
        : '-'
      : latestHist
        ? latestHist.cpuPercent.toFixed(1) + '%'
        : '-';
  const memValue =
    statsRange === 'realtime'
      ? stats
        ? `${formatBytes(stats.memory.usage)} / ${formatBytes(stats.memory.limit)}`
        : '-'
      : latestHist
        ? `${formatBytes(latestHist.memUsage)} / ${formatBytes(latestHist.memLimit)}`
        : '-';
  const netValue =
    statsRange === 'realtime'
      ? stats
        ? `${formatBytes(stats.network.rx)} / ${formatBytes(stats.network.tx)}`
        : '-'
      : latestHist
        ? `${formatBytes(latestHist.netRx)} / ${formatBytes(latestHist.netTx)}`
        : '-';

  /** 曲线数据：实时模式用内存缓冲，历史模式用历史数据点映射 */
  const chartCpu =
    statsRange === 'realtime' ? cpuHist : metricsPoints.map((p) => Number(p.cpuPercent.toFixed(1)));
  const chartMem =
    statsRange === 'realtime' ? memHist : metricsPoints.map((p) => Number(p.memPercent.toFixed(1)));
  const chartLabels =
    statsRange === 'realtime'
      ? realtimeLabels
      : metricsPoints.map((p) => formatHistTime(p.timestamp));

  if (loading) return <PageLoading />;

  return (
    <div className="detail-page">
      <div className="detail-page__top">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          {t('← 返回容器列表')}
        </Button>
        <div className="detail-page__title-row">
          <h1 className="detail-page__title" title={detail?.id}>
            {detail?.name || t('容器详情')}
          </h1>
          {running && (
            <Button variant="secondary" size="sm" loading={restarting} onClick={handleRestart}>
              {t('重启')}
            </Button>
          )}
          {running && (
            <Button variant="secondary" size="sm" loading={stopping} onClick={handleStop}>
              {t('停止')}
            </Button>
          )}
          {running && (
            <Button variant="secondary" size="sm" loading={pausing} onClick={handlePause}>
              {t('暂停')}
            </Button>
          )}
          {paused && (
            <Button variant="secondary" size="sm" loading={unpausing} onClick={handleUnpause}>
              {t('恢复')}
            </Button>
          )}
          {exited && (
            <Button variant="secondary" size="sm" loading={starting} onClick={handleStart}>
              {t('启动')}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={openClone}>
            {t('克隆')}
          </Button>
          <Button variant="secondary" size="sm" onClick={openCommit}>
            {t('提交为镜像')}
          </Button>
          <Button variant="secondary" size="sm" onClick={openExec}>
            {t('执行命令')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setRebuildOpen(true)}>
            {t('重建')}
          </Button>
          <Button variant="secondary" size="sm" onClick={openUpdate} disabled={!detail}>
            {t('更新配置')}
          </Button>
          <Button variant="secondary" size="sm" onClick={exportConfig}>
            {t('导出配置')}
          </Button>
          <Button variant="secondary" size="sm" onClick={openSaveTemplate}>
            {t('保存为模板')}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
            {t('删除')}
          </Button>
        </div>
      </div>

      {!detail ? (
        <Empty title={t('未找到容器')} description={t('该容器可能已被删除或 ID 不正确')} />
      ) : (
        <>
          {/* Tab 切换栏 */}
          <div className="detail-tabs">
            {TABS.map((tb) => (
              <button
                key={tb.key}
                className={`detail-tabs__item ${tab === tb.key ? 'detail-tabs__item--active' : ''}`}
                onClick={() => setTab(tb.key)}
              >
                {t(tb.label)}
              </button>
            ))}
          </div>

          {/* 详情 Tab */}
          {tab === 'detail' && (
            <div className="detail-panel">
              {/* 基本信息 */}
              <Card
                title={t('基本信息')}
                extra={
                  <Button variant="ghost" size="sm" onClick={openCfgEdit}>
                    {t('运行配置')}
                  </Button>
                }
              >
                <div className="desc-grid">
                  <div className="desc-item">
                    <div className="desc-label">{t('名称')}</div>
                    <div className="desc-value">{detail.name || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('镜像')}</div>
                    <div className="desc-value" title={detail.image}>
                      {detail.image || '-'}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('镜像 ID')}</div>
                    <div className="desc-value mono" title={detail.imageId}>
                      {detail.idShort || detail.id || '-'}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('状态')}</div>
                    <div className="desc-value">
                      <StatusBadge status={detail.state} />
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('命令')}</div>
                    <div className="desc-value mono">{detail.command || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('入口点')}</div>
                    <div className="desc-value mono">{detail.entrypoint || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('重启策略')}</div>
                    <div className="desc-value">{detail.restartPolicy || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('主机名')}</div>
                    <div className="desc-value mono">{detail.hostname || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('用户')}</div>
                    <div className="desc-value mono">{detail.user || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('工作目录')}</div>
                    <div className="desc-value mono">{detail.workingDir || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('特权模式')}</div>
                    <div className="desc-value">{detail.privileged ? t('是') : t('否')}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('自动移除')}</div>
                    <div className="desc-value">{detail.autoRemove ? t('是') : t('否')}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('创建时间')}</div>
                    <div className="desc-value">{formatTime(detail.created)}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('启动时间')}</div>
                    <div className="desc-value">{formatTime(detail.startedAt)}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('退出时间')}</div>
                    <div className="desc-value">{formatTime(detail.finishedAt)}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('已运行时长')}</div>
                    <div className="desc-value">
                      {running ? formatDuration(detail.startedAt) : t('已停止')}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('重启次数')}</div>
                    <div className="desc-value mono">
                      {detail.restartCount ?? 0}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">{t('退出码')}</div>
                    <div className="desc-value mono">{detail.exitCode ?? '-'}</div>
                  </div>
                </div>
              </Card>

              {/* 端口映射 */}
              <Card
                title={t('端口映射')}
                extra={
                  <Button variant="ghost" size="sm" onClick={openPortEdit}>
                    {t('编辑')}
                  </Button>
                }
              >
                {detail.ports && detail.ports.length > 0 ? (
                  <table className="detail-table">
                    <thead>
                      <tr>
                        <th>{t('容器端口')}</th>
                        <th>{t('宿主机映射')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.ports.map((p, i) => {
                        // 收集该容器端口各发布映射中存在的冲突占用者
                        const conflicts = (p.published || [])
                          .map((x) => getPortConflicters(x.hostPort))
                          .filter((arr) => arr.length > 0)
                          .flat();
                        return (
                          <tr
                            key={i}
                            className={conflicts.length > 0 ? 'detail-table__row--conflict' : undefined}
                          >
                            <td className="mono">{p.internal}</td>
                            <td className="mono">
                              {p.published && p.published.length > 0
                                ? p.published
                                    .map((x) => `${x.hostIp || '0.0.0.0'}:${x.hostPort}`)
                                    .join(', ')
                                : '-'}
                              {/* 命中端口冲突时展示警告标记与占用容器 */}
                              {conflicts.length > 0 && (
                                <div className="port-conflict">
                                  <span className="port-conflict__tag">{t('端口冲突')}</span>
                                  <span className="port-conflict__owners">
                                    {t('被 {{names}} 占用', { names: conflicts.map((c) => c.containerName).join('、') })}
                                  </span>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <Empty title={t('无端口映射')} description={t('该容器未发布端口')} />
                )}
              </Card>

              {/* 挂载卷 */}
              <Card
                title={t('挂载卷')}
                extra={
                  <Button variant="ghost" size="sm" onClick={openMountEdit}>
                    {t('编辑')}
                  </Button>
                }
              >
                {detail.mounts && detail.mounts.length > 0 ? (
                  <table className="detail-table">
                    <thead>
                      <tr>
                        <th>{t('类型')}</th>
                        <th>{t('来源')}</th>
                        <th>{t('目标')}</th>
                        <th>{t('读写')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.mounts.map((m, i) => (
                        <tr key={i}>
                          <td>{m.type || '-'}</td>
                          <td className="mono">{m.source || '-'}</td>
                          <td className="mono">{m.destination || '-'}</td>
                          <td>{m.rw ? t('读写') : t('只读')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty title={t('无挂载卷')} description={t('该容器未挂载任何卷')} />
                )}
              </Card>

              {/* 网络 */}
              <Card
                title={t('网络')}
                extra={
                  <Button variant="ghost" size="sm" onClick={openNetEdit}>
                    {t('编辑')}
                  </Button>
                }
              >
                {detail.networks && detail.networks.length > 0 ? (
                  <table className="detail-table">
                    <thead>
                      <tr>
                        <th>{t('网络')}</th>
                        <th>{t('IP 地址')}</th>
                        <th>{t('网关')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.networks.map((n, i) => (
                        <tr key={i}>
                          <td>{n.name || '-'}</td>
                          <td className="mono">{n.ipAddress || '-'}</td>
                          <td className="mono">{n.gateway || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty title={t('无网络')} description={t('该容器未连接到网络')} />
                )}
              </Card>

              {/* 环境变量 */}
              <Card
                title={t('环境变量')}
                extra={
                  <Button variant="ghost" size="sm" onClick={openEnvEdit}>
                    {t('编辑')}
                  </Button>
                }
              >
                {detail.env && Object.keys(detail.env).length > 0 ? (
                  <div className="kv-scroll">
                    <table className="kv-table">
                      <tbody>
                        {Object.entries(detail.env).map(([k, v]) => (
                          <tr key={k}>
                            <td className="kv-key">{k}</td>
                            <td className="kv-val">{v || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={t('无环境变量')} description={t('该容器未配置环境变量')} />
                )}
              </Card>

              {/* 镜像自动更新 */}
              <Card
                title={t('镜像自动更新')}
                extra={
                  <Button
                    variant={autoUpd?.enabled ? 'secondary' : 'primary'}
                    size="sm"
                    loading={autoUpdBusy}
                    onClick={handleAutoUpdToggle}
                  >
                    {autoUpd?.enabled ? t('退出自动更新') : t('开启自动更新')}
                  </Button>
                }
              >
                {autoUpd?.enabled ? (
                  <div className="kv-scroll">
                    <table className="kv-table">
                      <tbody>
                        <tr>
                          <td className="kv-key">{t('状态')}</td>
                          <td className="kv-val">
                            {autoUpd.last_status === 'updated'
                              ? t('已更新')
                              : autoUpd.last_status === 'rolledback'
                                ? t('已回滚')
                                : autoUpd.last_status === 'blocked'
                                  ? t('信任锁定拦截')
                                  : autoUpd.last_status === 'fail'
                                    ? t('失败')
                                    : t('正常')}
                          </td>
                        </tr>
                        <tr>
                          <td className="kv-key">{t('最近检查')}</td>
                          <td className="kv-val">
                            {autoUpd.last_check_at ? new Date(autoUpd.last_check_at).toLocaleString() : t('尚未检查')}
                          </td>
                        </tr>
                        <tr>
                          <td className="kv-key">{t('结果')}</td>
                          <td className="kv-val">{autoUpd.last_result || '-'}</td>
                        </tr>
                      </tbody>
                    </table>
                    <div style={{ marginTop: 8 }}>
                      <Button variant="ghost" size="sm" loading={autoUpdBusy} onClick={handleAutoUpdCheck}>
                        {t('立即检查更新')}
                      </Button>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
                      {t('加入后可通过「计划任务 → 镜像自动更新」配置扫描周期；有更新时按原配置重建容器，健康检查未通过自动回滚。')}
                    </div>
                  </div>
                ) : (
                  <Empty title={t('未加入自动更新')} description={t('开启后按计划任务周期拉取镜像，有更新时自动重建容器（失败自动回滚）')} />
                )}
              </Card>

              {/* 标签 */}
              <Card title={t('标签 (Labels)')}>
                {detail.labels && Object.keys(detail.labels).length > 0 ? (
                  <div className="kv-scroll">
                    <table className="kv-table">
                      <tbody>
                        {Object.entries(detail.labels).map(([k, v]) => (
                          <tr key={k}>
                            <td className="kv-key">{k}</td>
                            <td className="kv-val">{v || ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={t('无标签')} description={t('该容器未设置标签')} />
                )}
              </Card>

              {/* 健康检查 */}
              <Card
                title={t('健康检查')}
                extra={
                  <Button variant="secondary" size="sm" onClick={openHealthEdit}>
                    {detail.healthcheck &&
                    detail.healthcheck.test &&
                    detail.healthcheck.test.length > 0 &&
                    detail.healthcheck.test[0] !== 'NONE'
                      ? t('编辑')
                      : t('设置')}
                  </Button>
                }
              >
                {detail.health ? (
                  <>
                    <div className="desc-grid">
                      <div className="desc-item">
                        <div className="desc-label">{t('状态')}</div>
                        <div className="desc-value">
                          <StatusBadge status={detail.health.status} />
                        </div>
                      </div>
                      <div className="desc-item">
                        <div className="desc-label">{t('连续失败次数')}</div>
                        <div className="desc-value">{detail.health.failingStreak ?? 0}</div>
                      </div>
                    </div>
                    {detail.health.log && detail.health.log.length > 0 && (
                      <div className="kv-scroll health-log">
                        {detail.health.log.map((l, i) => (
                          <div key={i} className="health-log__item">
                            <div className="health-log__meta mono">
                              {formatTime(l.start)} · exit {l.exit}
                            </div>
                            <pre className="health-log__output">{l.output || t('(空输出)')}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="desc-value">
                    {t('容器未配置健康检查')}
                    {detail.healthcheck &&
                    detail.healthcheck.test &&
                    detail.healthcheck.test[0] === 'NONE'
                      ? t('（已禁用）')
                      : ''}
                    {t('。点击右上角「设置」可为容器添加健康检查。')}
                  </div>
                )}
              </Card>

              <Card
                title={t('容器内进程')}
                extra={
                  <Button variant="ghost" size="sm" onClick={fetchTop} disabled={topLoading}>
                    {t('刷新')}
                  </Button>
                }
              >
                {topLoading && !topData ? (
                  <div className="desc-value">{t('加载中...')}</div>
                ) : topData && topData.processes.length > 0 ? (
                  <div className="kv-scroll">
                    <table className="detail-table">
                      <thead>
                        <tr>
                          {topData.titles.map((h, i) => (
                            <th key={i}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {topData.processes.map((row, i) => (
                          <tr key={i}>
                            {row.map((cell, j) => (
                              <td key={j} className="mono">
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={t('无进程')} description={t('容器未运行或无法获取进程列表')} />
                )}
              </Card>

              <Card
                title={t('文件变更')}
                extra={
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Select
                      style={{ width: 96 }}
                      value={diffFilter}
                      onChange={(e: any) => setDiffFilter(e.target.value)}
                    >
                      <option value="all">{t('全部')}</option>
                      <option value="added">{t('新增')}</option>
                      <option value="modified">{t('修改')}</option>
                      <option value="deleted">{t('删除')}</option>
                    </Select>
                    <Button variant="ghost" size="sm" onClick={fetchDiff} disabled={diffLoading}>
                      {t('刷新')}
                    </Button>
                  </div>
                }
              >
                {diffLoading && !diffItems ? (
                  <div className="desc-value">{t('加载中...')}</div>
                ) : !diffItems ? (
                  <Empty title={t('尚未加载')} description={t('点击「刷新」加载容器运行期文件系统变更（docker diff）')} />
                ) : (() => {
                  const filtered = diffItems.filter((it) => diffFilter === 'all' || it.kindLabel === diffFilter);
                  if (filtered.length === 0) {
                    return <Empty title={t('无变更')} description={t('容器运行期没有匹配的文件系统变更')} />;
                  }
                  return (
                    <div className="kv-scroll">
                      <table className="detail-table">
                        <thead>
                          <tr>
                            <th style={{ width: 80 }}>{t('类型')}</th>
                            <th>{t('路径')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map((it, i) => (
                            <tr key={i}>
                              <td>
                                <span
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 500,
                                    color:
                                      it.kindLabel === 'added'
                                        ? 'var(--success, #22c55e)'
                                        : it.kindLabel === 'deleted'
                                          ? 'var(--danger, #ef4444)'
                                          : 'var(--warning, #f5a623)',
                                  }}
                                >
                                  {it.kindLabel === 'added'
                                    ? t('新增')
                                    : it.kindLabel === 'deleted'
                                      ? t('删除')
                                      : t('修改')}
                                </span>
                              </td>
                              <td className="mono">{it.path}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </Card>

              <Card
                title={t('配置快照')}
                extra={
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Button variant="ghost" size="sm" onClick={fetchSnapshots} disabled={snapLoading}>
                      {t('刷新')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={saveSnapshot} loading={snapSaving} disabled={!isAdmin()}>
                      {t('保存快照')}
                    </Button>
                  </div>
                }
              >
                {snapshots.length === 0 ? (
                  <Empty title={t('暂无快照')} description={t('点击「保存快照」记录当前容器配置（镜像/端口/环境变量/挂载卷等），随时对比两次快照找出配置变更')} />
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                      <Select style={{ width: 200 }} value={snapFrom} onChange={(e: any) => setSnapFrom(e.target.value)}>
                        <option value="">{t('基准快照')}</option>
                        {snapshots.map((s) => (
                          <option key={s.id} value={s.id}>
                            {new Date(s.createdAt).toLocaleString()}（{s.username || '-'}）
                          </option>
                        ))}
                      </Select>
                      <span>→</span>
                      <Select style={{ width: 200 }} value={snapTo} onChange={(e: any) => setSnapTo(e.target.value)}>
                        <option value="">{t('对比快照')}</option>
                        {snapshots.map((s) => (
                          <option key={s.id} value={s.id}>
                            {new Date(s.createdAt).toLocaleString()}（{s.username || '-'}）
                          </option>
                        ))}
                      </Select>
                      <Button variant="primary" size="sm" onClick={runSnapshotDiff}>
                        {t('对比')}
                      </Button>
                    </div>
                    {snapDiff !== null && (
                      snapDiff.length === 0 ? (
                        <div className="desc-value">{t('两份快照配置一致')}</div>
                      ) : (
                        <div className="kv-scroll">
                          <table className="detail-table">
                            <thead>
                              <tr>
                                <th style={{ width: 90 }}>{t('字段')}</th>
                                <th>{t('原值')}</th>
                                <th>{t('新值')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {snapDiff.map((d, i) => (
                                <tr key={i}>
                                  <td>{d.label}</td>
                                  <td className="mono" style={{ whiteSpace: 'pre-wrap' }}>{d.from || '—'}</td>
                                  <td className="mono" style={{ whiteSpace: 'pre-wrap' }}>{d.to || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )
                    )}
                    <div className="kv-scroll" style={{ marginTop: 8 }}>
                      <table className="detail-table">
                        <thead>
                          <tr>
                            <th>{t('保存时间')}</th>
                            <th>{t('保存人')}</th>
                            <th style={{ width: 70 }}>{t('操作')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshots.map((s) => (
                            <tr key={s.id}>
                              <td className="mono">{new Date(s.createdAt).toLocaleString()}</td>
                              <td>{s.username || '—'}</td>
                              <td>
                                {isAdmin() && (
                                  <Button variant="ghost" size="sm" onClick={() => deleteSnapshot(s.id)}>
                                    {t('删除')}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </Card>

              <Card
                title={t('操作记录')}
                extra={
                  <Button variant="ghost" size="sm" onClick={fetchOperations} disabled={opsLoading}>
                    {t('刷新')}
                  </Button>
                }
              >
                {operations.length > 0 ? (
                  <div className="kv-scroll">
                    <table className="detail-table">
                      <thead>
                        <tr>
                          <th>{t('时间')}</th>
                          <th>{t('操作人')}</th>
                          <th>{t('动作')}</th>
                          <th>{t('结果')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {operations.slice(0, 10).map((o) => (
                          <tr key={o.id}>
                            <td className="mono">{new Date(o.createdAt).toLocaleString()}</td>
                            <td>{o.username || '-'}</td>
                            <td>
                              {o.action}
                              {o.detail ? `（${o.detail}）` : ''}
                            </td>
                            <td>
                              <StatusBadge status={o.success ? 'success' : 'danger'} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={t('暂无操作记录')} description={t('对该容器的操作（启停 / 更新 / 删除等）会记录在此')} />
                )}
              </Card>

            </div>
          )}

          {/* 日志 Tab */}
          {isLogTab && (
            <div className="log-panel" onClick={(e) => e.stopPropagation()}>
              <div className="log-toolbar">
                <div className="log-toolbar__status">
                  <span
                    className={`log-dot ${connected ? 'log-dot--on' : 'log-dot--off'}`}
                  />
                  {connected ? t('已连接实时日志') : t('未连接')}
                  {error && <span className="log-error">（{error}）</span>}
                </div>
                <div className="log-toolbar__actions">
                  <LogLevelFilter
                    value={logLevelFilter}
                    onChange={setLogLevelFilter}
                    errorCount={logLevelCounts.error}
                    warnCount={logLevelCounts.warn}
                    labels={{ all: t('全部'), error: t('错误'), warn: t('警告') }}
                  />
                  <label className="log-check">
                    <input
                      type="checkbox"
                      checked={autoScroll}
                      onChange={(e) => setAutoScroll(e.target.checked)}
                    />
                    {t('自动滚动')}
                  </label>
                  {connected ? (
                    <Button variant="secondary" size="sm" onClick={handleDisconnect}>
                      {t('断开')}
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" onClick={handleConnect}>
                      {t('连接')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={clear}>
                    {t('清空')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleDownloadLogs}>
                    {t('下载')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={openHistoryLogs}>
                    {t('历史')}
                  </Button>
                </div>
              </div>
              <div className="log-box" ref={logBoxRef} onScroll={onLogScroll}>
                {shownLines.length === 0 ? (
                  <div className="log-empty">{t('暂无日志，点击「连接」开始拉取实时日志')}</div>
                ) : (
                  shownLines.map((l) => (
                    <div
                      key={l.id}
                      className={`log-line ${l.type === 'stderr' ? 'log-line--stderr' : ''}`}
                      style={{
                        color:
                          l.level === 'error'
                            ? 'var(--danger, #ff6b6b)'
                            : l.level === 'warn'
                              ? 'var(--warning, #e6b450)'
                              : undefined,
                      }}
                    >
                      {l.text}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* 终端 Tab */}
          {tab === 'terminal' && (
            <div className="terminal-panel">
              <div className="terminal-hint">{t('终端在容器内启动交互式 shell；精简镜像或未运行的容器无法连接。')}</div>
              {!running ? (
                <div className="terminal-empty">
                  <div className="terminal-empty__icon">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 9l-4 3 4 3" />
                      <path d="M12 17h8" />
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                    </svg>
                  </div>
                  <div className="terminal-empty__title">{t('容器当前未运行')}</div>
                  <div className="terminal-empty__desc">{t('终端需要在容器内启动交互式 shell，请先启动容器后重试。')}</div>
                  <Button variant="primary" size="sm" loading={starting} onClick={handleStart}>
                    {t('启动容器')}
                  </Button>
                </div>
              ) : (
                <ContainerTerminal containerId={id!} height={380} />
              )}
            </div>
          )}

          {/* 资源监控 Tab */}
          {tab === 'stats' && (
            <div className="stats-panel">
              <div className="stats-grid">
                <Card title={t('CPU 使用率')}>
                  <div className="stat-value mono">{cpuValue}</div>
                </Card>
                <Card title={t('内存使用')}>
                  <div className="stat-value mono">{memValue}</div>
                </Card>
                <Card title={t('网络 收 / 发')}>
                  <div className="stat-value mono">{netValue}</div>
                </Card>
              </div>
              <Card
                title={t('资源曲线')}
                extra={
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['realtime', '1h', '24h', '7d', '30d', '90d'] as StatsRange[]).map((r) => (
                      <button
                        key={r}
                        onClick={() => setStatsRange(r)}
                        style={{
                          padding: '4px 10px',
                          fontSize: 12,
                          lineHeight: 1.4,
                          borderRadius: 6,
                          cursor: 'pointer',
                          border:
                            statsRange === r ? '1px solid #6366f1' : '1px solid #e5e7eb',
                          background: statsRange === r ? '#eef2ff' : '#fff',
                          color: statsRange === r ? '#6366f1' : '#6b7280',
                        }}
                      >
                        {r === 'realtime' ? t('实时') : r}
                      </button>
                    ))}
                  </div>
                }
              >
                {statsRange !== 'realtime' && metricsLoading && metricsPoints.length === 0 ? (
                  <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                    {t('加载历史数据中…')}
                  </div>
                ) : chartCpu.length === 0 ? (
                  <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                    {t('暂无数据')}
                  </div>
                ) : (
                  <LineChart
                    series={[
                      { name: 'CPU %', color: '#6366f1', data: chartCpu },
                      { name: t('内存 %'), color: '#22c55e', data: chartMem },
                    ]}
                    labels={chartLabels}
                    unit="%"
                    max={100}
                  />
                )}
              </Card>
            </div>
          )}

          {/* 检查（Inspect）Tab */}
          {tab === 'inspect' && (
            <Card
              title={t('Inspect 原始配置')}
              extra={
                <div className="detail-toolbar-actions">
                  <Button variant="ghost" size="sm" onClick={fetchInspect} disabled={inspectLoading}>
                    {t('刷新')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inspectJson);
                        showToast(t('已复制到剪贴板'));
                      } catch {
                        showToast(t('复制失败'), 'error');
                      }
                    }}
                  >
                    {t('复制 JSON')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const blob = new Blob([inspectJson], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${detail?.name || 'container'}-inspect.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    {t('下载 JSON')}
                  </Button>
                </div>
              }
            >
              {inspectLoading && !inspectJson ? (
                <div className="desc-value">{t('加载中...')}</div>
              ) : (
                <pre className="inspect-json mono">{inspectJson}</pre>
              )}
            </Card>
          )}

          {/* 文件管理 Tab */}
          {tab === 'files' && (
            <div className="files-panel">
              <FileExplorer containerId={id!} />
            </div>
          )}
        </>
      )}

      <Modal
        open={deleteOpen}
        title={t('删除容器')}
        onClose={() => !deleting && setDeleteOpen(false)}
        width={440}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              {t('取消')}
            </Button>
            <Button variant="danger" size="md" onClick={confirmDelete} loading={deleting}>
              {t('删除')}
            </Button>
          </div>
        }
      >
        <p className="confirm-dialog__message">
          {t('确定要删除容器「{{name}}」吗？此操作不可撤销。', { name: detail?.name || '' })}
        </p>
        <label className="vol-delete__option">
          <input
            type="checkbox"
            checked={deleteVolumes}
            onChange={(e) => setDeleteVolumes(e.target.checked)}
          />
          {t('同时删除该容器的匿名卷（不影响具名卷）')}
        </label>
      </Modal>

      <ConfirmDialog
        open={rebuildOpen}
        title={t('重建容器')}
        message={t('确定要重建容器「{{v1}}」吗？将基于现有配置原样重新创建容器，过程会有短暂中断，且容器 ID 会改变。', { v1: detail?.name || '' })}
        confirmText={t('重建')}
        loading={rebuilding}
        onConfirm={confirmRebuild}
        onCancel={() => setRebuildOpen(false)}
      />

      {histOpen && (
        <HistoryLogModal containerId={id || ''} onClose={() => setHistOpen(false)} />
      )}
      {cloneOpen && (
        <CloneModal containerId={id || ''} containerName={detail?.name || ''} onClose={() => setCloneOpen(false)} onDone={fetchDetail} />
      )}
      {saveTplOpen && (
        <SaveTemplateModal containerId={id || ''} containerName={detail?.name || ''} onClose={() => setSaveTplOpen(false)} />
      )}
      {commitOpen && (
        <CommitImageModal containerId={id || ''} currentImage={detail?.image || ''} onClose={() => setCommitOpen(false)} />
      )}
      {execOpen && (
        <ExecCommandModal containerId={id || ''} onClose={() => setExecOpen(false)} />
      )}
      {envEditOpen && (
        <EnvEditModal containerId={id || ''} env={detail?.env || {}} onClose={() => setEnvEditOpen(false)} onDone={fetchDetail} />
      )}
      {mountEditOpen && (
        <MountEditModal containerId={id || ''} mounts={detail?.mounts || []} onClose={() => setMountEditOpen(false)} onDone={fetchDetail} />
      )}
      {netEditOpen && (
        <NetEditModal containerId={id || ''} current={detail?.networks?.[0]?.name || 'bridge'} onClose={() => setNetEditOpen(false)} onDone={fetchDetail} />
      )}
      {portEditOpen && (
        <PortEditModal containerId={id || ''} ports={detail?.ports || []} onClose={() => setPortEditOpen(false)} onDone={fetchDetail} />
      )}
      {cfgEditOpen && (
        <ConfigRunModal containerId={id || ''} restartPolicy={detail?.restartPolicy || 'no'} privileged={!!detail?.privileged} onClose={() => setCfgEditOpen(false)} onDone={fetchDetail} />
      )}
      {updateOpen && (
        <UpdateConfigModal containerId={id || ''} restartPolicy={detail?.restartPolicy || 'no'} cpuLimit={detail?.cpuLimit || 0} memLimit={detail?.memLimit || 0} onClose={() => setUpdateOpen(false)} onDone={fetchDetail} />
      )}
      {hcEditOpen && (
        <HealthCheckModal containerId={id || ''} healthcheck={detail?.healthcheck} env={detail?.env || {}} onClose={() => setHcEditOpen(false)} onDone={fetchDetail} />
      )}
    </div>
  );
}
