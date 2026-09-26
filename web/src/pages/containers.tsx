/**
 * 容器列表页
 *
 * 拉取 /api/containers?all=true 容器列表，支持状态本地筛选，
 * 提供启动 / 停止 / 重启 / 删除等行操作（删除需二次确认）。
 */
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, del } from '../api/client';
import { canOperate } from '../api/auth';
import {
  ContainerListItem,
  ContainerPortConflicts,
  ContainerTransferResult,
  EngineListItem,
  EngineListResponse,
  ImageItem,
} from '../types';
import Button from '../components/Button';
import Card from '../components/Card';
import StatusBadge from '../components/StatusBadge';
import StateActions, { type ContainerAction } from '../components/StateActions';
import MoreMenu from '../components/MoreMenu';
import Empty from '../components/Empty';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import { Field, Input, Select } from '../components/Form';
import { PageLoading } from '../components/Loading';
import { useToast } from '../components/Toast';
import ComposeInferModal from '../components/ComposeInferModal';
import CreateContainerModal, { type CreateSeed } from '../components/CreateContainerModal';
import ContainerLogModal from '../components/ContainerLogModal';
import { useLang } from '../i18n';
import './containers.less';

/** 状态筛选选项 */
type Filter = 'all' | 'running' | 'stopped';

/** 批量操作类型 */
type BatchAction = 'start' | 'stop' | 'restart' | 'delete' | 'update';

/** 列表排序键 */
type SortKey = 'name' | 'status' | 'created' | 'cpu' | 'mem';

/** 单容器实时资源统计（对齐后端 /stats 返回结构） */
interface ContainerStat {
  cpuPercent: number;
  memory: { usage: number; limit: number; percent: number };
}

interface DeleteTarget {
  id: string;
  name: string;
}

/** 跨引擎迁移弹窗中的目标容器源信息（源容器 = 容器所在引擎） */
interface MigrateTarget {
  id: string;
  name: string;
  image: string;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50];

/**
 * 容器列表页组件
 */
