/**
 * 镜像列表页
 *
 * 展示 Docker 镜像列表，支持刷新、拉取镜像、删除镜像与清理未使用镜像。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { Field, Input, Select } from '../components/Form';
import { PageLoading, SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import { getToken, isAdmin, canOperate } from '../api/auth';
import { ImageItem } from '../types';
import './images.less';

/** 将字节数格式化为人类可读大小 */
function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 将 epoch 秒格式化为本地时间字符串
 * @param epoch 时间戳（秒），可为空
 */
function formatTime(epoch?: number): string {
  if (!epoch) return '-';
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** 根据镜像名称生成删除接口的路径（镜像名可能含 '/'，需编码处理） */
function imageDeleteUrl(name: string): string {
  return '/api/images/' + encodeURIComponent(name) + '?force=true';
}

/**
 * 触发镜像导出下载（docker save）
 * 由于鉴权依赖 Authorization 请求头，无法用 location.href 直接跳转，
 * 因此通过 fetch 获取二进制 blob，再创建临时 <a> 触发浏览器下载。
 * @param name 待导出的镜像名
 */
async function downloadImage(name: string): Promise<void> {
  const res = await fetch('/api/images/' + encodeURIComponent(name) + '/save', {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `镜像导出失败 (${res.status})`;
    try {
      const data = JSON.parse(text);
      message = data?.error || message;
    } catch {
      /* 忽略非 JSON 响应体 */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  // 优先从响应头解析文件名，否则使用接口返回的默认名称
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = match?.[1] || 'image.tar';
  // 创建临时链接触发下载
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 镜像优化建议数据（/api/images/suggestions 返回） */
interface ImageSuggestions {
  /** Top 10 大镜像 */
  topLarge: { id: string; tags: string[]; size: number; created: number }[];
  /** 长期未使用镜像 */
  unused: { id: string; tags: string[]; size: number; lastPullAt?: number; daysSincePull: number }[];
  /** 重复标签镜像 */
  duplicates: { id: string; tags: string[] }[];
  /** 所有镜像总大小 */
  totalSize: number;
  /** 悬空镜像数量 */
  danglingCount: number;
  /** 镜像总数 */
  totalCount: number;
}

/** 优化建议统计卡片样式（通过 CSS 变量适配浅色/深色主题） */
const suggestStatStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md, 8px)',
  padding: 16,
};

/**
 * 镜像列表页组件
 */
export default function ImagesPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const canManage = isAdmin();
  const [images, setImages] = useState<ImageItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  const [pullOpen, setPullOpen] = useState(false);
  const [pullRef, setPullRef] = useState('');
  const [pulling, setPulling] = useState(false);
  // 拉取时使用的镜像源主机（''=官方 Docker Hub，由后端自动用默认源）
  const [pullSource, setPullSource] = useState('');
  // 可选的镜像源列表（来自 /api/hub/sources）
  const [sources, setSources] = useState<{ id: string; host: string; name?: string; enabled?: boolean }[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<ImageItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 镜像优化建议数据
  const [suggestions, setSuggestions] = useState<ImageSuggestions | null>(null);
  // "一键清理未使用镜像"确认框
  const [pruneAllOpen, setPruneAllOpen] = useState(false);
  const [pruningAll, setPruningAll] = useState(false);
  // 未使用镜像详情弹窗
  const [unusedOpen, setUnusedOpen] = useState(false);
  // 搜索关键字（按镜像名/ID 本地过滤）
  const [keyword, setKeyword] = useState('');
  /** 分页每页条数可选值 */
  const PAGE_SIZE_OPTIONS = [15, 30, 50];
  // 当前页码（从 1 开始）
  const [page, setPage] = useState(1);
  // 每页条数（可在运行时切换）
  const [pageSize, setPageSize] = useState(15);
  // 分页跳转：输入的目标页码
  const [pageJump, setPageJump] = useState('');
  // 待打标签的镜像（用于打开打标签弹窗）
  const [tagTarget, setTagTarget] = useState<ImageItem | null>(null);
  // 打标签弹窗中的仓库与标签输入
  const [tagRepo, setTagRepo] = useState('');
  const [tagTag, setTagTag] = useState('');
  // 打标签是否进行中
  const [tagging, setTagging] = useState(false);
  // 导入弹窗是否打开
  const [importOpen, setImportOpen] = useState(false);
  // 导入选中的 tar 文件
  const [importFile, setImportFile] = useState<File | null>(null);
  // 导入是否进行中
  const [importing, setImporting] = useState(false);
  // 待推送的镜像（用于打开推送弹窗）
  const [pushTarget, setPushTarget] = useState<ImageItem | null>(null);
  // 推送目标仓库名（默认带当前 tag 的完整引用）
  const [pushName, setPushName] = useState('');
  // 推送认证用户名（可选）
  const [pushUsername, setPushUsername] = useState('');
  // 推送认证密码（可选）
  const [pushPassword, setPushPassword] = useState('');
  // 推送是否进行中
  const [pushing, setPushing] = useState(false);
  // 导出进行中的镜像名（用于行内按钮 loading 显示）
  const [exportingName, setExportingName] = useState('');
  // 待迁移的镜像（用于打开迁移弹窗）
  const [transferTarget, setTransferTarget] = useState<ImageItem | null>(null);
  // 迁移弹窗中的引擎列表（来自 /api/engines）
  const [engineList, setEngineList] = useState<{ id: string; name: string; isCurrent: boolean }[]>([]);
  // 迁移弹窗中的源引擎 id
  const [transferSourceId, setTransferSourceId] = useState('');
  // 迁移弹窗中的目标引擎 id
  const [transferTargetId, setTransferTargetId] = useState('');
  // 迁移弹窗中的目标标签（默认沿用源镜像标签）
  const [transferTag, setTransferTag] = useState('');
  // 迁移是否进行中
  const [transferring, setTransferring] = useState(false);
  // 搜索镜像弹窗是否打开（区别于顶部本地过滤搜索框）
  const [searchOpen, setSearchOpen] = useState(false);
  // 搜索弹窗中的关键字输入
  const [searchTerm, setSearchTerm] = useState('');
  // 搜索是否进行中
  const [searching, setSearching] = useState(false);
  // docker search 返回的搜索结果列表
  const [searchResults, setSearchResults] = useState<
    { name: string; description?: string; star_count?: number; is_official?: boolean; is_automated?: boolean }[]
  >([]);
  // 正在拉取的搜索结果镜像名（用于行内按钮 loading 显示）
  const [pullResultRef, setPullResultRef] = useState('');

  const fetchImages = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<ImageItem[]>('/api/images');
      setImages(data || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || '拉取镜像列表失败');
      showToast(e?.message || '拉取镜像列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  /** 加载镜像优化建议数据（失败时静默置空，不影响主列表） */
  const loadSuggestions = useCallback(async () => {
    try {
      const data = await get<ImageSuggestions>('/api/images/suggestions');
      setSuggestions(data);
    } catch {
      setSuggestions(null);
    }
  }, []);

  useEffect(() => {
    fetchImages();
    loadSuggestions();
  }, [fetchImages, loadSuggestions, refreshKey]);

  // 加载可选的镜像源列表
  const loadSources = useCallback(async () => {
    try {
      const data = await get<{ sources: { id: string; host: string; name?: string; enabled?: boolean }[] }>(
        '/api/hub/sources'
      );
      setSources(data?.sources || []);
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  const handlePull = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可拉取镜像', 'error');
      setPullOpen(false);
      return;
    }
    const ref = pullRef.trim();
    if (!ref) {
      showToast('请输入镜像名称', 'error');
      return;
    }
    setPulling(true);
    try {
      await post('/api/images/pull', { ref, source: pullSource || undefined });
      showToast('镜像拉取成功');
      setPullOpen(false);
      setPullRef('');
      setPullSource('');
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '镜像拉取失败', 'error');
    } finally {
      setPulling(false);
    }
  }, [canManage, pullRef, pullSource, showToast]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canManage) {
      showToast('仅管理员可删除镜像', 'error');
      setDeleteTarget(null);
      return;
    }
    const name = deleteTarget.RepoTags?.[0] || deleteTarget.Id;
    setDeleting(true);
    try {
      await del(imageDeleteUrl(name));
      showToast('镜像删除成功');
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '镜像删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canManage, deleteTarget, showToast]);

  /**
   * 执行镜像搜索（调用后端 docker search 接口，引擎侧检索）
   */
  const handleSearch = useCallback(async () => {
    const term = searchTerm.trim();
    if (!term) {
      showToast('请输入搜索关键字', 'error');
      return;
    }
    setSearching(true);
    try {
      const data = await post<{ ok: boolean; results: any[] }>('/api/images/search', { term });
      setSearchResults(data?.results || []);
    } catch (e: any) {
      showToast(e?.message || '镜像搜索失败', 'error');
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchTerm, showToast]);

  /**
   * 打开搜索镜像弹窗时清空上次结果
   */
  const openSearch = useCallback(() => {
    setSearchTerm('');
    setSearchResults([]);
    setPullResultRef('');
    setSearchOpen(true);
  }, []);

  /**
   * 从搜索结果中拉取指定镜像（复用 /api/images/pull，走后端默认镜像源）
   * @param name 搜索结果中的镜像名
   */
  const handlePullResult = useCallback(
    async (name: string) => {
      if (!canManage) {
        showToast('仅管理员可拉取镜像', 'error');
        return;
      }
      setPullResultRef(name);
      try {
        // 不传 source，由后端自动使用默认启用镜像源
        await post('/api/images/pull', { ref: name });
        showToast(`镜像 ${name} 拉取成功`);
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || '镜像拉取失败', 'error');
      } finally {
        setPullResultRef('');
      }
    },
    [canManage, showToast],
  );

  const handlePrune = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可清理镜像', 'error');
      setPruneOpen(false);
      return;
    }
    setPruning(true);
    try {
      // all=false：仅清理悬空镜像（dangling）
      const res = await post<any>('/api/images/prune', { all: false });
      const freed = res?.spaceReclaimed != null ? formatSize(res.spaceReclaimed) : '';
      showToast(freed ? `清理完成，释放 ${freed}` : '清理完成');
      setPruneOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '清理失败', 'error');
    } finally {
      setPruning(false);
    }
  }, [canManage, showToast]);

  /**
   * 一键清理所有未被容器使用的镜像（all=true，含非悬空未使用镜像）
   */
  const handlePruneAll = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可清理镜像', 'error');
      setPruneAllOpen(false);
      return;
    }
    setPruningAll(true);
    try {
      const res = await post<any>('/api/images/prune', { all: true });
      const freed = res?.spaceReclaimed != null ? formatSize(res.spaceReclaimed) : '';
      showToast(freed ? `清理完成，释放 ${freed}` : '清理完成');
      setPruneAllOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '清理失败', 'error');
    } finally {
      setPruningAll(false);
    }
  }, [canManage, showToast]);

  /** 返回镜像显示标签（无标签时显示 <none>） */
  const displayName = (img: ImageItem): string => img.RepoTags?.[0] || '<none>';

  /**
   * 打开打标签弹窗：以当前镜像名为默认仓库，默认标签 latest
   * @param img 目标镜像
   */
  const openTag = useCallback((img: ImageItem) => {
    if (!canManage) {
      showToast('仅管理员可给镜像打标签', 'error');
      return;
    }
    const base = (img.RepoTags?.[0] || '').split('@')[0];
    const idx = base.lastIndexOf(':');
    // 仓库名里若不含 : 或 : 后紧跟 /（如 registry:5000/repo）则不拆分
    const slash = base.lastIndexOf('/');
    if (idx > -1 && idx > slash) {
      const repo = base.slice(0, idx);
      const tag = base.slice(idx + 1);
      setTagRepo(repo);
      setTagTag(tag || 'latest');
    } else {
      setTagRepo(base || img.RepoTags?.[0] || img.Id);
      setTagTag('latest');
    }
    setTagTarget(img);
  }, [canManage, showToast]);

  /**
   * 提交打标签请求
   */
  const handleTag = useCallback(async () => {
    if (!tagTarget) return;
    if (!canManage) {
      showToast('仅管理员可给镜像打标签', 'error');
      setTagTarget(null);
      return;
    }
    const repo = tagRepo.trim();
    const tag = tagTag.trim() || 'latest';
    if (!repo) {
      showToast('请输入仓库名', 'error');
      return;
    }
    const name = tagTarget.RepoTags?.[0] || tagTarget.Id;
    setTagging(true);
    try {
      await post('/api/images/tag', { name, repo, tag });
      showToast('镜像打标签成功');
      setTagTarget(null);
      setTagRepo('');
      setTagTag('');
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '镜像打标签失败', 'error');
    } finally {
      setTagging(false);
    }
  }, [canManage, tagTarget, tagRepo, tagTag, showToast]);

  /**
   * 导出指定镜像（下载 tar 文件）
   * @param img 目标镜像
   */
  const handleExport = useCallback(
    async (img: ImageItem) => {
      const name = img.RepoTags?.[0] || img.Id;
      setExportingName(name);
      try {
        await downloadImage(name);
        showToast('镜像导出已开始');
      } catch (e: any) {
        showToast(e?.message || '镜像导出失败', 'error');
      } finally {
        setExportingName('');
      }
    },
    [showToast],
  );

  /**
   * 打开跨引擎迁移弹窗：拉取引擎列表，默认源引擎为当前引擎，目标引擎选第一个其他引擎，
   * 目标标签默认沿用源镜像标签
   * @param img 待迁移的镜像
   */
  const openTransfer = useCallback(
    async (img: ImageItem) => {
      if (!canOperate()) {
        showToast('仅运维或管理员可迁移镜像', 'error');
        return;
      }
      const name = img.RepoTags?.[0] || img.Id;
      // 从镜像名中解析出标签（xxx:tag 的 tag 部分，无则默认为 latest）
      const base = name.split('@')[0];
      const idx = base.lastIndexOf(':');
      const slash = base.lastIndexOf('/');
      const defaultTag = idx > -1 && idx > slash ? base.slice(idx + 1) : 'latest';
      setTransferTag(defaultTag);
      setTransferTarget(img);
      try {
        const data = await get<{ engines: { id: string; name: string; isCurrent: boolean }[] }>('/api/engines');
        const list = data?.engines || [];
        setEngineList(list);
        // 默认源引擎为当前引擎，目标引擎为第一个非当前引擎
        const cur = list.find((e) => e.isCurrent);
        setTransferSourceId(cur?.id || list[0]?.id || '');
        const others = list.filter((e) => e.id !== (cur?.id || list[0]?.id));
        setTransferTargetId(others[0]?.id || '');
      } catch (e: any) {
        showToast(e?.message || '加载引擎列表失败', 'error');
      }
    },
    [showToast],
  );

  /**
   * 提交跨引擎迁移请求
   */
  const handleTransfer = useCallback(async () => {
    if (!transferTarget) return;
    if (!canOperate()) {
      showToast('仅运维或管理员可迁移镜像', 'error');
      setTransferTarget(null);
      return;
    }
    if (!transferSourceId || !transferTargetId) {
      showToast('请选择源引擎与目标引擎', 'error');
      return;
    }
    if (transferSourceId === transferTargetId) {
      showToast('源引擎与目标引擎不能相同', 'error');
      return;
    }
    const name = transferTarget.RepoTags?.[0] || transferTarget.Id;
    setTransferring(true);
    try {
      const data = await post<{ ok: boolean; loaded?: string; error?: string }>('/api/transfer/images', {
        image: name,
        sourceEngineId: transferSourceId,
        targetEngineId: transferTargetId,
        tag: transferTag.trim() || undefined,
      });
      if (!data?.ok) {
        throw new Error(data?.error || '镜像迁移失败');
      }
      showToast(`镜像迁移成功（${data?.loaded || name}）`);
      setTransferTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '镜像迁移失败', 'error');
    } finally {
      setTransferring(false);
    }
  }, [transferTarget, transferSourceId, transferTargetId, transferTag, showToast]);

  /**
   * 提交镜像导入请求（上传 tar 文件到后端 docker load）
   */
  const handleImport = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可导入镜像', 'error');
      setImportOpen(false);
      return;
    }
    if (!importFile) {
      showToast('请先选择要导入的 .tar 镜像文件', 'error');
      return;
    }
    setImporting(true);
    try {
      // 直接以二进制流的方式上传文件，携带鉴权 token
      const res = await fetch('/api/images/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: importFile,
      });
      let data: any = null;
      const text = await res.text().catch(() => '');
      try {
        data = JSON.parse(text);
      } catch {
        /* 忽略非 JSON 响应体 */
      }
      if (!res.ok) {
        throw new Error(data?.error || `镜像导入失败 (${res.status})`);
      }
      showToast('镜像导入成功');
      setImportOpen(false);
      setImportFile(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '镜像导入失败', 'error');
    } finally {
      setImporting(false);
    }
  }, [canManage, importFile, showToast]);

  /**
   * 打开推送弹窗：以当前镜像完整名称为默认推送目标
   * @param img 目标镜像
   */
  const openPush = useCallback((img: ImageItem) => {
    if (!canManage) {
      showToast('仅管理员可推送镜像', 'error');
      return;
    }
    setPushName(img.RepoTags?.[0] || img.Id);
    setPushUsername('');
    setPushPassword('');
    setPushTarget(img);
  }, [canManage, showToast]);

  /**
   * 提交镜像推送请求
   */
  const handlePush = useCallback(async () => {
    if (!pushTarget) return;
    if (!canManage) {
      showToast('仅管理员可推送镜像', 'error');
      setPushTarget(null);
      return;
    }
    const name = pushName.trim();
    if (!name) {
      showToast('请输入推送目标仓库名', 'error');
      return;
    }
    setPushing(true);
    try {
      await post('/api/images/push', {
        name,
        auth:
          pushUsername || pushPassword
            ? { username: pushUsername, password: pushPassword }
            : undefined,
      });
      showToast('镜像推送成功');
      setPushTarget(null);
      setPushName('');
      setPushUsername('');
      setPushPassword('');
    } catch (e: any) {
      showToast(e?.message || '镜像推送失败', 'error');
    } finally {
      setPushing(false);
    }
  }, [canManage, pushTarget, pushName, pushUsername, pushPassword, showToast]);

  /** 根据关键字过滤后的镜像列表（按镜像名或 ID 匹配） */
  const filteredImages = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [...images];
    return images.filter((img) => {
      const names = (img.RepoTags || []).join(' ').toLowerCase();
      const id = (img.Id || '').toLowerCase();
      return names.includes(kw) || id.includes(kw);
    });
  }, [images, keyword]);

  /** 镜像大小排序方向：'' 不排序 / 'asc' / 'desc' */
  const [sizeSort, setSizeSort] = useState('');

  /** 按镜像大小排序的列表（点击表头切换） */
  const sortedImages = useMemo(() => {
    if (!sizeSort) return filteredImages;
    const arr = [...filteredImages];
    arr.sort((a, b) => (sizeSort === 'asc' ? (a.Size || 0) - (b.Size || 0) : (b.Size || 0) - (a.Size || 0)));
    return arr;
  }, [filteredImages, sizeSort]);

  function toggleSizeSort() {
    setSizeSort((s) => (s === '' ? 'desc' : s === 'desc' ? 'asc' : ''));
    setPage(1);
  }

  /** 总页数（至少 1 页） */
  const totalPages = Math.max(1, Math.ceil(sortedImages.length / pageSize));

  /** 当前页码：当分页组合变化导致页码越界时，回退到最大有效页 */
  const safePage = Math.min(page, Math.max(1, totalPages));

  /** 切换每页条数：回到第一页并清空跳转输入 */
  function changePageSize(size: number) {
    setPageSize(size);
    setPage(1);
    setPageJump('');
  }

  /** 跳转到指定页码（限制在有效范围内） */
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

  /** 当前页起始序号（用于"第 x-y 条"展示，空列表时为 0） */
  const pageStart = sortedImages.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  /** 当前页结束序号 */
  const pageEnd = Math.min(safePage * pageSize, sortedImages.length);

  /** 当前页要展示的镜像 */
  const pageItems = sortedImages.slice((safePage - 1) * pageSize, safePage * pageSize);

  /** 跳转到镜像详情页（name 用 encodeURIComponent 编码，页面内 useParams 会自动还原） */
  const goDetail = (img: ImageItem) => {
    const name = img.RepoTags?.[0] || img.Id;
    navigate(`/image/${encodeURIComponent(name)}`);
  };

  return (
    <div className="page">
      {/* 镜像优化建议卡片 */}
      {suggestions && (
        <div style={{ marginBottom: 16 }}>
          <Card title="镜像优化建议">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 12,
                marginBottom: 16,
              }}
            >
              <div style={suggestStatStyle}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>总镜像数</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {suggestions.totalCount}
                </div>
              </div>
              <div style={suggestStatStyle}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>总大小</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {formatSize(suggestions.totalSize)}
                </div>
              </div>
              <div style={suggestStatStyle}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>悬空镜像</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {suggestions.danglingCount}
                </div>
              </div>
              <div
                style={{ ...suggestStatStyle, cursor: 'pointer' }}
                onClick={() => setUnusedOpen(true)}
                title="点击查看未使用镜像详情"
              >
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>未使用镜像</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--primary)' }}>
                  {suggestions.unused.length}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>点击查看详情</div>
              </div>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Top 5 大镜像
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>镜像</th>
                  <th>大小</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.topLarge.slice(0, 5).map((img) => (
                  <tr key={img.id}>
                    <td className="col-name">
                      <div className="name-main" title={img.tags.join(', ') || '<none>'}>
                        {img.tags[0] || '<none>'}
                      </div>
                      {img.tags.length > 1 && (
                        <div className="name-sub">+{img.tags.length - 1} 个标签</div>
                      )}
                    </td>
                    <td>{formatSize(img.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="danger" onClick={() => setPruneAllOpen(true)} disabled={!canManage}>
                一键清理未使用镜像
              </Button>
            </div>
          </Card>
        </div>
      )}

      <Card
        title="镜像"
        extra={
          <div className="toolbar">
            <input
              className="input images-search"
              placeholder="搜索镜像名或 ID"
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)}>
              刷新
            </Button>
            <Button variant="secondary" onClick={() => setPruneOpen(true)} disabled={!canManage}>
              清理悬空镜像
            </Button>
            <Button variant="secondary" onClick={() => setImportOpen(true)} disabled={!canManage}>
              导入镜像
            </Button>
            <Button variant="secondary" onClick={openSearch}>
              搜索镜像
            </Button>
            <Button variant="primary" onClick={() => setPullOpen(true)} disabled={!canManage}>
              拉取镜像
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="拉取镜像列表失败"
            description={loadError || '请检查 Docker 引擎连接后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={fetchImages}>
                重试
              </Button>
            }
          />
        ) : sortedImages.length === 0 ? (
          <Empty
            kind={keyword ? 'search' : 'empty'}
            title={keyword ? '未找到匹配镜像' : '暂无镜像'}
            description={keyword ? '尝试更换搜索关键字' : '点击右上角'}
          />
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>仓库标签</th>
                  <th>镜像ID</th>
                  <th className="th-sort" onClick={toggleSizeSort} title="点击按大小排序">
                    大小 {sizeSort === 'asc' ? '↑' : sizeSort === 'desc' ? '↓' : ''}
                  </th>
                  <th>构建时间</th>
                  <th>拉取时间</th>
                  <th className="col-actions">操作</th>
                </tr>
              </thead>
            <tbody>
              {pageItems.map((img, idx) => (
                <tr key={img.Id || idx}>
                  <td className="col-name">
                    <div className="name-main" title={displayName(img)}>
                      {displayName(img)}
                    </div>
                    {img.RepoTags && img.RepoTags.length > 1 && (
                      <div className="name-sub">+{img.RepoTags.length - 1} 个标签</div>
                    )}
                  </td>
                  <td className="col-mono">{img.Id.slice(0, 12)}</td>
                  <td>{formatSize(img.Size)}</td>
                  <td>{formatTime(img.Created)}</td>
                  <td>{formatTime(img.pullTime)}</td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <Button variant="ghost" size="sm" onClick={() => goDetail(img)}>
                        详情
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={exportingName === (img.RepoTags?.[0] || img.Id)}
                        onClick={() => handleExport(img)}
                      >
                        导出
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canOperate()}
                        onClick={() => openTransfer(img)}
                      >
                        迁移
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openTag(img)} disabled={!canManage}>
                        打标签
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openPush(img)} disabled={!canManage}>
                        推送
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(img)} disabled={!canManage}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 分页控件 */}
          <div className="images__pagination">
            <div className="images__pagination-left">
              <span className="images__pagination-size">
                每页
                <Select
                  className="images__pagesize"
                  value={String(pageSize)}
                  onChange={(e) => changePageSize(Number(e.target.value))}
                >
                  {PAGE_SIZE_OPTIONS.map((s) => (
                    <option key={s} value={String(s)}>
                      {s}
                    </option>
                  ))}
                </Select>
                条
              </span>
              <span className="images__pagination-info">
                共 {sortedImages.length} 条，当前第 {pageStart}-{pageEnd} 条
              </span>
            </div>
            <div className="images__pagination-controls">
              <button
                className="images__page-btn"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
              >
                上一页
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  className={`images__page-btn ${p === safePage ? 'images__page-btn--active' : ''}`}
                  onClick={() => setPage(p)}
                >
                  {p}
                </button>
              ))}
              <button
                className="images__page-btn"
                disabled={safePage >= totalPages}
                onClick={() => setPage(safePage + 1)}
              >
                下一页
              </button>
              <span className="images__page-jump">
                <Input
                  className="images__page-jump-input"
                  type="number"
                  min={1}
                  max={totalPages}
                  placeholder="页码"
                  value={pageJump}
                  onChange={(e) => setPageJump(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handlePageJump();
                  }}
                />
                <Button variant="ghost" size="sm" onClick={handlePageJump}>
                  跳转
                </Button>
              </span>
            </div>
          </div>
          </>
        )}
      </Card>

      {/* 搜索镜像弹窗 */}
      <Modal
        open={searchOpen}
        title="搜索镜像"
        width={720}
        onClose={() => !searching && setSearchOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSearchOpen(false)} disabled={searching}>
              关闭
            </Button>
            <Button onClick={handleSearch} loading={searching}>
              搜索
            </Button>
          </>
        }
      >
        <div className="search-modal">
          <div className="search-modal__bar">
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="输入镜像关键字，如 nginx"
              onKeyDown={(e) => {
                // 回车触发搜索
                if (e.key === 'Enter' && !searching) handleSearch();
              }}
              autoFocus
            />
            <Button onClick={handleSearch} loading={searching}>
              搜索
            </Button>
          </div>
          {searching ? (
            <div className="search-modal__tip">搜索中，请稍候…</div>
          ) : searchTerm.trim() && searchResults.length === 0 ? (
            <Empty title="未找到镜像" description="尝试更换搜索关键字后重试" />
          ) : searchResults.length > 0 ? (
            <table className="data-table search-table">
              <thead>
                <tr>
                  <th>镜像名称</th>
                  <th>描述</th>
                  <th>星数</th>
                  <th>官方</th>
                  <th className="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.map((r, idx) => (
                  <tr key={r.name || idx}>
                    <td className="col-name">
                      <div className="name-main" title={r.name}>
                        {r.name}
                      </div>
                      {r.is_automated && <div className="name-sub">自动构建</div>}
                    </td>
                    <td className="search-desc" title={r.description}>
                      {r.description || '-'}
                    </td>
                    <td className="col-mono">{r.star_count ?? 0}</td>
                    <td>{r.is_official ? '官方' : '-'}</td>
                    <td className="col-actions">
                      <div className="row-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={pullResultRef === r.name}
                          disabled={!canManage}
                          onClick={() => handlePullResult(r.name)}
                        >
                          拉取
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="search-modal__tip">输入关键字后点击“搜索”查看结果。</div>
          )}
        </div>
      </Modal>

      {/* 拉取镜像弹窗 */}
      <Modal
        open={pullOpen}
        title="拉取镜像"
        onClose={() => setPullOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPullOpen(false)} disabled={pulling}>
              取消
            </Button>
            <Button onClick={handlePull} loading={pulling} disabled={!canManage}>
              拉取
            </Button>
          </>
        }
      >
        <Field label="镜像名称" required hint="例如：nginx:latest 或 docker.io/library/nginx">
          <Input
            value={pullRef}
            onChange={(e) => setPullRef(e.target.value)}
            placeholder="镜像名称"
            autoFocus
          />
        </Field>
        <Field label="镜像源" hint="留空则使用后端默认镜像源">
          <Select value={pullSource} onChange={(e) => setPullSource(e.target.value)}>
            <option value="">使用默认镜像源</option>
            {sources
              .filter((s) => s.enabled !== false)
              .map((s) => (
                <option key={s.id} value={s.host}>
                  {s.name ? `${s.name} (${s.host})` : s.host}
                </option>
              ))}
          </Select>
        </Field>
        <div className="pull-source-hint">
          配置了镜像源（设置 → 镜像中心 → 镜像源）时，拉取会自动带上源前缀以加速访问。
        </div>
      </Modal>

      {/* 打标签弹窗 */}
      <Modal
        open={!!tagTarget}
        title={tagTarget ? `给镜像打标签` : '打标签'}
        onClose={() => !tagging && setTagTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTagTarget(null)} disabled={tagging}>
              取消
            </Button>
            <Button onClick={handleTag} loading={tagging} disabled={!canManage}>
              确认
            </Button>
          </>
        }
      >
        {tagTarget && (
          <>
            <Field label="原镜像" hint={displayName(tagTarget)} />
            <Field label="仓库名" required hint="例如：myrepo/myimage">
              <Input
                value={tagRepo}
                onChange={(e) => setTagRepo(e.target.value)}
                placeholder="myrepo/myimage"
                autoFocus
              />
            </Field>
            <Field label="标签" hint="留空默认 latest">
              <Input
                value={tagTag}
                onChange={(e) => setTagTag(e.target.value)}
                placeholder="latest"
              />
            </Field>
          </>
        )}
      </Modal>

      {/* 导入镜像弹窗 */}
      <Modal
        open={importOpen}
        title="导入镜像"
        onClose={() => !importing && setImportOpen(false)}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setImportOpen(false)}
              disabled={importing}
            >
              取消
            </Button>
            <Button onClick={handleImport} loading={importing} disabled={!canManage}>
              导入
            </Button>
          </>
        }
      >
        <Field label="镜像 tar 文件" required hint="选择 docker save 导出的 .tar 文件（最大 1GB）">
          <input
            type="file"
            accept=".tar,.tar.gz"
            className="file-input"
            onChange={(e) => setImportFile(e.target.files?.[0] || null)}
          />
        </Field>
      </Modal>

      {/* 推送镜像弹窗 */}
      <Modal
        open={!!pushTarget}
        title={pushTarget ? `推送镜像` : '推送镜像'}
        onClose={() => !pushing && setPushTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPushTarget(null)} disabled={pushing}>
              取消
            </Button>
            <Button onClick={handlePush} loading={pushing} disabled={!canManage}>
              推送
            </Button>
          </>
        }
      >
        {pushTarget && (
          <>
            <Field label="原镜像" hint={displayName(pushTarget)} />
            <Field label="推送目标（仓库名:标签）" required hint="例如：registry.example.com/myrepo/myimage:v1">
              <Input
                value={pushName}
                onChange={(e) => setPushName(e.target.value)}
                placeholder="registry.example.com/myrepo/myimage:v1"
                autoFocus
              />
            </Field>
            <Field label="Registry 用户名（可选）" hint="私有仓库需要认证时填写">
              <Input
                value={pushUsername}
                onChange={(e) => setPushUsername(e.target.value)}
                placeholder="用户名"
              />
            </Field>
            <Field label="Registry 密码（可选）">
              <Input
                type="password"
                value={pushPassword}
                onChange={(e) => setPushPassword(e.target.value)}
                placeholder="密码"
              />
            </Field>
          </>
        )}
      </Modal>

      {/* 跨引擎迁移镜像弹窗 */}
      <Modal
        open={!!transferTarget}
        title={transferTarget ? `迁移镜像` : '迁移镜像'}
        onClose={() => !transferring && setTransferTarget(null)}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setTransferTarget(null)}
              disabled={transferring}
            >
              取消
            </Button>
            <Button onClick={handleTransfer} loading={transferring} disabled={!canOperate()}>
              迁移
            </Button>
          </>
        }
      >
        {transferTarget && (
          <>
            <Field label="原镜像" hint={displayName(transferTarget)} />
            <Field label="源引擎" required hint="当前镜像所在引擎">
              <Select
                value={transferSourceId}
                onChange={(e) => setTransferSourceId(e.target.value)}
              >
                <option value="" disabled>
                  请选择源引擎
                </option>
                {engineList.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.isCurrent ? '（当前）' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="目标引擎" required hint="镜像将被迁移到此引擎">
              <Select
                value={transferTargetId}
                onChange={(e) => setTransferTargetId(e.target.value)}
              >
                <option value="" disabled>
                  请选择目标引擎
                </option>
                {engineList
                  .filter((e) => e.id !== transferSourceId)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                      {e.isCurrent ? '（当前）' : ''}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="目标标签" hint="留空默认沿用源镜像标签">
              <Input
                value={transferTag}
                onChange={(e) => setTransferTag(e.target.value)}
                placeholder="latest"
              />
            </Field>
          </>
        )}
      </Modal>

      {/* 删除镜像确认框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除镜像"
        message={`确定要删除镜像 "${deleteTarget ? displayName(deleteTarget) : ''}" 吗？此操作不可恢复。`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 清理悬空镜像确认框 */}
      <ConfirmDialog
        open={pruneOpen}
        title="清理悬空镜像"
        message="确定要清理所有悬空镜像（无标签且未被引用）吗？此操作不可恢复。"
        confirmText="清理"
        danger
        loading={pruning}
        onConfirm={handlePrune}
        onCancel={() => setPruneOpen(false)}
      />

      {/* 一键清理未使用镜像确认框 */}
      <ConfirmDialog
        open={pruneAllOpen}
        title="一键清理未使用镜像"
        message="确定要清理所有未被容器使用的镜像吗？将删除全部未使用镜像（含非悬空镜像），此操作不可恢复。"
        confirmText="清理"
        danger
        loading={pruningAll}
        onConfirm={handlePruneAll}
        onCancel={() => setPruneAllOpen(false)}
      />

      {/* 未使用镜像详情弹窗 */}
      <Modal
        open={unusedOpen}
        title="未使用镜像详情"
        width={680}
        onClose={() => setUnusedOpen(false)}
        footer={
          <Button variant="secondary" onClick={() => setUnusedOpen(false)}>
            关闭
          </Button>
        }
      >
        {!suggestions || suggestions.unused.length === 0 ? (
          <Empty title="暂无未使用镜像" description="没有超过 30 天未使用的镜像" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>镜像</th>
                <th>大小</th>
                <th>最近拉取</th>
                <th>未使用天数</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.unused.map((img) => (
                <tr key={img.id}>
                  <td className="col-name">
                    <div className="name-main" title={img.tags.join(', ') || '<none>'}>
                      {img.tags[0] || '<none>'}
                    </div>
                  </td>
                  <td>{formatSize(img.size)}</td>
                  <td>{formatTime(img.lastPullAt)}</td>
                  <td>{img.daysSincePull} 天</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </div>
  );
}
