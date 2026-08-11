/**
 * 容器详情页
 *
 * 通过路由参数 id 展示指定容器的完整详情，并提供三个视图：
 *  - 详情：完整元数据（基本信息 / 挂载卷 / 网络 / 环境变量 / 端口 / 健康检查）
 *  - 日志：实时日志（SSE 流，可连接/断开/清空/自动滚动）
 *  - 终端：容器内 Web 终端（需容器内置 shell）
 *  - 资源监控：CPU / 内存 / 网络实时统计与曲线
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { get, del, post } from '../api/client';
import { ContainerDetailInfo, ContainerStats } from '../types';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import { Field, Input, Select } from '../components/Form';
import StatusBadge from '../components/StatusBadge';
import Empty from '../components/Empty';
import ConfirmDialog from '../components/ConfirmDialog';
import { PageLoading } from '../components/Loading';
import LineChart from '../components/LineChart';
import ContainerTerminal from '../components/ContainerTerminal';
import { useContainerLogs } from '../hooks/useContainerLogs';
import { useToast } from '../components/Toast';
import { ContainerPortConflicts, ContainerListItem } from '../types';
import './containerDetail.less';

/** Tab 类型 */
type TabKey = 'detail' | 'logs' | 'terminal' | 'stats';

/** Tab 配置 */
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'detail', label: '详情' },
  { key: 'logs', label: '日志' },
  { key: 'terminal', label: '终端' },
  { key: 'stats', label: '资源监控' },
];

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
  if (days > 0) return `${days}天${hours}小时${minutes}分`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分`;
}

/**
 * 容器详情页组件
 */
export default function ContainerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [detail, setDetail] = useState<ContainerDetailInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('detail');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [starting, setStarting] = useState(false);
  // 环境变量编辑弹窗状态
  const [envEditOpen, setEnvEditOpen] = useState(false);
  // 编辑中的环境变量（支持修改键名/值、删除、新增）
  const [envDraft, setEnvDraft] = useState<Array<{ key: string; value: string }>>([]);
  const [envSaving, setEnvSaving] = useState(false);
  // 挂载卷编辑弹窗状态
  const [mountEditOpen, setMountEditOpen] = useState(false);
  const [mountDraft, setMountDraft] = useState<Array<{ source: string; destination: string; rw: boolean }>>([]);
  const [mountSaving, setMountSaving] = useState(false);
  // 网络编辑弹窗状态
  const [netEditOpen, setNetEditOpen] = useState(false);
  const [netDraft, setNetDraft] = useState('');
  const [netOptions, setNetOptions] = useState<Array<{ Name: string; Id: string; Driver: string }>>([]);
  const [netSaving, setNetSaving] = useState(false);
  // 端口映射编辑弹窗状态
  const [portEditOpen, setPortEditOpen] = useState(false);
  const [portDraft, setPortDraft] = useState<Array<{ container: string; host: string; protocol: string }>>([]);
  const [portSaving, setPortSaving] = useState(false);
  // 运行配置（重启策略 / 特权模式）编辑弹窗状态
  const [cfgEditOpen, setCfgEditOpen] = useState(false);
  const [cfgRestartDraft, setCfgRestartDraft] = useState('no');
  const [cfgPrivilegedDraft, setCfgPrivilegedDraft] = useState(false);
  const [cfgSaving, setCfgSaving] = useState(false);
  // 提交为镜像弹窗状态
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitRepo, setCommitRepo] = useState('');
  const [commitTag, setCommitTag] = useState('latest');
  const [commitComment, setCommitComment] = useState('');
  const [commitAuthor, setCommitAuthor] = useState('');
  const [committing, setCommitting] = useState(false);
  // 克隆容器弹窗状态
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneValue, setCloneValue] = useState('');
  const [cloneStart, setCloneStart] = useState(true);
  const [cloning, setCloning] = useState(false);
  // 执行命令弹窗状态
  const [execOpen, setExecOpen] = useState(false);
  const [execCmd, setExecCmd] = useState('');
  const [execOutput, setExecOutput] = useState('');
  const [execExitCode, setExecExitCode] = useState<number | null>(null);
  const [executing, setExecuting] = useState(false);
  // 宿主机端口占用冲突映射（key 为宿主端口，值为占用该端口的其他容器）
  const [portConflicts, setPortConflicts] = useState<ContainerPortConflicts>({});

  // 历史日志查看（按时间范围分页拉取）状态
  const [histOpen, setHistOpen] = useState(false);
  const [histStart, setHistStart] = useState('');
  const [histEnd, setHistEnd] = useState('');
  const [histLoading, setHistLoading] = useState(false);
  const [histLogs, setHistLogs] = useState<string>('');

  /** 实时日志 hook（容器 id 存在时自动连接） */
  const { lines, connected, error, start, stop, clear } = useContainerLogs(id || null, {
    tail: 200,
    autoStart: false,
  });

  // 日志滚动相关
  const logBoxRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // 资源监控数据
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);

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
      showToast(e?.message || '拉取容器详情失败', 'error');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [id, showToast]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

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
   * 下载当前已接收的日志文本为 .log 文件
   *
   * 日志 Tab 使用 SSE 实时流，本函数将已缓冲的日志行（lines）拼接成纯文本，
   * 转为 Blob 后用 <a download> 触发浏览器下载，无需后端接口。
   * 文件名形如 <容器名>.log。
   */
  const handleDownloadLogs = useCallback(() => {
    // 将已缓冲的日志行文本拼接（SSE 末尾自带换行，无需额外补全）
    const text = lines.map((l) => l.text).join('');
    if (!text.trim()) {
      showToast('当前没有可下载的日志内容', 'error');
      return;
    }
    // 生成 Blob 并创建临时下载链接
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${detail?.name || id || 'container'}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('已下载当前日志');
  }, [lines, detail?.name, id, showToast]);

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

  /**
   * 进入资源监控 Tab 时拉取初始统计，并定时刷新 + 积累历史曲线
   */
  useEffect(() => {
    if (tab !== 'stats' || !id) return;
    let alive = true;
    fetchStats();
    const timer = window.setInterval(async () => {
      try {
        const s = await get<ContainerStats>(`/api/containers/${encodeURIComponent(id)}/stats`);
        if (!alive) return;
        setStats(s);
        setCpuHist((prev) => [...prev.slice(-29), Number(s.cpuPercent.toFixed(1))]);
        setMemHist((prev) => [...prev.slice(-29), Number(s.memory.percent.toFixed(1))]);
      } catch {
        // 单个采样失败忽略
      }
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [tab, id, fetchStats]);

  /**
   * 重启容器
   */
  async function handleRestart() {
    if (!id) return;
    setRestarting(true);
    try {
      await post(`/api/containers/${id}/restart`);
      showToast('已重启容器');
      fetchDetail();
    } catch (e: any) {
      showToast(`重启失败：${e?.message || '未知错误'}`, 'error');
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
      showToast('容器已启动');
      fetchDetail();
    } catch (e: any) {
      showToast(`启动失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setStarting(false);
    }
  }

  /**
   * 打开环境变量编辑弹窗：以当前环境变量初始化草稿
   */
  function openEnvEdit() {
    const entries = Object.entries(detail?.env || {}).map(([k, v]) => ({ key: k, value: v }));
    setEnvDraft(entries.length ? entries : [{ key: '', value: '' }]);
    setEnvEditOpen(true);
  }

  /**
   * 更新草稿中单个环境变量
   * @param index 环境变量索引
   * @param field 修改键还是值
   * @param value 新值
   */
  function updateEnvDraft(index: number, field: 'key' | 'value', value: string) {
    setEnvDraft((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /**
   * 删除草稿中某个环境变量
   * @param index 环境变量索引
   */
  function removeEnvDraft(index: number) {
    setEnvDraft((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * 新增一个空的环境变量条目
   */
  function addEnvDraft() {
    setEnvDraft((prev) => [...prev, { key: '', value: '' }]);
  }

  /**
   * 保存环境变量：基于现有容器重建（其余配置保留），替换为新的环境变量
   */
  async function saveEnv() {
    if (!id) return;
    // 过滤空键名条目，并校验重复
    const cleaned: Record<string, string> = {};
    let valid = true;
    for (const item of envDraft) {
      const k = item.key.trim();
      if (!k) continue;
      if (k in cleaned) {
        showToast(`环境变量 ${k} 重复定义`, 'error');
        valid = false;
        break;
      }
      cleaned[k] = item.value;
    }
    if (!valid) return;
    setEnvSaving(true);
    try {
      await post(`/api/containers/${id}/recreate`, { env: cleaned });
      showToast('环境变量已更新（容器已重建）');
      setEnvEditOpen(false);
      fetchDetail();
    } catch (e: any) {
      showToast(`更新失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setEnvSaving(false);
    }
  }

  /**
   * 打开挂载卷编辑弹窗：以当前挂载卷初始化草稿
   */
  function openMountEdit() {
    const entries = (detail?.mounts || []).map((m) => ({
      source: m.source || '',
      destination: m.destination || '',
      rw: m.rw !== false,
    }));
    setMountDraft(entries.length ? entries : [{ source: '', destination: '', rw: true }]);
    setMountEditOpen(true);
  }

  /**
   * 更新挂载卷草稿中单个条目
   * @param index 挂载索引
   * @param field 修改字段
   * @param value 新值
   */
  function updateMountDraft(index: number, field: 'source' | 'destination' | 'rw', value: any) {
    setMountDraft((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /**
   * 删除挂载卷草稿中某个条目
   * @param index 挂载索引
   */
  function removeMountDraft(index: number) {
    setMountDraft((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * 新增一个挂载卷条目
   */
  function addMountDraft() {
    setMountDraft((prev) => [...prev, { source: '', destination: '', rw: true }]);
  }

  /**
   * 保存挂载卷：组装 "source:destination[:ro]" 数组并重建容器
   */
  async function saveMounts() {
    if (!id) return;
    // 过滤缺项的挂载，并组装 Binds 数组
    const binds: string[] = [];
    for (const item of mountDraft) {
      const source = item.source.trim();
      const destination = item.destination.trim();
      if (!source || !destination) continue;
      binds.push(`${source}:${destination}${item.rw ? '' : ':ro'}`);
    }
    setMountSaving(true);
    try {
      await post(`/api/containers/${id}/recreate`, { binds });
      showToast('挂载卷已更新（容器已重建）');
      setMountEditOpen(false);
      fetchDetail();
    } catch (e: any) {
      showToast(`更新失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setMountSaving(false);
    }
  }

  /**
   * 打开网络编辑弹窗：加载可用网络并初始化当前选择
   */
  async function openNetEdit() {
    const current = detail?.networks?.[0]?.name || 'bridge';
    setNetDraft(current);
    try {
      const list = await get<Array<{ Name: string; Id: string; Driver: string }>>('/api/networks');
      setNetOptions(list || []);
    } catch (e: any) {
      showToast(`获取网络列表失败：${e?.message || '未知错误'}`, 'error');
      setNetOptions([]);
    }
    setNetEditOpen(true);
  }

  /**
   * 保存网络：基于现有容器重建并切换到所选网络
   */
  async function saveNet() {
    if (!id) return;
    if (!netDraft) {
      showToast('请选择网络', 'error');
      return;
    }
    setNetSaving(true);
    try {
      await post(`/api/containers/${id}/recreate`, { network: netDraft });
      showToast('网络已更新（容器已重建）');
      setNetEditOpen(false);
      fetchDetail();
    } catch (e: any) {
      showToast(`更新失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setNetSaving(false);
    }
  }

  /**
   * 打开端口映射编辑弹窗：以当前端口映射初始化草稿
   *
   * detail.ports 为 internal/published 格式（如 internal "80/tcp"），需要拆分出容器端口与协议；
   * published 取第一个 hostPort 作为宿主机端口。
   */
  function openPortEdit() {
    const entries = (detail?.ports || []).map((p) => {
      const [container, proto] = (p.internal || '').split('/');
      return {
        container: container || '',
        host: p.published && p.published.length > 0 ? String(p.published[0].hostPort) : '',
        protocol: (proto || 'tcp') as string,
      };
    });
    setPortDraft(entries.length ? entries : [{ container: '', host: '', protocol: 'tcp' }]);
    setPortEditOpen(true);
  }

  /**
   * 更新端口草稿中单个条目
   * @param index 端口索引
   * @param field 修改字段
   * @param value 新值
   */
  function updatePortDraft(index: number, field: 'container' | 'host' | 'protocol', value: string) {
    setPortDraft((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /**
   * 删除端口草稿中某个条目
   * @param index 端口索引
   */
  function removePortDraft(index: number) {
    setPortDraft((prev) => prev.filter((_, i) => i !== index));
  }

  /**
   * 新增一个端口映射条目
   */
  function addPortDraft() {
    setPortDraft((prev) => [...prev, { container: '', host: '', protocol: 'tcp' }]);
  }

  /**
   * 保存端口映射：过滤空项并组装 ports 数组（container 转数字）后重建容器
   */
  async function savePorts() {
    if (!id) return;
    // 过滤容器端口为空的条目，并组装 ports 数组
    const ports = portDraft
      .filter((item) => item.container.trim() !== '')
      .map((item) => ({
        host: item.host.trim(),
        container: Number(item.container.trim()),
        protocol: item.protocol,
      }));
    setPortSaving(true);
    try {
      await post(`/api/containers/${id}/recreate`, { ports });
      showToast('端口映射已更新（容器已重建）');
      setPortEditOpen(false);
      fetchDetail();
    } catch (e: any) {
      showToast(`更新失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setPortSaving(false);
    }
  }

  /**
   * 打开运行配置（重启策略 / 特权模式）编辑弹窗：以当前配置初始化草稿
   */
  function openCfgEdit() {
    setCfgRestartDraft(detail?.restartPolicy || 'no');
    setCfgPrivilegedDraft(!!detail?.privileged);
    setCfgEditOpen(true);
  }

  /**
   * 保存运行配置：更新重启策略与特权模式并重建容器
   */
  async function saveCfg() {
    if (!id) return;
    setCfgSaving(true);
    try {
      await post(`/api/containers/${id}/recreate`, {
        restartPolicy: cfgRestartDraft,
        privileged: cfgPrivilegedDraft,
      });
      showToast('运行配置已更新（容器已重建）');
      setCfgEditOpen(false);
      fetchDetail();
    } catch (e: any) {
      showToast(`更新失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setCfgSaving(false);
    }
  }

  /**
   * 删除容器（确认后执行，成功后返回列表）
   */
  async function confirmDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await del(`/api/containers/${id}`, { force: true, v: deleteVolumes });
      showToast('已删除容器');
      navigate('/containers');
    } catch (e: any) {
      showToast(`删除失败：${e?.message || '未知错误'}`, 'error');
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
      showToast('容器已重建');
      setRebuildOpen(false);
      await fetchDetail();
    } catch (e: any) {
      showToast(`重建失败：${e?.message || '未知错误'}`, 'error');
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
      showToast('容器配置已导出');
    } catch (e: any) {
      showToast(`导出失败：${e?.message || '未知错误'}`, 'error');
    }
  }

  /**
   * 打开历史日志查看弹窗
   */
  function openHistoryLogs() {
    setHistStart('');
    setHistEnd('');
    setHistLogs('');
    setHistOpen(true);
  }

  /**
   * 按时间范围拉取历史日志（后端 since/until 为 Unix 秒）
   */
  async function loadHistoryLogs() {
    if (!id) return;
    // 至少需要一个时间边界，否则无意义（等于全量）
    if (!histStart && !histEnd) {
      showToast('请指定开始或结束时间', 'error');
      return;
    }
    setHistLoading(true);
    try {
      const params: Record<string, any> = { tail: 0 };
      if (histStart) {
        params.since = Math.floor(new Date(histStart).getTime() / 1000);
      }
      if (histEnd) {
        params.until = Math.floor(new Date(histEnd).getTime() / 1000);
      }
      const res = await get<{ logs: string }>(`/api/containers/${id}/logs`, params);
      const text = res?.logs || '';
      setHistLogs(text.trim() ? text : '（该时间范围内无日志）');
    } catch (e: any) {
      showToast(`拉取历史日志失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setHistLoading(false);
    }
  }

  /**
   * 下载当前历史日志内容为文本文件
   */
  function downloadHistoryLogs() {
    if (!histLogs) return;
    const blob = new Blob([histLogs], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `history-logs-${id}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 打开提交为镜像弹窗，以当前容器镜像名作为默认 repo 前缀 */
  function openCommit() {
    const img = detail?.image || '';
    setCommitRepo(img || '');
    setCommitTag('latest');
    setCommitComment('');
    setCommitAuthor('');
    setCommitOpen(true);
  }

  /** 提交为镜像（确认后调用后端接口） */
  async function submitCommit() {
    if (!id) return;
    // repo 必填校验
    if (!commitRepo.trim()) {
      showToast('请填写镜像仓库名 repo', 'error');
      return;
    }
    setCommitting(true);
    try {
      const tag = commitTag.trim() || 'latest';
      const res = await post<any>(`/api/containers/${id}/commit`, {
        repo: commitRepo.trim(),
        tag,
        comment: commitComment.trim() || undefined,
        author: commitAuthor.trim() || undefined,
      });
      const image = res?.image || `${commitRepo.trim()}:${tag}`;
      showToast(`已生成镜像 ${image}`);
      setCommitOpen(false);
    } catch (e: any) {
      showToast(`提交失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setCommitting(false);
    }
  }

  /**
   * 打开克隆弹窗，预填 <原名>-clone 作为新名称，"创建后启动"默认开启
   */
  function openClone() {
    const name = detail?.name || '';
    setCloneValue(name ? `${name}-clone` : '');
    setCloneStart(true);
    setCloneOpen(true);
  }

  /**
   * 执行克隆：基于现有容器复制配置创建新容器，不删除原容器
   *
   * 成功后提示新容器名并刷新详情；失败时 toast 后端错误信息。
   */
  async function submitClone() {
    if (!id) return;
    // 新名称必填校验
    if (!cloneValue.trim()) {
      showToast('新名称不能为空', 'error');
      return;
    }
    setCloning(true);
    try {
      const res = await post<any>(`/api/containers/${id}/clone`, {
        name: cloneValue.trim(),
        start: cloneStart,
      });
      // 以后端返回的新容器名为准，缺省回退到输入框内容
      const clonedName = res?.name || cloneValue.trim();
      showToast(`已克隆为 ${clonedName}`);
      setCloneOpen(false);
      fetchDetail();
    } catch (e: any) {
      showToast(`克隆失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setCloning(false);
    }
  }

  /**
   * 打开执行命令弹窗，并清空上一次的命令输入与输出
   */
  function openExec() {
    setExecCmd('');
    setExecOutput('');
    setExecExitCode(null);
    setExecOpen(true);
  }

  /**
   * 在容器内执行单条命令（非交互式），展示 stdout/stderr 拼接输出与退出码
   *
   * 若容器未运行，后端返回 400「容器未运行」，此处仅弹 toast 提示。
   */
  async function submitExec() {
    if (!id) return;
    // 命令必填校验
    if (!execCmd.trim()) {
      showToast('请输入要执行的命令', 'error');
      return;
    }
    setExecuting(true);
    // 清空上一次输出，进入新一轮执行
    setExecOutput('');
    setExecExitCode(null);
    try {
      const res = await post<{ ok: boolean; exitCode: number | null; output: string }>(
        `/api/containers/${id}/exec`,
        { cmd: execCmd.trim() },
      );
      setExecOutput(res?.output || '');
      setExecExitCode(res?.exitCode ?? null);
    } catch (e: any) {
      // 容器未运行等后端口径错误，统一 toast 提示
      showToast(`执行失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setExecuting(false);
    }
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

  /** 资源监控网格数值 */
  const cpuValue = stats ? stats.cpuPercent.toFixed(1) + '%' : '-';
  const memValue = stats
    ? `${formatBytes(stats.memory.usage)} / ${formatBytes(stats.memory.limit)}`
    : '-';
  const netValue = stats ? `${formatBytes(stats.network.rx)} / ${formatBytes(stats.network.tx)}` : '-';

  if (loading) return <PageLoading />;

  return (
    <div className="detail-page">
      <div className="detail-page__top">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          ← 返回容器列表
        </Button>
        <div className="detail-page__title-row">
          <h1 className="detail-page__title" title={detail?.id}>
            {detail?.name || '容器详情'}
          </h1>
          {running && (
            <Button variant="secondary" size="sm" loading={restarting} onClick={handleRestart}>
              重启
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={openClone}>
            克隆
          </Button>
          <Button variant="secondary" size="sm" onClick={openCommit}>
            提交为镜像
          </Button>
          <Button variant="secondary" size="sm" onClick={openExec}>
            执行命令
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setRebuildOpen(true)}>
            重建
          </Button>
          <Button variant="secondary" size="sm" onClick={exportConfig}>
            导出配置
          </Button>
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
            删除
          </Button>
        </div>
      </div>

      {!detail ? (
        <Empty title="未找到容器" description="该容器可能已被删除或 ID 不正确" />
      ) : (
        <>
          {/* Tab 切换栏 */}
          <div className="detail-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`detail-tabs__item ${tab === t.key ? 'detail-tabs__item--active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 详情 Tab */}
          {tab === 'detail' && (
            <div className="detail-panel">
              {/* 基本信息 */}
              <Card
                title="基本信息"
                extra={
                  <Button variant="ghost" size="sm" onClick={openCfgEdit}>
                    运行配置
                  </Button>
                }
              >
                <div className="desc-grid">
                  <div className="desc-item">
                    <div className="desc-label">名称</div>
                    <div className="desc-value">{detail.name || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">镜像</div>
                    <div className="desc-value" title={detail.image}>
                      {detail.image || '-'}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">镜像 ID</div>
                    <div className="desc-value mono" title={detail.imageId}>
                      {detail.idShort || detail.id || '-'}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">状态</div>
                    <div className="desc-value">
                      <StatusBadge status={detail.state} />
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">命令</div>
                    <div className="desc-value mono">{detail.command || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">入口点</div>
                    <div className="desc-value mono">{detail.entrypoint || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">重启策略</div>
                    <div className="desc-value">{detail.restartPolicy || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">主机名</div>
                    <div className="desc-value mono">{detail.hostname || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">用户</div>
                    <div className="desc-value mono">{detail.user || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">工作目录</div>
                    <div className="desc-value mono">{detail.workingDir || '-'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">特权模式</div>
                    <div className="desc-value">{detail.privileged ? '是' : '否'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">自动移除</div>
                    <div className="desc-value">{detail.autoRemove ? '是' : '否'}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">创建时间</div>
                    <div className="desc-value">{formatTime(detail.created)}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">启动时间</div>
                    <div className="desc-value">{formatTime(detail.startedAt)}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">退出时间</div>
                    <div className="desc-value">{formatTime(detail.finishedAt)}</div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">已运行时长</div>
                    <div className="desc-value">
                      {running ? formatDuration(detail.startedAt) : '已停止'}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">重启次数</div>
                    <div className="desc-value mono">
                      {detail.restartCount ?? 0}
                    </div>
                  </div>
                  <div className="desc-item">
                    <div className="desc-label">退出码</div>
                    <div className="desc-value mono">{detail.exitCode ?? '-'}</div>
                  </div>
                </div>
              </Card>

              {/* 端口映射 */}
              <Card
                title="端口映射"
                extra={
                  <Button variant="ghost" size="sm" onClick={openPortEdit}>
                    编辑
                  </Button>
                }
              >
                {detail.ports && detail.ports.length > 0 ? (
                  <table className="detail-table">
                    <thead>
                      <tr>
                        <th>容器端口</th>
                        <th>宿主机映射</th>
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
                                  <span className="port-conflict__tag">端口冲突</span>
                                  <span className="port-conflict__owners">
                                    被 {conflicts.map((c) => c.containerName).join('、')} 占用
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
                  <Empty title="无端口映射" description="该容器未发布端口" />
                )}
              </Card>

              {/* 挂载卷 */}
              <Card
                title="挂载卷"
                extra={
                  <Button variant="ghost" size="sm" onClick={openMountEdit}>
                    编辑
                  </Button>
                }
              >
                {detail.mounts && detail.mounts.length > 0 ? (
                  <table className="detail-table">
                    <thead>
                      <tr>
                        <th>类型</th>
                        <th>来源</th>
                        <th>目标</th>
                        <th>读写</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.mounts.map((m, i) => (
                        <tr key={i}>
                          <td>{m.type || '-'}</td>
                          <td className="mono">{m.source || '-'}</td>
                          <td className="mono">{m.destination || '-'}</td>
                          <td>{m.rw ? '读写' : '只读'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty title="无挂载卷" description="该容器未挂载任何卷" />
                )}
              </Card>

              {/* 网络 */}
              <Card
                title="网络"
                extra={
                  <Button variant="ghost" size="sm" onClick={openNetEdit}>
                    编辑
                  </Button>
                }
              >
                {detail.networks && detail.networks.length > 0 ? (
                  <table className="detail-table">
                    <thead>
                      <tr>
                        <th>网络</th>
                        <th>IP 地址</th>
                        <th>网关</th>
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
                  <Empty title="无网络" description="该容器未连接到网络" />
                )}
              </Card>

              {/* 环境变量 */}
              <Card
                title="环境变量"
                extra={
                  <Button variant="ghost" size="sm" onClick={openEnvEdit}>
                    编辑
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
                  <Empty title="无环境变量" description="该容器未配置环境变量" />
                )}
              </Card>

              {/* 标签 */}
              <Card title="标签 (Labels)">
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
                  <Empty title="无标签" description="该容器未设置标签" />
                )}
              </Card>

              {/* 健康检查 */}
              {detail.health && (
                <Card title="健康检查">
                  <div className="desc-grid">
                    <div className="desc-item">
                      <div className="desc-label">状态</div>
                      <div className="desc-value">
                        <StatusBadge status={detail.health.status} />
                      </div>
                    </div>
                    <div className="desc-item">
                      <div className="desc-label">连续失败次数</div>
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
                          <pre className="health-log__output">{l.output || '(空输出)'}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )}
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
                  {connected ? '已连接实时日志' : '未连接'}
                  {error && <span className="log-error">（{error}）</span>}
                </div>
                <div className="log-toolbar__actions">
                  <label className="log-check">
                    <input
                      type="checkbox"
                      checked={autoScroll}
                      onChange={(e) => setAutoScroll(e.target.checked)}
                    />
                    自动滚动
                  </label>
                  {connected ? (
                    <Button variant="secondary" size="sm" onClick={handleDisconnect}>
                      断开
                    </Button>
                  ) : (
                    <Button variant="primary" size="sm" onClick={handleConnect}>
                      连接
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={clear}>
                    清空
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleDownloadLogs}>
                    下载
                  </Button>
                  <Button variant="secondary" size="sm" onClick={openHistoryLogs}>
                    历史
                  </Button>
                </div>
              </div>
              <div className="log-box" ref={logBoxRef} onScroll={onLogScroll}>
                {lines.length === 0 ? (
                  <div className="log-empty">暂无日志，点击「连接」开始拉取实时日志</div>
                ) : (
                  lines.map((l) => (
                    <div
                      key={l.id}
                      className={`log-line ${l.type === 'stderr' ? 'log-line--stderr' : ''}`}
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
              <div className="terminal-hint">终端在容器内启动交互式 shell；精简镜像或未运行的容器无法连接。</div>
              {!running ? (
                <div className="terminal-empty">
                  <div className="terminal-empty__icon">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 9l-4 3 4 3" />
                      <path d="M12 17h8" />
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                    </svg>
                  </div>
                  <div className="terminal-empty__title">容器当前未运行</div>
                  <div className="terminal-empty__desc">终端需要在容器内启动交互式 shell，请先启动容器后重试。</div>
                  <Button variant="primary" size="sm" loading={starting} onClick={handleStart}>
                    启动容器
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
                <Card title="CPU 使用率">
                  <div className="stat-value mono">{cpuValue}</div>
                </Card>
                <Card title="内存使用">
                  <div className="stat-value mono">{memValue}</div>
                </Card>
                <Card title="网络 收 / 发">
                  <div className="stat-value mono">{netValue}</div>
                </Card>
              </div>
              <Card title="资源曲线">
                <LineChart
                  series={[
                    { name: 'CPU %', color: '#6366f1', data: cpuHist },
                    { name: '内存 %', color: '#22c55e', data: memHist },
                  ]}
                  unit="%"
                  max={100}
                />
              </Card>
            </div>
          )}
        </>
      )}

      <Modal
        open={deleteOpen}
        title="删除容器"
        onClose={() => !deleting && setDeleteOpen(false)}
        width={440}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button variant="danger" size="md" onClick={confirmDelete} loading={deleting}>
              删除
            </Button>
          </div>
        }
      >
        <p className="confirm-dialog__message">
          确定要删除容器「{detail?.name || ''}」吗？此操作不可撤销。
        </p>
        <label className="vol-delete__option">
          <input
            type="checkbox"
            checked={deleteVolumes}
            onChange={(e) => setDeleteVolumes(e.target.checked)}
          />
          同时删除该容器的匿名卷（不影响具名卷）
        </label>
      </Modal>

      <ConfirmDialog
        open={rebuildOpen}
        title="重建容器"
        message={`确定要重建容器「${detail?.name || ''}」吗？将基于现有配置原样重新创建容器，过程会有短暂中断，且容器 ID 会改变。`}
        confirmText="重建"
        loading={rebuilding}
        onConfirm={confirmRebuild}
        onCancel={() => setRebuildOpen(false)}
      />

      {/* 历史日志查看弹窗（按时间范围分页拉取） */}
      <Modal
        open={histOpen}
        title="历史日志"
        onClose={() => !histLoading && setHistOpen(false)}
        width={760}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setHistOpen(false)} disabled={histLoading}>
              关闭
            </Button>
            <Button variant="secondary" size="md" onClick={downloadHistoryLogs} disabled={!histLogs}>
              下载结果
            </Button>
            <Button variant="primary" size="md" loading={histLoading} onClick={loadHistoryLogs}>
              拉取日志
            </Button>
          </div>
        }
      >
        <div className="histlog__range">
          <label className="histlog__field">
            <span>开始时间（含）</span>
            <input
              type="datetime-local"
              value={histStart}
              onChange={(e) => setHistStart(e.target.value)}
            />
          </label>
          <label className="histlog__field">
            <span>结束时间（含）</span>
            <input
              type="datetime-local"
              value={histEnd}
              onChange={(e) => setHistEnd(e.target.value)}
            />
          </label>
          <p className="histlog__tip">
            至少填写一个时间边界即可按时间范围拉取历史日志；留空表示不限制该边界。
          </p>
        </div>
        <div className="histlog__box">
          {histLogs ? (
            <pre className="histlog__content">{histLogs}</pre>
          ) : (
            <div className="histlog__empty">设置时间范围后点击「拉取日志」查看历史记录。</div>
          )}
        </div>
      </Modal>

      {/* 克隆容器弹窗 */}
      <Modal
        open={cloneOpen}
        title="克隆容器"
        onClose={() => !cloning && setCloneOpen(false)}
        width={520}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setCloneOpen(false)} disabled={cloning}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={cloning} onClick={submitClone}>
              克隆
            </Button>
          </div>
        }
      >
        <div className="env-modal__tip">
          基于「{detail?.name || ''}」复制配置并创建新容器，原容器保留不变。
        </div>
        <Field label="新名称" required>
          <Input
            placeholder="新容器名称"
            value={cloneValue}
            onChange={(e) => setCloneValue(e.target.value)}
            autoFocus
            disabled={cloning}
          />
        </Field>
        <label className="clone-modal__start">
          <input
            type="checkbox"
            checked={cloneStart}
            onChange={(e) => setCloneStart(e.target.checked)}
            disabled={cloning}
          />
          创建后启动
        </label>
      </Modal>

      {/* 提交为镜像弹窗 */}
      <Modal
        open={commitOpen}
        title="提交为镜像"
        onClose={() => !committing && setCommitOpen(false)}
        width={520}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setCommitOpen(false)} disabled={committing}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={committing} onClick={submitCommit}>
              提交
            </Button>
          </div>
        }
      >
        <div className="env-modal__tip">
          将容器当前的文件系统状态打包成一个新镜像（commit）。原容器不会被删除。
        </div>
        <Field label="仓库名 repo" required hint="例如：myapp 或 registry.local/myapp">
          <Input
            placeholder="镜像仓库名"
            value={commitRepo}
            onChange={(e) => setCommitRepo(e.target.value)}
            disabled={committing}
          />
        </Field>
        <Field label="标签 tag" hint="默认 latest">
          <Input
            placeholder="latest"
            value={commitTag}
            onChange={(e) => setCommitTag(e.target.value)}
            disabled={committing}
          />
        </Field>
        <Field label="提交说明 comment">
          <Input
            placeholder="可选提交说明"
            value={commitComment}
            onChange={(e) => setCommitComment(e.target.value)}
            disabled={committing}
          />
        </Field>
        <Field label="作者 author">
          <Input
            placeholder="可选作者"
            value={commitAuthor}
            onChange={(e) => setCommitAuthor(e.target.value)}
            disabled={committing}
          />
        </Field>
      </Modal>

      {/* 环境变量编辑弹窗（通过重建容器生效） */}
      <Modal
        open={envEditOpen}
        title="编辑环境变量"
        onClose={() => !envSaving && setEnvEditOpen(false)}
        width={620}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setEnvEditOpen(false)} disabled={envSaving}>
              取消
            </Button>
            <Button type="submit" variant="primary" size="md" loading={envSaving} onClick={saveEnv}>
              保存并重建
            </Button>
          </div>
        }
      >
        <div className="env-modal__tip">
          修改环境变量需重新创建容器（保留镜像、端口、挂载、网络等配置）。重建会导致容器短暂中断，容器 ID 会改变。
        </div>
        <div className="env-modal__list">
          {envDraft.map((item, index) => (
            <div className="env-modal__row" key={index}>
              <Input
                className="env-modal__key"
                placeholder="变量名"
                value={item.key}
                onChange={(e) => updateEnvDraft(index, 'key', e.target.value)}
              />
              <Input
                className="env-modal__value"
                placeholder="变量值"
                value={item.value}
                onChange={(e) => updateEnvDraft(index, 'value', e.target.value)}
              />
              <Button
                variant="ghost"
                size="sm"
                className="env-modal__del"
                onClick={() => removeEnvDraft(index)}
                disabled={envSaving}
                title="删除这项"
              >
                删除
              </Button>
            </div>
          ))}
        </div>
        <div className="env-modal__add">
          <Button variant="secondary" size="sm" onClick={addEnvDraft} disabled={envSaving}>
            + 添加环境变量
          </Button>
        </div>
      </Modal>

      {/* 挂载卷编辑弹窗（通过重建容器生效） */}
      <Modal
        open={mountEditOpen}
        title="编辑挂载卷"
        onClose={() => !mountSaving && setMountEditOpen(false)}
        width={640}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setMountEditOpen(false)} disabled={mountSaving}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={mountSaving} onClick={saveMounts}>
              保存并重建
            </Button>
          </div>
        }
      >
        <div className="env-modal__tip">
          修改挂载卷需重新创建容器（保留镜像、端口、网络、环境变量等配置）。「来源」为宿主机路径或已存在的卷名，「目标」为容器内路径。
        </div>
        <div className="mount-modal__head">
          <span className="mount-modal__col-source">来源</span>
          <span className="mount-modal__col-dst">容器内路径</span>
          <span className="mount-modal__col-rw">读写</span>
          <span className="mount-modal__col-op" />
        </div>
        <div className="mount-modal__list">
          {mountDraft.map((item, index) => (
            <div className="mount-modal__row" key={index}>
              <Input
                className="mount-modal__col-source"
                placeholder="宿主机路径或卷名"
                value={item.source}
                onChange={(e) => updateMountDraft(index, 'source', e.target.value)}
              />
              <Input
                className="mount-modal__col-dst"
                placeholder="/容器/路径"
                value={item.destination}
                onChange={(e) => updateMountDraft(index, 'destination', e.target.value)}
              />
              <label className="mount-modal__rw">
                <input
                  type="checkbox"
                  checked={item.rw}
                  onChange={(e) => updateMountDraft(index, 'rw', e.target.checked)}
                />
              </label>
              <Button
                variant="ghost"
                size="sm"
                className="mount-modal__col-op"
                onClick={() => removeMountDraft(index)}
                disabled={mountSaving}
                title="删除这项挂载"
              >
                删除
              </Button>
            </div>
          ))}
        </div>
        <div className="env-modal__add">
          <Button variant="secondary" size="sm" onClick={addMountDraft} disabled={mountSaving}>
            + 添加挂载
          </Button>
        </div>
      </Modal>

      {/* 网络编辑弹窗（通过重建容器生效） */}
      <Modal
        open={netEditOpen}
        title="选择网络"
        onClose={() => !netSaving && setNetEditOpen(false)}
        width={520}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setNetEditOpen(false)} disabled={netSaving}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={netSaving} onClick={saveNet}>
              保存并重建
            </Button>
          </div>
        }
      >
        <div className="env-modal__tip">
          切换网络需重新创建容器（保留镜像、端口、挂载、环境变量等配置）。重建会导致容器短暂中断，容器 ID 会改变。
        </div>
        <Field label="网络" required>
          <Select value={netDraft} onChange={(e) => setNetDraft(e.target.value)}>
            <option value="bridge">bridge（默认桥接）</option>
            <option value="host">host（使用宿主机网络）</option>
            <option value="none">none（禁用网络）</option>
            {netOptions.map((n) => (
              <option key={n.Name} value={n.Name}>
                {n.Name}（{n.Driver}）
              </option>
            ))}
          </Select>
        </Field>
      </Modal>

      {/* 端口映射编辑弹窗（通过重建容器生效） */}
      <Modal
        open={portEditOpen}
        title="编辑端口映射"
        onClose={() => !portSaving && setPortEditOpen(false)}
        width={640}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setPortEditOpen(false)} disabled={portSaving}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={portSaving} onClick={savePorts}>
              保存并重建
            </Button>
          </div>
        }
      >
        <div className="env-modal__tip">
          修改端口映射需重新创建容器（保留镜像、挂载、网络、环境变量等配置）。「容器端口」为容器内端口，「宿主机端口」为外部访问端口，未填写宿主端口时将以容器端口随机映射。
        </div>
        <div className="port-modal__head">
          <span className="port-modal__col-container">容器端口</span>
          <span className="port-modal__col-host">宿主机端口</span>
          <span className="port-modal__col-protocol">协议</span>
          <span className="port-modal__col-op" />
        </div>
        <div className="port-modal__list">
          {portDraft.map((item, index) => (
            <div className="port-modal__row" key={index}>
              <Input
                className="port-modal__col-container"
                placeholder="80"
                value={item.container}
                onChange={(e) => updatePortDraft(index, 'container', e.target.value)}
              />
              <Input
                className="port-modal__col-host"
                placeholder="8080（可选）"
                value={item.host}
                onChange={(e) => updatePortDraft(index, 'host', e.target.value)}
              />
              <Select
                className="port-modal__col-protocol"
                value={item.protocol}
                onChange={(e) => updatePortDraft(index, 'protocol', e.target.value)}
              >
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                className="port-modal__col-op"
                onClick={() => removePortDraft(index)}
                disabled={portSaving}
                title="删除这项端口"
              >
                删除
              </Button>
            </div>
          ))}
        </div>
        <div className="env-modal__add">
          <Button variant="secondary" size="sm" onClick={addPortDraft} disabled={portSaving}>
            + 添加端口
          </Button>
        </div>
      </Modal>

      {/* 运行配置编辑弹窗（重启策略 / 特权模式，通过重建容器生效） */}
      <Modal
        open={cfgEditOpen}
        title="运行配置"
        onClose={() => !cfgSaving && setCfgEditOpen(false)}
        width={520}
        footer={
          <div className="env-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setCfgEditOpen(false)} disabled={cfgSaving}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={cfgSaving} onClick={saveCfg}>
              保存并重建
            </Button>
          </div>
        }
      >
        <div className="env-modal__tip">
          修改重启策略或特权模式需重新创建容器（保留镜像、端口、挂载、网络、环境变量等配置）。重建会导致容器短暂中断，容器 ID 会改变。
        </div>
        <Field label="重启策略" required>
          <Select value={cfgRestartDraft} onChange={(e) => setCfgRestartDraft(e.target.value)}>
            <option value="no">no（不自动重启）</option>
            <option value="always">always（总是重启）</option>
            <option value="on-failure">on-failure（失败时重启）</option>
            <option value="unless-stopped">unless-stopped（除非停止，否则重启）</option>
          </Select>
        </Field>
        <Field label="特权模式">
          <label className="cfg-modal__priv">
            <input
              type="checkbox"
              checked={cfgPrivilegedDraft}
              onChange={(e) => setCfgPrivilegedDraft(e.target.checked)}
            />
            以特权模式运行（授予容器更多 host 权限）
          </label>
        </Field>
      </Modal>
    </div>
  );
}