export default function ContainersPage() {
  const { t } = useLang();
  const { showToast } = useToast();
  const navigate = useNavigate();
  // 容器生命周期操作权限：后端已放开给 operator（admin 或 operator 均可管理容器生命周期）
  const canDelete = canOperate();
  const [list, setList] = useState<ContainerListItem[]>([]);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  // 按镜像筛选：'' 表示不过滤，值如 'nginx:latest'
  const [imageFilter, setImageFilter] = useState('');
  // 按标签筛选：'' 表示不过滤，值如 'com.docker.compose.project=web'（key=value 完整对）
  const [labelFilter, setLabelFilter] = useState('');
  const [page, setPage] = useState(1);
  // 每页条数（可在运行时切换）
  const [pageSize, setPageSize] = useState(10);
  // 分页跳转：输入的目标页码
  const [pageJump, setPageJump] = useState('');
  // 排序：sortKey 为 名称/状态/创建/CPU/内存；sortDir 升序或降序
  const [sortKey, setSortKey] = useState<SortKey>('created');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inferOpen, setInferOpen] = useState(false);
  // 折叠的 Compose 组合键集合（key 结构见 composeGroupKey）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // 正在执行分组批量操作的组合键（用于按钮 loading 态）
  const [groupActionKey, setGroupActionKey] = useState<string | null>(null);
  const [batchAction, setBatchAction] = useState<BatchAction | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  // 批量「编辑资源」弹窗状态：CPU 核数 / 内存 GB（留空=不修改），loading 控制提交中
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchEditCpu, setBatchEditCpu] = useState('');
  const [batchEditMem, setBatchEditMem] = useState('');
  const [batchEditLoading, setBatchEditLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 重命名弹窗状态
  const [renameTarget, setRenameTarget] = useState<DeleteTarget | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  // 克隆弹窗状态
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<DeleteTarget | null>(null);
  const [cloneValue, setCloneValue] = useState('');
  const [cloning, setCloning] = useState(false);
  // 跨引擎迁移弹窗状态
  const [migrateTarget, setMigrateTarget] = useState<MigrateTarget | null>(null);
  // 引擎列表（来自 GET /api/engines，含当前引擎与其它引擎）
  const [engineList, setEngineList] = useState<EngineListItem[]>([]);
  // 迁移弹窗中选中的目标引擎 id
  const [migrateTargetId, setMigrateTargetId] = useState('');
  // 目标容器名（留空自动沿用原名）
  const [migrateName, setMigrateName] = useState('');
  // 「迁移后启动」开关（默认开启）
  const [migrateStart, setMigrateStart] = useState(true);
  // 迁移提交是否进行中
  const [migrating, setMigrating] = useState(false);
  // 单独记录"正在迁移"的容器 id，用于该行迁移按钮独立 loading
  const [, setMigratingId] = useState('');
  // 迁移完成后的结果展示（成功时包含 name / imageTransferred / note 等）
  const [migrateResult, setMigrateResult] = useState<ContainerTransferResult | null>(null);
  // 宿主机端口占用冲突映射（HostPort -> 容器列表）
  const [portConflicts, setPortConflicts] = useState<ContainerPortConflicts>({});
  // 容器实时资源统计（containerId -> {cpuPercent, memory}），轮询更新
  const [statsMap, setStatsMap] = useState<Record<string, ContainerStat>>({});
  // 清理未使用资源弹窗状态
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruning, setPruning] = useState(false);

  // 创建容器弹窗：仅持有打开意图，表单/模板/端口检测逻辑在 CreateContainerModal 内部（1.92.0 拆分）
  const [createSeed, setCreateSeed] = useState<CreateSeed | null>(null);
  // 导入配置的文件输入引用（「导入配置」按钮触发，解析后交给 CreateContainerModal 回填）
  const importFileRef = useRef<HTMLInputElement>(null);

  // 日志查看弹窗：仅持有目标容器，内容与交互逻辑在 ContainerLogModal 内部（1.92.0 拆分）
  const [logTarget, setLogTarget] = useState<{ id: string; name: string } | null>(null);

  // 编辑镜像弹窗状态
  const [editImageOpen, setEditImageOpen] = useState(false);
  const [editImageTarget, setEditImageTarget] = useState<DeleteTarget | null>(null);
  const [editImageValue, setEditImageValue] = useState('');
  const [editImageSaving, setEditImageSaving] = useState(false);
  // 可用镜像下拉选项（本地镜像标签列表）
  const [imageList, setImageList] = useState<string[]>([]);
  // 可搜索下拉：过滤关键字 与 面板展开状态
  const [editImageSearch, setEditImageSearch] = useState('');
  const [editImageDropdownOpen, setEditImageDropdownOpen] = useState(false);

  /**
   * 拉取容器列表
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<ContainerListItem[]>('/api/containers', { all: true });
      const data = res || [];
      setList(data);
      setLoadError('');
      // 刷新后清除已不存在的选中项（如已删除的容器）
      setSelectedIds((prev) => {
        const ids = new Set(data.map((c) => c.Id));
        return prev.filter((id) => ids.has(id));
      });
    } catch (e: any) {
      setLoadError(e?.message || t('获取容器列表失败'));
      showToast(e?.message || t('获取容器列表失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  /**
   * 打开容器日志查看弹窗（内容与交互逻辑在 ContainerLogModal 内部，挂载即拉取）
   * @param id 容器 ID
   * @param name 容器名称
   */
  function openLogs(id: string, name: string) {
    setLogTarget({ id, name });
  }

  /**
   * 拉取 Docker 引擎列表（GET /api/engines），用于判断是否存在可迁移的其它引擎候选。
   * 拉取失败时静默置空，不阻塞容器列表展示。
   */
  const loadEngines = useCallback(async () => {
    try {
      const res = await get<EngineListResponse>('/api/engines');
      setEngineList(res?.engines || []);
    } catch {
      setEngineList([]);
    }
  }, []);

  /**
   * 拉取宿主机端口占用冲突映射，用于对冲突端口做红色警示
   */
  const loadPortConflicts = useCallback(async () => {
    try {
      const res = await get<ContainerPortConflicts>('/api/containers/ports');
      setPortConflicts(res || {});
    } catch {
      // 拉取端口冲突失败不阻塞列表展示
      setPortConflicts({});
    }
  }, []);

  useEffect(() => {
    load();
    loadPortConflicts();
    loadEngines();
  }, [load, loadPortConflicts, loadEngines]);

  /**
   * 拉取全部运行中容器的实时资源统计（批量 stats）
   */
  const loadStats = useCallback(async () => {
    try {
      const res = await get<Record<string, ContainerStat>>('/api/containers/stats');
      setStatsMap(res || {});
    } catch {
      // stats 拉取失败不阻塞列表展示
    }
  }, []);

  // 每 3 秒轮询一次运行中容器的 CPU/内存
  useEffect(() => {
    loadStats();
    const timer = setInterval(loadStats, 3000);
    return () => clearInterval(timer);
  }, [loadStats]);

  /** 状态筛选后的列表 */
  const stateFiltered =
    filter === 'running'
      ? list.filter((c) => c.State === 'running')
      : filter === 'stopped'
        ? list.filter((c) => c.State !== 'running')
        : list;

  /**
   * 搜索过滤：按 容器名 / 镜像名 / ID 模糊匹配（不区分大小写）
   * @param c 容器项
   * @returns 是否命中搜索关键字
   */
  function matchSearch(c: ContainerListItem): boolean {
    const kw = search.trim().toLowerCase();
    if (!kw) return true;
    const name = displayName(c).toLowerCase();
    const image = (c.Image || '').toLowerCase();
    const id = (c.Id || '').toLowerCase();
    return name.includes(kw) || image.includes(kw) || id.includes(kw);
  }

  /** 镜像下拉选项：从容器列表提取唯一镜像名 */
  const imageOptions = Array.from(
    new Set((list || []).map((c) => c.Image).filter(Boolean))
  ) as string[];
  imageOptions.sort((a, b) => a.localeCompare(b));

  /** 按镜像过滤后的列表 */
  const imageFiltered = imageFilter
    ? stateFiltered.filter((c) => c.Image === imageFilter)
    : stateFiltered;

  /** 标签下拉选项：聚合容器列表中的全部 key=value 标签，按使用次数降序 */
  const labelOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of list || []) {
      const labels = c.Labels || {};
      for (const [k, v] of Object.entries(labels)) {
        const pair = `${k}=${v ?? ''}`;
        counts.set(pair, (counts.get(pair) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([pair]) => pair);
  }, [list]);

  /** 按标签过滤后的列表（标签值需精确匹配 key=value 对） */
  const labelFiltered = labelFilter
    ? imageFiltered.filter((c) => {
        const idx = labelFilter.indexOf('=');
        const key = labelFilter.slice(0, idx);
        const value = labelFilter.slice(idx + 1);
        return (c.Labels || {})[key] === value;
      })
    : imageFiltered;

  /** 搜索过滤后的列表 */
  const filteredList = labelFiltered.filter(matchSearch);

  /**
   * 排序比较函数：按当前 sortKey/sortDir 对容器排序。
   * CPU/内存使用 statsMap 实时值，缺失值按 0 处理。
   */
  const sortedList = useMemo(() => {
    const arr = [...filteredList];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let va: number | string = 0;
      let vb: number | string = 0;
      switch (sortKey) {
        case 'name':
          va = displayName(a).toLowerCase();
          vb = displayName(b).toLowerCase();
          return va < vb ? -dir : va > vb ? dir : 0;
        case 'status':
          va = a.State || '';
          vb = b.State || '';
          return va < vb ? -dir : va > vb ? dir : 0;
        case 'cpu':
          va = Number(statsMap[a.Id]?.cpuPercent || 0);
          vb = Number(statsMap[b.Id]?.cpuPercent || 0);
          return (va - vb) * dir;
        case 'mem':
          va = Number(statsMap[a.Id]?.memory?.percent || 0);
          vb = Number(statsMap[b.Id]?.memory?.percent || 0);
          return (va - vb) * dir;
        case 'created':
        default:
          va = a.Created || 0;
          vb = b.Created || 0;
          return (va - vb) * dir;
      }
    });
    return arr;
  }, [filteredList, sortKey, sortDir, statsMap]);

  /** 切换排序：同列点击切换方向，新列默认降序 */
  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(1);
  }

  /** 表头排序指示字符 */
  function sortIndicator(key: SortKey): string {
    if (sortKey !== key) return '⇅';
    return sortDir === 'asc' ? '↑' : '↓';
  }

  /**
   * 计算页码按钮的滑动窗口：首页/末页 + 当前页±1 恒定展示，
   * 中间断档以省略号占位，避免容器很多时渲染成百上千个页码按钮。
   * @param total 总页数
   * @param cur 当前页
   * @returns 页码与省略号标记的渲染序列
   */
  function buildPageWindow(total: number, cur: number): Array<number | 'ellipsis'> {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = new Set<number>([1, 2, cur - 1, cur, cur + 1, total - 1, total]);
    const sorted = Array.from(pages)
      .filter((p) => p >= 1 && p <= total)
      .sort((a, b) => a - b);
    const out: Array<number | 'ellipsis'> = [];
    let prev = 0;
    for (const p of sorted) {
      if (p - prev > 1) out.push('ellipsis');
      out.push(p);
      prev = p;
    }
    return out;
  }

  /** 总页数 */
  const totalPages = Math.max(1, Math.ceil(sortedList.length / pageSize));

  /** 页码按钮渲染序列（滑动窗口） */
  const pageButtons = buildPageWindow(totalPages, page);

  /**
   * 切换每页条数：重置到第一页并清空跳转输入
   * @param size 新的每页条数
   */
  function changePageSize(size: number) {
    setPageSize(size);
    setPage(1);
    setPageJump('');
  }

  /**
   * 跳转到指定页码（限制在有效范围内）
   */
  function handlePageJump() {
    const n = parseInt(pageJump, 10);
    if (isNaN(n)) {
      setPageJump('');
      return;
    }
    const target = Math.min(Math.max(1, n), totalPages);
    setPage(target);
    setPageJump('');
  }

  /** 当前页容器的起止（含） */
  const pageStart = sortedList.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const pageEnd = Math.min(page * pageSize, sortedList.length);

  /** 当前页展示的容器列表 */
  const pageItems = sortedList.slice((page - 1) * pageSize, page * pageSize);

  /**
   * 将当前页容器按 Compose 归属分组为「分组头 + 成员行」的渲染序列。
   * 同一 Compose 项目的全部容器（无论是否相邻）在组内首次出现处归入同一个分组；
   * 单个容器直接作为普通行渲染。
   * 分组折叠与否在渲染时由 collapsedGroups 决定（折叠时隐藏成员行、保留分组头）。
   */
  const renderRows = useMemo(() => {
    const rows: Array<
      | { type: 'group'; key: string; label: string; members: ContainerListItem[] }
      | { type: 'row'; data: ContainerListItem }
    > = [];
    const emitted = new Set<string>();
    for (const c of pageItems) {
      const key = composeGroupKey(c);
      if (!key) {
        rows.push({ type: 'row', data: c });
        continue;
      }
      if (emitted.has(key)) continue;
      emitted.add(key);
      const members = pageItems.filter((x) => composeGroupKey(x) === key);
      rows.push({ type: 'group', key, label: composeGroupLabel(key), members });
    }
    return rows;
  }, [pageItems]);

  /** 是否所有当前页容器均被选中 */
  const allChecked = pageItems.length > 0 && pageItems.every((c) => selectedIds.includes(c.Id));

  /** 全选/取消全选当前页 */
  function toggleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageItems.forEach((c) => next.add(c.Id));
        return Array.from(next);
      });
    } else {
      setSelectedIds((prev) => prev.filter((id) => !pageItems.some((c) => c.Id === id)));
    }
  }

  /** 切换单个容器选中状态 */
  function toggleSelect(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** 刷新列表并提示 */
  async function handleRefresh() {
    await load();
    showToast(t('已刷新'));
  }

  /** 启动容器 */
  async function handleStart(id: string, name: string) {
    try {
      await post(`/api/containers/${id}/start`);
      showToast(t('已启动 {{name}}', { name }));
      load();
    } catch (e: any) {
      showToast(t('启动失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    }
  }

  /** 停止容器 */
  async function handleStop(id: string, name: string) {
    try {
      await post(`/api/containers/${id}/stop`);
      showToast(t('已停止 {{name}}', { name }));
      load();
    } catch (e: any) {
      showToast(t('停止失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    }
  }

  /** 重启容器 */
  async function handleRestart(id: string, name: string) {
    try {
      await post(`/api/containers/${id}/restart`);
      showToast(t('已重启 {{name}}', { name }));
      load();
    } catch (e: any) {
      showToast(t('重启失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    }
  }

  /** 强制停止容器（SIGKILL，跳过优雅退出流程） */
  async function handleKill(id: string, name: string) {
    try {
      await post(`/api/containers/${id}/kill`);
      showToast(t('已强制停止 {{name}}', { name }));
      load();
    } catch (e: any) {
      showToast(t('强制停止失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    }
  }

  /** 打开重命名弹窗，以当前名称初始化输入框 */
  function openRename(id: string, name: string) {
    if (!canDelete) {
      showToast(t('仅管理员可重命名容器'), 'error');
      return;
    }
    setRenameTarget({ id, name });
    setRenameValue(name);
  }

  /** 执行重命名（确认后调用后端接口） */
  async function confirmRename() {
    if (!renameTarget) return;
    if (!canDelete) {
      showToast(t('仅管理员可重命名容器'), 'error');
      setRenameTarget(null);
      return;
    }
    const newName = renameValue.trim();
    // 名称必填与未变更校验
    if (!newName) {
      showToast(t('新名称不能为空'), 'error');
      return;
    }
    if (newName === renameTarget.name) {
      showToast(t('名称未发生变化'), 'error');
      return;
    }
    setRenaming(true);
    try {
      await post(`/api/containers/${renameTarget.id}/rename`, { name: newName });
      showToast(t('已重命名为 {{newName}}', { newName }));
      setRenameTarget(null);
      load();
      loadPortConflicts();
    } catch (e: any) {
      showToast(t('重命名失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setRenaming(false);
    }
  }

  /** 打开克隆弹窗，预填 <原名>-clone 作为新名称 */
  function openClone(id: string, name: string) {
    if (!canDelete) {
      showToast(t('仅管理员可克隆容器'), 'error');
      return;
    }
    setCloneTarget({ id, name });
    setCloneValue(`${name}-clone`);
    setCloneOpen(true);
  }

  /** 执行克隆（确认后调用后端接口） */
  async function confirmClone() {
    if (!cloneTarget) return;
    if (!canDelete) {
      showToast(t('仅管理员可克隆容器'), 'error');
      setCloneTarget(null);
      return;
    }
    const newName = cloneValue.trim();
    // 名称必填校验
    if (!newName) {
      showToast(t('新名称不能为空'), 'error');
      return;
    }
    setCloning(true);
    try {
      const res = await post<any>(`/api/containers/${cloneTarget.id}/clone`, { name: newName });
      const clonedName = res?.name || newName;
      showToast(t('已克隆为 {{clonedName}}', { clonedName }));
      setCloneTarget(null);
      load();
      loadPortConflicts();
    } catch (e: any) {
      showToast(t('克隆失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setCloning(false);
    }
  }

  /** 当前引擎（容器所在引擎，作为迁移源引擎） */
  const currentEngine = engineList.find((e) => e.isCurrent);
  /** 其它引擎（除当前引擎外的所有引擎，可作为迁移目标候选） */
  const otherEngines = engineList.filter((e) => e.id !== currentEngine?.id);
  /** 是否存在至少一个可迁移的目标引擎 */
  const hasMigrateTarget = otherEngines.length >= 1;

  /**
   * 打开跨引擎迁移弹窗：记录源容器信息，预填充迁移选项并刷新引擎列表。
   * @param c 要迁移的容器
   */
  async function openMigrate(c: ContainerListItem) {
    if (!canDelete) {
      showToast(t('仅管理员或运维人员可迁移容器'), 'error');
      return;
    }
    const name = displayName(c);
    setMigrateTarget({ id: c.Id, name, image: c.Image || '' });
    setMigrateName('');
    setMigrateStart(true);
    setMigrateResult(null);
    setMigrating(false);
    setMigratingId('');
    // 打开弹窗时重新拉取引擎列表，保证目标引擎候选最新
    try {
      const res = await get<EngineListResponse>('/api/engines');
      const list = res?.engines || [];
      setEngineList(list);
      // 默认选择第一个非当前引擎作为目标
      const cur = list.find((e) => e.isCurrent);
      const others = list.filter((e) => e.id !== cur?.id);
      setMigrateTargetId(others[0]?.id || '');
    } catch (e: any) {
      showToast(e?.message || t('加载引擎列表失败'), 'error');
    }
  }

  /**
   * 提交跨引擎迁移请求（POST /api/transfer/container）。
   * 校验目标引擎合法后发起，成功展示结果并提示可到目标引擎查看，失败 toast 展示 error。
   */
  async function confirmMigrate() {
    if (!migrateTarget) return;
    if (!canDelete) {
      showToast(t('仅管理员或运维人员可迁移容器'), 'error');
      setMigrateTarget(null);
      return;
    }
    if (!currentEngine?.id) {
      showToast(t('无法识别当前引擎'), 'error');
      return;
    }
    if (!migrateTargetId) {
      showToast(t('请选择目标引擎'), 'error');
      return;
    }
    if (migrateTargetId === currentEngine.id) {
      showToast(t('源引擎与目标引擎不能相同'), 'error');
      return;
    }
    setMigrating(true);
    setMigratingId(migrateTarget.id);
    try {
      const res = await post<ContainerTransferResult>('/api/transfer/container', {
        containerId: migrateTarget.id,
        sourceEngineId: currentEngine.id,
        targetEngineId: migrateTargetId,
        newName: migrateName.trim() || undefined,
        start: migrateStart,
      });
      if (!res?.ok) {
        throw new Error(res?.error || t('容器迁移失败'));
      }
      // 成功：toast 提示并展示结果
      setMigrateResult(res);
      const startedText = res.started ? t('并已启动') : res.started === false ? t('（未启动）') : '';
      showToast(t('容器已迁移至目标引擎{{startedText}}', { startedText }));
      load();
    } catch (e: any) {
      showToast(e?.message || t('容器迁移失败'), 'error');
    } finally {
      setMigrating(false);
      setMigratingId('');
    }
  }

  /**
   * 拉取本地镜像标签列表，用于"编辑镜像"弹窗的可选镜像下拉
   */
  const loadImageOptions = useCallback(async () => {
    try {
      const res = await get<ImageItem[]>('/api/images');
      const tags = (res || [])
        .flatMap((img) => img.RepoTags || [])
        .filter((t) => t && !t.startsWith('<none>'))
        .sort((a, b) => a.localeCompare(b));
      setImageList(tags);
    } catch {
      // 拉取镜像列表失败不阻塞，弹窗内仍可手动输入
      setImageList([]);
    }
  }, []);

  /**
   * 打开编辑镜像弹窗：预填当前镜像，并刷新可选镜像列表
   * @param id 容器 ID
   * @param name 容器名
   * @param currentImage 当前镜像
   */
  function openEditImage(id: string, name: string, currentImage: string) {
    setEditImageTarget({ id, name });
    setEditImageValue(currentImage);
    setEditImageSearch('');
    setEditImageDropdownOpen(false);
    setEditImageOpen(true);
    loadImageOptions();
  }

  /**
   * 按关键字过滤镜像下拉选项（不区分大小写）
   * @returns 过滤后的镜像列表
   */
  function filteredImageOptions(): string[] {
    const kw = editImageSearch.trim().toLowerCase();
    const base = imageList.includes(editImageValue) ? imageList : [editImageValue, ...imageList];
    const unique = Array.from(new Set(base)).filter(Boolean);
    if (!kw) return unique;
    return unique.filter((t) => t.toLowerCase().includes(kw));
  }

  /**
   * 从下拉列表中选择一个镜像：填入并以它作为当前选择，收起面板并清空过滤词
   * @param image 选中的镜像
   */
  function chooseEditImage(image: string) {
    setEditImageValue(image);
    setEditImageSearch('');
    setEditImageDropdownOpen(false);
  }

  /**
   * 提交替换镜像：基于现有容器重建，仅替换镜像，其余配置（端口、挂载、网络、环境变量等）保留
   */
  async function confirmEditImage() {
    if (!editImageTarget) return;
    if (!canDelete) {
      showToast(t('仅管理员可替换容器镜像'), 'error');
      setEditImageTarget(null);
      setEditImageOpen(false);
      return;
    }
    const newImage = editImageValue.trim();
    // 镜像必填校验
    if (!newImage) {
      showToast(t('请填写或选择新镜像'), 'error');
      return;
    }
    setEditImageSaving(true);
    try {
      await post(`/api/containers/${editImageTarget.id}/recreate`, { image: newImage });
      showToast(t('已替换镜像为 {{newImage}}', { newImage }));
      setEditImageOpen(false);
      load();
      loadPortConflicts();
    } catch (e: any) {
      showToast(t('替换镜像失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setEditImageSaving(false);
    }
  }

  /** 暂停容器 */
  async function handlePause(id: string, name: string) {
    try {
      await post(`/api/containers/${id}/pause`);
      showToast(t('已暂停 {{name}}', { name }));
      load();
      loadPortConflicts();
    } catch (e: any) {
      showToast(t('暂停失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    }
  }

  /** 恢复（取消暂停）容器 */
  async function handleUnpause(id: string, name: string) {
    try {
      await post(`/api/containers/${id}/unpause`);
      showToast(t('已恢复 {{name}}', { name }));
      load();
      loadPortConflicts();
    } catch (e: any) {
      showToast(t('恢复失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    }
  }

  /** 删除容器（确认后执行） */
  async function confirmDelete() {
    if (!canDelete) {
      showToast(t('仅管理员可删除容器'), 'error');
      setDeleteTarget(null);
      return;
    }
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const resp = await del<any>(`/api/containers/${deleteTarget.id}`, { force: true });
      // 审批门禁：后端返回 202 表示操作已转为待审批
      if (resp?.approvalPending) {
        showToast(t('该操作已提交审批，待管理员批准后执行'), 'info');
      } else {
        showToast(t('已删除 {{v1}}', { v1: deleteTarget.name }));
      }
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(t('删除失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setDeleting(false);
    }
  }

  /** 提取容器显示名称（去前导斜杠） */
  function displayName(c: ContainerListItem): string {
    return (c.Names && c.Names[0]?.replace(/^\//, '')) || c.Id;
  }

  /**
   * 计算容器的 Compose 组合键。
   * 基于 Docker Compose 标注的 project 名称，
   * 并用 working_dir 区分同名但不同路径的项目（返回 null 表示非 Compose 容器）。
   * working_dir 统一转小写，避免 Windows 盘符/路径大小写差异导致同项目被拆分。
   */
  function composeGroupKey(c: ContainerListItem): string | null {
    const project = c.Labels?.['com.docker.compose.project'];
    if (!project) return null;
    const workingDir = (c.Labels?.['com.docker.compose.project.working_dir'] || '').toLowerCase();
    return `${project}@${workingDir}`;
  }

  /** 从组合键还原出可展示的 Compose 项目名（取 project 部分） */
  function composeGroupLabel(key: string): string {
    const at = key.indexOf('@');
    return at === -1 ? key : key.slice(0, at);
  }

  /** 折叠 / 展开某个 Compose 分组 */
  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * 对 Compose 分组的全部成员执行批量操作（启动 / 停止 / 重启）。
   * 复用后端批量接口一次完成，按成员数量与成功数提示。
   */
  async function groupAction(key: string, action: 'start' | 'stop' | 'restart') {
    const group = renderRows.find((r) => r.type === 'group' && r.key === key) as
      | { type: 'group'; members: ContainerListItem[] }
      | undefined;
    if (!group || group.members.length === 0) return;
    setGroupActionKey(key);
    try {
      const ids = group.members.map((m) => m.Id);
      const r = await post<{ success: number; fail: number }>(
        `/api/containers/batch/${action}`,
        { ids }
      );
      const success = r?.success ?? 0;
      const fail = r?.fail ?? 0;
      const label = action === 'start' ? t('启动') : action === 'stop' ? t('停止') : t('重启');
      if (fail === 0) {
        showToast(t('{{label}}成功 {{success}} 个容器', { label, success }));
      } else if (success === 0) {
        showToast(t('{{label}}失败 {{fail}} 个容器', { label, fail }), 'error');
      } else {
        showToast(t('{{label}}成功 {{success}} 个，失败 {{fail}} 个', { label, success, fail }), 'info');
      }
      load();
    } catch (e: any) {
      showToast(t('操作失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setGroupActionKey(null);
    }
  }

  /** 批量操作确认对话框的标题 */
  function batchTitle(): string {
    if (batchAction === 'delete') return t('批量删除容器');
    if (batchAction === 'stop') return t('批量停止容器');
    if (batchAction === 'restart') return t('批量重启容器');
    return t('批量启动容器');
  }

  /** 批量操作确认对话框的提示文案 */
  function batchMessage(): string {
    const count = selectedIds.length;
    if (batchAction === 'delete') return t('确定要删除选中的 {{count}} 个容器吗？此操作不可撤销。', { count });
    if (batchAction === 'stop') return t('确定要停止选中的 {{count}} 个容器吗？', { count });
    if (batchAction === 'restart') return t('确定要重启选中的 {{count}} 个容器吗？', { count });
    return t('确定要启动选中的 {{count}} 个容器吗？', { count });
  }

  /** 批量操作标签（用于成功提示） */
  function batchActionLabel(action: BatchAction): string {
    if (action === 'delete') return t('删除');
    if (action === 'stop') return t('停止');
    if (action === 'restart') return t('重启');
    return t('启动');
  }

  /**
   * 执行批量操作（启动 / 停止 / 删除）
   *
   * 一次性调用后端批量接口（并发执行 + 逐项容错），全部处理完成后刷新列表并提示结果。
   */
  async function confirmBatch() {
    if (!batchAction || selectedIds.length === 0) return;
    if (batchAction === 'delete' && !canDelete) {
      showToast(t('仅管理员或运维人员可批量删除容器'), 'error');
      setBatchAction(null);
      return;
    }
    setBatchLoading(true);
    let success = 0;
    let fail = 0;
    try {
      if (batchAction === 'delete') {
        const r = await post<{ success: number; fail: number; approvalPending?: boolean; approvalIds?: number[] }>(
          '/api/containers/batch/delete',
          {
            ids: selectedIds,
            force: true,
          },
        );
        // 审批流开启时返回 202 转待审批，整批不执行
        if (r?.approvalPending) {
          setBatchAction(null);
          setSelectedIds([]);
          setBatchLoading(false);
          showToast(t('已提交 {{v1}} 条删除审批，待管理员批准后执行', { v1: r.approvalIds?.length ?? 0 }), 'info');
          return;
        }
        success = r?.success ?? 0;
        fail = r?.fail ?? 0;
      } else if (batchAction === 'stop') {
        const r = await post<{ success: number; fail: number }>('/api/containers/batch/stop', { ids: selectedIds });
        success = r?.success ?? 0;
        fail = r?.fail ?? 0;
      } else if (batchAction === 'restart') {
        const r = await post<{ success: number; fail: number }>('/api/containers/batch/restart', { ids: selectedIds });
        success = r?.success ?? 0;
        fail = r?.fail ?? 0;
      } else {
        const r = await post<{ success: number; fail: number }>('/api/containers/batch/start', { ids: selectedIds });
        success = r?.success ?? 0;
        fail = r?.fail ?? 0;
      }
    } catch {
      fail = selectedIds.length;
    }
    setBatchAction(null);
    setSelectedIds([]);
    setBatchLoading(false);
    // 统一提示成功 / 失败数量
    if (fail === 0) {
      showToast(t('{{v1}}成功 {{success}} 个容器', { v1: batchActionLabel(batchAction!), success }));
    } else if (success === 0) {
      showToast(t('{{v1}}失败 {{fail}} 个容器', { v1: batchActionLabel(batchAction!), fail }), 'error');
    } else {
      showToast(t('{{v1}}成功 {{success}} 个，失败 {{fail}} 个', { v1: batchActionLabel(batchAction!), success, fail }), 'info');
    }
    load();
  }

  /**
   * 批量在线更新选中容器的资源限制（CPU / 内存）。
   * 留空的字段不传，表示不修改；填值则完成单位换算（CPU 核数 -> 纳核，内存 GB -> 字节）。
   * 调用 POST /api/containers/batch/update 后按 success/fail 提示并刷新列表。
   */
  async function confirmBatchEdit() {
    if (selectedIds.length === 0) return;
    if (!canDelete) {
      showToast(t('仅管理员或运维人员可编辑资源限制'), 'error');
      setBatchEditOpen(false);
      return;
    }
    const body: Record<string, unknown> = { ids: selectedIds };
    // CPU：留空表示不修改；填 0 表示取消限制；否则核数转纳核
    if (batchEditCpu.trim() !== '') {
      const cpus = parseFloat(batchEditCpu);
      if (isNaN(cpus) || cpus < 0) {
        showToast(t('请输入有效的 CPU 核数（如 1 或 1.5）'), 'error');
        return;
      }
      body.cpuLimit = Math.round(cpus * 1e9);
    }
    // 内存：留空表示不修改；填 0 表示取消限制；否则 GB 转字节
    if (batchEditMem.trim() !== '') {
      const gb = parseFloat(batchEditMem);
      if (isNaN(gb) || gb < 0) {
        showToast(t('请输入有效的内存大小（GB，如 2）'), 'error');
        return;
      }
      body.memLimit = Math.round(gb * 1024 * 1024 * 1024);
    }
    // 至少需填写一项，否则无任何可更新内容
    if (body.cpuLimit === undefined && body.memLimit === undefined) {
      showToast(t('请至少填写 CPU 或内存限制其一'), 'error');
      return;
    }
    setBatchEditLoading(true);
    try {
      const r = await post<{ success: number; fail: number }>('/api/containers/batch/update', body);
      const success = r?.success ?? 0;
      const fail = r?.fail ?? 0;
      setBatchEditOpen(false);
      setSelectedIds([]);
      if (fail === 0) {
        showToast(t('已更新 {{success}} 个容器的资源限制', { success }));
      } else if (success === 0) {
        showToast(t('更新失败 {{fail}} 个容器', { fail }), 'error');
      } else {
        showToast(t('更新成功 {{success}} 个，失败 {{fail}} 个容器', { success, fail }), 'info');
      }
      load();
    } catch (e: any) {
      showToast(t('批量更新失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setBatchEditLoading(false);
    }
  }

  /**
   * 清理未使用资源（悬空镜像 / 未使用网络 / 未使用卷 / build cache）。
   * 仅清理未使用资源，不会删除任何运行中的容器。
   */
  async function confirmPrune() {
    if (!canDelete) {
      showToast(t('仅管理员可清理未使用资源'), 'error');
      setPruneOpen(false);
      return;
    }
    setPruning(true);
    try {
      const res = await post<any>('/api/system/prune', {
        images: true,
        containers: true,
        networks: true,
        volumes: true,
        buildCache: true,
      });
      const space = formatSpace(res?.totalSpace);
      showToast(t('清理完成，释放空间 {{space}}', { space }));
      setPruneOpen(false);
      load();
    } catch (e: any) {
      showToast(t('清理失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setPruning(false);
    }
  }

  /** 字节数格式化为可读大小 */
  function formatSpace(bytes?: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(1)} ${units[i]}`;
  }
  /** 打开创建容器弹窗（空白表单） */
  function openCreate() {
    if (!canDelete) {
      showToast(t('仅管理员可创建容器'), 'error');
      return;
    }
    setCreateSeed({ type: 'blank' });
  }

  /**
   * 导入容器配置文件（JSON），解析后交给 CreateContainerModal 回填，便于一键按配置重建。
   * 支持导出接口生成的格式：{ schema, config:{...} } 或直接为创建配置对象。
   */
  function handleImportConfig(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result));
        // 兼容两种结构：{ config } 包装 或 顶层即配置
        const cfg = raw && typeof raw === 'object' && raw.config ? raw.config : raw;
        setPage(1);
        setCreateSeed({ type: 'config', cfg });
        showToast(t('配置已导入，请确认后创建'));
      } catch (e: any) {
        showToast(t('配置文件解析失败：{{v1}}', { v1: e?.message || t('格式错误') }), 'error');
      }
    };
    reader.onerror = () => showToast(t('读取文件失败'), 'error');
    reader.readAsText(file);
    // 允许重复选择同一文件
    if (importFileRef.current) importFileRef.current.value = '';
  }

  /**
   * 判断某个宿主机端口是否与其他容器存在占用冲突
   * @param publicPort 宿主机端口
   * @returns 是否存在冲突
   */
  function isPortConflicted(publicPort?: number): boolean {
    if (publicPort === undefined || publicPort === null) return false;
    return !!portConflicts[String(publicPort)];
  }

  /**
   * 渲染端口单元格，冲突端口以红色警示样式展示
   * @param c 容器项
   * @returns 端口单元格 JSX
   */
  function renderPortCell(c: ContainerListItem) {
    if (!c.Ports || c.Ports.length === 0) return '-';
    return c.Ports.map((p, i) => {
      const conflicted = isPortConflicted(p.PublicPort);
      return (
        <span key={i} className={conflicted ? 'port-item port-item--conflict' : 'port-item'}>
          {p.PublicPort ?? '-'}:{p.PrivatePort}
          {conflicted && <span className="port-item__warn">{t('端口被占用')}</span>}
        </span>
      );
    });
  }

  /**
   * 渲染 CPU / 内存实时监控单元格。
   * 仅运行中的容器展示真实数据（statsMap 里的值）；非运行中或不含数据显示占位。
   */
  function renderStatCells(c: ContainerListItem) {
    const stat = statsMap[c.Id];
    if (c.State !== 'running' || !stat) {
      return (
        <>
          <td className="cell-stat"><span className="cell-stat__muted">-</span></td>
          <td className="cell-stat"><span className="cell-stat__muted">-</span></td>
        </>
      );
    }
    const cpu = Number(stat.cpuPercent || 0);
    const memPct = Number(stat.memory?.percent || 0);
    return (
      <>
        <td className="cell-stat">
          <span className="stat-gauge">
            <span className="stat-gauge__bar">
              <span className={`stat-gauge__fill ${gaugeTone(cpu)}`} style={{ width: `${Math.min(100, cpu)}%` }} />
            </span>
            <span className="stat-gauge__num">{cpu.toFixed(1)}%</span>
          </span>
        </td>
        <td className="cell-stat">
          <span className="stat-gauge">
            <span className="stat-gauge__bar">
              <span className={`stat-gauge__fill ${gaugeTone(memPct)}`} style={{ width: `${Math.min(100, memPct)}%` }} />
            </span>
            <span className="stat-gauge__num">{memPct.toFixed(1)}%</span>
          </span>
        </td>
      </>
    );
  }

  /**
   * 根据占用率返回进度条配色：>90 红、>70 橙、其余绿
   * @param pct 占用百分比
   * @returns 样式类别
   */
  function gaugeTone(pct: number): string {
    if (pct > 90) return 'stat-gauge__fill--high';
    if (pct > 70) return 'stat-gauge__fill--warn';
    return 'stat-gauge__fill--ok';
  }

  /** 创建时间：epoch 秒转日期字符串 */
  function formatCreated(seconds: number): string {
    if (!seconds) return '-';
    const d = new Date(seconds * 1000);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  /**
   * 格式化 CPU 限制值（NanoCpus 纳核）。
   * 0 或非法值返回 '不限'；否则转换为核数，整数核省略小数。
   * @param nano NanoCpus 纳核数
   * @returns 形如 '2 Core' / '0.5 Core' 或 '不限'
   */
  function formatCpuLimit(nano: number | undefined): string {
    if (nano === undefined || Number.isNaN(nano) || nano <= 0) return t('不限');
    const cores = nano / 1e9;
    return `${Number.isInteger(cores) ? cores : cores.toFixed(2)} Core`;
  }

  /**
   * 格式化内存限制值（字节）。
   * 0 返回 '不限'；<1GB 显示 MB，否则显示 GB（保留两位小数）。
   * @param bytes 内存限制字节数
   * @returns 形如 '512 MB' / '2.00 GB' 或 '不限'
   */
  function formatMemLimit(bytes: number | undefined): string {
    if (bytes === undefined || Number.isNaN(bytes) || bytes <= 0) return t('不限');
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
    }
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  /** 渲染单个容器行（普通独立容器，或 Compose 分组内的成员行共用） */
  function rowFor(c: ContainerListItem) {
    const name = displayName(c);
    const running = c.State === 'running';
    const checked = selectedIds.includes(c.Id);
    return (
      <tr key={c.Id} className={checked ? 'row--selected' : ''}>
        <td className="col-select">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleSelect(c.Id)}
            aria-label={t('选择 {{name}}', { name })}
          />
        </td>
        <td className="cell-name" title={c.Id}>
          {name}
        </td>
        <td className="cell-image">{c.Image || '-'}</td>
        <td>
          <span className="cell-status">
            <StatusBadge status={c.State} />
            {c.health && c.health !== 'none' && (
              <span className={`health-badge health-badge--${c.health}`}>{c.health}</span>
            )}
          </span>
        </td>
        <td className="cell-ports">{renderPortCell(c)}</td>
        {renderStatCells(c)}
        <td className="cell-limit">
          <span className="cell-limit__line">
            CPU <em>{formatCpuLimit(c.cpuLimit)}</em>
          </span>
          <span className="cell-limit__line">
            {t('内存')} <em>{formatMemLimit(c.memLimit)}</em>
          </span>
        </td>
        <td className="cell-created">{formatCreated(c.Created)}</td>
        <td className="col-actions">
          <div className="containers__actions">
            {/* 生命周期操作：1Panel 风格状态下拉（启动/停止/重启/强制停止/暂停/恢复，按状态置灰） */}
            <StateActions
              state={c.State}
              onAction={(action: ContainerAction) => {
                const handlers: Record<ContainerAction, (id: string, name: string) => void> = {
                  start: handleStart,
                  stop: handleStop,
                  restart: handleRestart,
                  kill: handleKill,
                  pause: handlePause,
                  unpause: handleUnpause,
                  // 仅 Compose 项目菜单使用的键，容器菜单不会触发
                  up: () => undefined,
                  down: () => undefined,
                };
                handlers[action](c.Id, name);
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => openLogs(c.Id, name)}>
              {t('日志')}
            </Button>
            {/* 次要操作按语义分组收入"更多"菜单（1.68.0，与 Compose 页一致） */}
            <MoreMenu
              disabled={!canDelete}
              items={[
                { label: t('查看'), group: true, onClick: () => {} },
                { label: t('详情'), onClick: () => navigate(`/containerDetail/${c.Id}`) },
                { label: t('编辑配置'), group: true, onClick: () => {} },
                { label: t('重命名'), onClick: () => openRename(c.Id, name), disabled: !canDelete },
                { label: t('编辑镜像'), onClick: () => openEditImage(c.Id, name, c.Image), disabled: !canDelete },
                { label: t('管理'), group: true, onClick: () => {} },
                { label: t('克隆'), onClick: () => openClone(c.Id, name), disabled: !canDelete },
                {
                  label: t('迁移'),
                  disabled: !canDelete || !hasMigrateTarget,
                  title: !hasMigrateTarget ? t('无其它可用引擎，无法迁移（需至少配置一个非当前引擎）') : '',
                  onClick: () => openMigrate(c),
                },
                { label: t('删除'), danger: true, disabled: !canDelete, onClick: () => setDeleteTarget({ id: c.Id, name }) },
              ]}
            />
          </div>
        </td>
      </tr>
    );
  }

  if (loading) return <PageLoading />;

  return (
    <div className="containers-page">
      <h1 className="containers-page__title">{t('容器')}</h1>

      <div className="containers__toolbar">
        <div className="containers__left">
          <div className="containers__filters">
            <button
              className={`seg ${filter === 'all' ? 'seg--active' : ''}`}
              onClick={() => {
                setFilter('all');
                setPage(1);
              }}
            >
              {t('全部')} <span className="seg__count">{list.length}</span>
            </button>
            <button
              className={`seg ${filter === 'running' ? 'seg--active' : ''}`}
              onClick={() => {
                setFilter('running');
                setPage(1);
              }}
            >
              {t('运行中')} <span className="seg__count">{list.filter((c) => c.State === 'running').length}</span>
            </button>
            <button
              className={`seg ${filter === 'stopped' ? 'seg--active' : ''}`}
              onClick={() => {
                setFilter('stopped');
                setPage(1);
              }}
            >
              {t('已停止')} <span className="seg__count">{list.filter((c) => c.State !== 'running').length}</span>
            </button>
          </div>
          <Select
            className="containers__img-filter"
            value={imageFilter}
            onChange={(e) => {
              setImageFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('全部镜像')}</option>
            {imageOptions.map((img) => (
              <option key={img} value={img}>
                {img}
              </option>
            ))}
          </Select>
          <Select
            className="containers__label-filter"
            value={labelFilter}
            onChange={(e) => {
              setLabelFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('全部标签')}</option>
            {labelOptions.map((pair) => (
              <option key={pair} value={pair}>
                {pair}
              </option>
            ))}
          </Select>
          <Input
            className="containers__search"
            placeholder={t('搜索 容器名 / 镜像 / ID')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="containers__toolbar-right">
          {selectedIds.length > 0 && (
            <div className="containers__batch">
              <span className="containers__batch-count">{t('已选 {{n}} 项', { n: selectedIds.length })}</span>
              <Button variant="secondary" size="sm" onClick={() => setBatchAction('start')}>
                {t('批量启动')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setBatchAction('stop')}>
                {t('批量停止')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setBatchAction('restart')}>
                {t('批量重启')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (!canDelete) {
                    showToast(t('仅管理员或运维人员可编辑资源限制'), 'error');
                    return;
                  }
                  setBatchEditCpu('');
                  setBatchEditMem('');
                  setBatchEditOpen(true);
                }}
                disabled={!canDelete}
              >
                {t('编辑资源')}
              </Button>
              <Button variant="danger" size="sm" onClick={() => setBatchAction('delete')} disabled={!canDelete}>
                {t('批量删除')}
              </Button>
            </div>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setInferOpen(true)}
            disabled={!canDelete}
            title={t('从选中容器一键逆向生成 docker-compose 配置')}
          >
            {t('生成 Compose')}
          </Button>
          <span className="containers__total">{t('共 {{n}} 个容器', { n: filteredList.length })}</span>
          <Button
            variant="primary"
            size="sm"
            onClick={openCreate}
            disabled={!canDelete}
            className="containers__create-btn"
          >
            {t('创建容器')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setPruneOpen(true)} disabled={!canDelete}>
            {t('清理未使用')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => importFileRef.current?.click()}>
            {t('导入配置')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCreateSeed({ type: 'template-picker' })} disabled={!canDelete}>
            {t('从模板创建')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleRefresh}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      <Card>
        {loadError ? (
          <Empty
            kind="error"
            title={t('加载容器列表失败')}
            description={loadError || t('请检查 Docker 引擎连接后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={load}>
                {t('重试')}
              </Button>
            }
          />
        ) : filteredList.length === 0 ? (
          <Empty
            kind={search ? 'search' : 'empty'}
            title={search ? t('未找到匹配的容器') : filter === 'running' ? t('暂无运行中的容器') : filter === 'stopped' ? t('暂无已停止的容器') : t('暂无容器')}
            description={search ? t('请尝试更换搜索关键字') : t('容器未创建或已被删除')}
            action={!search ? <Button size="sm" variant="primary" onClick={openCreate} disabled={!canDelete}>{t('创建容器')}</Button> : undefined}
          />
        ) : (
          <>
            <div className="containers__table">
              <table>
                <thead>
                  <tr>
                    <th className="col-select">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={(e) => toggleSelectAll(e.target.checked)}
                        aria-label={t('全选当前页')}
                      />
                    </th>
                    <th className="th-sort" onClick={() => toggleSort('name')}>
                      {t('名称')} <span className="th-sort__ind">{sortIndicator('name')}</span>
                    </th>
                    <th>{t('镜像')}</th>
                    <th className="th-sort" onClick={() => toggleSort('status')}>
                      {t('状态')} <span className="th-sort__ind">{sortIndicator('status')}</span>
                    </th>
                    <th>{t('端口')}</th>
                    <th className="th-sort" onClick={() => toggleSort('cpu')}>
                      CPU <span className="th-sort__ind">{sortIndicator('cpu')}</span>
                    </th>
                    <th className="th-sort" onClick={() => toggleSort('mem')}>
                      {t('内存')} <span className="th-sort__ind">{sortIndicator('mem')}</span>
                    </th>
                    <th>{t('资源限制')}</th>
                    <th className="th-sort" onClick={() => toggleSort('created')}>
                      {t('创建时间')} <span className="th-sort__ind">{sortIndicator('created')}</span>
                    </th>
                    <th className="col-actions">{t('操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {renderRows.map((r) => {
                    if (r.type === 'row') return rowFor(r.data);
                    const collapsed = collapsedGroups.has(r.key);
                    const isMulti = r.members.length > 1;
                    const groupChecked =
                      r.members.length > 0 && r.members.every((m) => selectedIds.includes(m.Id));
                    const someChecked = r.members.some((m) => selectedIds.includes(m.Id));
                    const anyRunning = r.members.some((m) => m.State === 'running');
                    const anyStopped = r.members.some((m) => m.State !== 'running');
                    const groupBusy = groupActionKey === r.key;
                    return (
                      <Fragment key={r.key}>
                        <tr className={`compose-group${collapsed ? ' compose-group--collapsed' : ''}`}>
                          <td className="col-select">
                            {isMulti && (
                              <input
                                type="checkbox"
                                checked={groupChecked}
                                ref={(el) => {
                                  if (el) el.indeterminate = someChecked && !groupChecked;
                                }}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setSelectedIds((prev) => {
                                    const next = new Set(prev);
                                    r.members.forEach((m) =>
                                      checked ? next.add(m.Id) : next.delete(m.Id)
                                    );
                                    return Array.from(next);
                                  });
                                }}
                                aria-label={t('选择 Compose 分组 {{v1}}', { v1: r.label })}
                              />
                            )}
                          </td>
                          <td className="compose-group__cell" colSpan={8}>
                            <button
                              type="button"
                              className="compose-group__toggle"
                              onClick={() => toggleGroup(r.key)}
                              title={collapsed ? t('展开该 Compose 分组') : t('折叠该 Compose 分组')}
                            >
                              <span className="compose-group__caret">{collapsed ? '▸' : '▾'}</span>
                              <span className="compose-group__icon">
                                <span aria-hidden>⊞</span>
                              </span>
                              <span className="compose-group__title">{r.label}</span>
                              <span className="compose-group__badge">{t('{{n}} 个容器', { n: r.members.length })}</span>
                            </button>
                          </td>
                          <td className="col-actions">
                            <div className="containers__actions">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => groupAction(r.key, 'start')}
                                disabled={groupBusy || !anyStopped || !canDelete}
                              >
                                {t('启动')}
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => groupAction(r.key, 'stop')}
                                disabled={groupBusy || !anyRunning || !canDelete}
                              >
                                {t('停止')}
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => groupAction(r.key, 'restart')}
                                disabled={groupBusy || !anyRunning || !canDelete}
                              >
                                {t('重启')}
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {!collapsed && r.members.map((m) => rowFor(m))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 分页控件 */}
            <div className="containers__pagination">
              <div className="containers__pagination-left">
                <span className="containers__pagination-size">
                  {t('每页')}
                  <Select
                    className="containers__pagesize"
                    value={String(pageSize)}
                    onChange={(e) => changePageSize(Number(e.target.value))}
                  >
                    {PAGE_SIZE_OPTIONS.map((s) => (
                      <option key={s} value={String(s)}>
                        {s}
                      </option>
                    ))}
                  </Select>
                  {t('条')}
                </span>
                <span className="containers__pagination-info">
                  {t('共 {{total}} 条，当前第 {{start}}-{{end}} 条', { total: filteredList.length, start: pageStart, end: pageEnd })}
                </span>
              </div>
              <div className="containers__pagination-controls">
                <button
                  className="containers__page-btn"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  {t('上一页')}
                </button>
                {pageButtons.map((p, i) =>
                  p === 'ellipsis' ? (
                    <span key={`ellipsis-${i}`} className="containers__page-ellipsis">
                      …
                    </span>
                  ) : (
                    <button
                      key={p}
                      className={`containers__page-btn ${p === page ? 'containers__page-btn--active' : ''}`}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </button>
                  ),
                )}
                <button
                  className="containers__page-btn"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  {t('下一页')}
                </button>
                <span className="containers__page-jump">
                  <Input
                    className="containers__page-jump-input"
                    type="number"
                    min={1}
                    max={totalPages}
                    placeholder={t('页码')}
                    value={pageJump}
                    onChange={(e) => setPageJump(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handlePageJump();
                    }}
                  />
                  <Button variant="ghost" size="sm" onClick={handlePageJump}>
                    {t('跳转')}
                  </Button>
                </span>
              </div>
            </div>
          </>
        )}
      </Card>

      <ConfirmDialog
        open={!!deleteTarget}
        title={t('删除容器')}
        message={t('确定要删除容器「{{v1}}」吗？此操作不可撤销。', { v1: deleteTarget?.name || '' })}
        confirmText={t('删除')}
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 重命名容器弹窗 */}
      <Modal
        open={!!renameTarget}
        title={t('重命名容器')}
        onClose={() => !renaming && setRenameTarget(null)}
        width={440}
        footer={
          <div className="create-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setRenameTarget(null)} disabled={renaming}>
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" loading={renaming} onClick={confirmRename}>
              {t('重命名')}
            </Button>
          </div>
        }
      >
        <Field label={t('新名称')} required hint={t('修改后立即生效')}>
          <Input
            placeholder={t('新容器名称')}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            autoFocus
            disabled={renaming}
          />
        </Field>
      </Modal>

      {/* 克隆容器弹窗 */}
      <Modal
        open={cloneOpen}
        title={t('克隆容器')}
        onClose={() => !cloning && setCloneOpen(false)}
        width={440}
        footer={
          <div className="create-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setCloneOpen(false)} disabled={cloning}>
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" loading={cloning} onClick={confirmClone}>
              {t('克隆')}
            </Button>
          </div>
        }
      >
        <Field label={t('新名称')} required hint={t('将基于「{{v1}}」复制配置并创建新容器，原容器保留', { v1: cloneTarget?.name || '' })}>
          <Input
            placeholder={t('新容器名称')}
            value={cloneValue}
            onChange={(e) => setCloneValue(e.target.value)}
            autoFocus
            disabled={cloning}
          />
        </Field>
      </Modal>

      {/* 跨引擎迁移容器弹窗 */}
      <Modal
        open={!!migrateTarget}
        title={t('跨引擎迁移容器')}
        onClose={() => !migrating && setMigrateTarget(null)}
        width={520}
        footer={
          <div className="create-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setMigrateTarget(null)} disabled={migrating}>
              {t('关闭')}
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={migrating}
              onClick={confirmMigrate}
              disabled={!hasMigrateTarget}
            >
              {t('迁移')}
            </Button>
          </div>
        }
      >
        {migrateTarget && (
          <>
            {/* 源信息（只读展示） */}
            <div className="migrate-modal__source">
              <div className="migrate-modal__source-row">
                <span className="migrate-modal__source-label">{t('容器名')}</span>
                <span className="migrate-modal__source-value" title={migrateTarget.name}>
                  {migrateTarget.name}
                </span>
              </div>
              <div className="migrate-modal__source-row">
                <span className="migrate-modal__source-label">{t('镜像')}</span>
                <span className="migrate-modal__source-value" title={migrateTarget.image}>
                  {migrateTarget.image || '-'}
                </span>
              </div>
              <div className="migrate-modal__source-row">
                <span className="migrate-modal__source-label">{t('源引擎')}</span>
                <span className="migrate-modal__source-value">
                  {currentEngine?.name || t('（无法识别当前引擎）')}
                </span>
              </div>
            </div>

            <Field label={t('目标引擎')} required hint={t('将容器迁移到此引擎；需为当前引擎以外的其它引擎')}>
              <Select
                value={migrateTargetId}
                onChange={(e) => setMigrateTargetId(e.target.value)}
                disabled={migrating}
              >
                <option value="" disabled>
                  {hasMigrateTarget ? t('请选择目标引擎') : t('无其它可用引擎')}
                </option>
                {otherEngines.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t('目标容器名')} hint={t('可选，留空时自动沿用原容器名')}>
              <Input
                placeholder={t('留空沿用原名')}
                value={migrateName}
                onChange={(e) => setMigrateName(e.target.value)}
                disabled={migrating}
              />
            </Field>

            <Field label={t('迁移后启动')}>
              <label className="create-modal__tty">
                <input
                  type="checkbox"
                  checked={migrateStart}
                  onChange={(e) => setMigrateStart(e.target.checked)}
                  disabled={migrating}
                />
                {t('迁移完成后自动启动目标容器')}
              </label>
            </Field>

            {/* 迁移结果展示 */}
            {migrateResult && (
              <div className="migrate-modal__result">
                <div className="migrate-modal__result-title">{t('迁移成功')}</div>
                <div className="migrate-modal__result-row">
                  {t('目标容器：')}{migrateResult.name || migrateTarget.name}
                  {migrateResult.id ? `（${migrateResult.id.slice(0, 12)}）` : ''}
                </div>
                <div className="migrate-modal__result-row">
                  {t('镜像是否已传输：')}
                  {migrateResult.imageTransferred ? t('是') : t('否')}
                </div>
                {migrateResult.started === true && (
                  <div className="migrate-modal__result-row">{t('启动状态：已启动')}</div>
                )}
                {migrateResult.started === false && (
                  <div className="migrate-modal__result-row">{t('启动状态：未启动')}</div>
                )}
                {migrateResult.startError && (
                  <div className="migrate-modal__result-note">{t('启动错误：{{msg}}', { msg: migrateResult.startError })}</div>
                )}
                {migrateResult.warning && (
                  <div className="migrate-modal__result-note">{t('警告：{{msg}}', { msg: migrateResult.warning })}</div>
                )}
                {migrateResult.note && (
                  <div className="migrate-modal__result-note">{t('备注：{{msg}}', { msg: migrateResult.note })}</div>
                )}
                <div className="migrate-modal__result-tip">
                  {t('可在目标引擎的容器列表中查看该容器。')}
                </div>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* 编辑镜像弹窗（替换容器使用的镜像） */}
      <Modal
        open={editImageOpen}
        title={t('编辑镜像')}
        onClose={() => !editImageSaving && setEditImageOpen(false)}
        width={600}
        footer={
          <div className="create-modal__footer">
            <Button
              variant="ghost"
              size="md"
              onClick={() => setEditImageOpen(false)}
              disabled={editImageSaving}
            >
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" loading={editImageSaving} onClick={confirmEditImage}>
              {t('替换镜像')}
            </Button>
          </div>
        }
      >
        <Field
          label={t('容器「{{v1}}」当前镜像', { v1: editImageTarget?.name || '' })}
          hint={t('替换镜像将基于现有容器重建，仅替换镜像，端口、挂载、网络、环境变量等配置保留；重建会导致容器短暂中断，容器 ID 会改变。')}
        >
          <div className="edit-image__current" title={editImageValue}>
            {editImageValue || '-'}
          </div>
        </Field>
        <Field label={t('替换为以下镜像')} required>
          <div className="edit-image__picker">
            <Input
              className="edit-image__input"
              placeholder={t('输入关键字过滤或直接填写镜像名，如 nginx:latest')}
              value={editImageValue}
              onChange={(e) => {
                const v = e.target.value;
                setEditImageValue(v);
                setEditImageSearch(v);
                setEditImageDropdownOpen(true);
              }}
              onFocus={() => setEditImageDropdownOpen(true)}
              onBlur={() => setEditImageDropdownOpen(false)}
              disabled={editImageSaving}
            />
            {editImageDropdownOpen && (
              <div className="edit-image__dropdown">
                {filteredImageOptions().length === 0 ? (
                  <div className="edit-image__dropdown-empty">{t('无匹配的本地镜像，可继续手动输入')}</div>
                ) : (
                  filteredImageOptions().map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`edit-image__option ${t === editImageValue ? 'edit-image__option--active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => chooseEditImage(t)}
                    >
                      {t}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </Field>
      </Modal>

      {/* 批量编辑资源弹窗（CPU / 内存限制，对应 docker update） */}
      <Modal
        open={batchEditOpen}
        title={t('批量编辑资源限制')}
        onClose={() => !batchEditLoading && setBatchEditOpen(false)}
        width={520}
        footer={
          <div className="create-modal__footer">
            <Button
              variant="ghost"
              size="md"
              onClick={() => setBatchEditOpen(false)}
              disabled={batchEditLoading}
            >
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" loading={batchEditLoading} onClick={confirmBatchEdit}>
              {t('保存')}
            </Button>
          </div>
        }
      >
        <div className="batch-edit__tip">
          {t('将为选中的 {{n}} 个容器在线更新资源限制，无需重建、不中断运行。留空的字段将保持现状。', { n: selectedIds.length })}
        </div>
        <div className="create-modal__grid">
          <Field label={t('CPU 限制（核数，留空不修改；填 0 取消限制）')} hint={t('如 1 或 1.5')}>
            <Input
              type="number"
              min={0}
              step="0.1"
              placeholder={t('如 1 或 1.5')}
              value={batchEditCpu}
              onChange={(e) => setBatchEditCpu(e.target.value)}
              disabled={batchEditLoading}
            />
          </Field>
          <Field label={t('内存限制（GB，留空不修改；填 0 取消限制）')} hint={t('如 2')}>
            <Input
              type="number"
              min={0}
              step="0.5"
              placeholder={t('如 2')}
              value={batchEditMem}
              onChange={(e) => setBatchEditMem(e.target.value)}
              disabled={batchEditLoading}
            />
          </Field>
        </div>
      </Modal>

      {/* 批量操作确认对话框 */}
      <ConfirmDialog
        open={!!batchAction && selectedIds.length > 0}
        title={batchTitle()}
        message={batchMessage()}
        confirmText={batchActionLabel(batchAction!)}
        danger={batchAction === 'delete'}
        loading={batchLoading}
        onConfirm={confirmBatch}
        onCancel={() => setBatchAction(null)}
      />

      {/* 清理未使用资源确认对话框 */}
      <ConfirmDialog
        open={pruneOpen}
        title={t('清理未使用资源')}
        message={t('将清理未使用的镜像、已停止的容器、未使用的数据卷与网络、以及构建缓存。此操作不可撤销，但不会影响处于运行中的容器。')}
        confirmText={t('清理')}
        danger
        loading={pruning}
        onConfirm={confirmPrune}
        onCancel={() => setPruneOpen(false)}
      />

      {/* 导入配置文件（隐藏 input，由「导入配置」按钮触发） */}
      <input
        ref={importFileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImportConfig(file);
        }}
      />

      {logTarget && (
        <ContainerLogModal target={logTarget} onClose={() => setLogTarget(null)} />
      )}
      <CreateContainerModal
        seed={createSeed}
        onClose={() => setCreateSeed(null)}
        onCreated={load}
      />
      <ComposeInferModal
        open={inferOpen}
        onClose={() => setInferOpen(false)}
        initialIds={selectedIds}
      />
    </div>
  );
}
