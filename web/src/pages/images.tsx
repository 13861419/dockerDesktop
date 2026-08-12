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
import { getToken } from '../api/auth';
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

/**
 * 镜像列表页组件
 */
export default function ImagesPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
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
  // 搜索关键字（按镜像名/ID 本地过滤）
  const [keyword, setKeyword] = useState('');
  // 分页：每页显示的镜像条数
  const PAGE_SIZE = 15;
  // 当前页码（从 1 开始）
  const [page, setPage] = useState(1);
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

  useEffect(() => {
    fetchImages();
  }, [fetchImages, refreshKey]);

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
  }, [pullRef, pullSource, showToast]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
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
  }, [deleteTarget, showToast]);

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
    [showToast],
  );

  const handlePrune = useCallback(async () => {
    setPruning(true);
    try {
      const res = await post<any>('/api/images/prune');
      const freed = res?.SpaceReclaimed != null ? formatSize(res.SpaceReclaimed) : '';
      showToast(freed ? `清理完成，释放 ${freed}` : '清理完成');
      setPruneOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '清理失败', 'error');
    } finally {
      setPruning(false);
    }
  }, [showToast]);

  /** 返回镜像显示标签（无标签时显示 <none>） */
  const displayName = (img: ImageItem): string => img.RepoTags?.[0] || '<none>';

  /**
   * 打开打标签弹窗：以当前镜像名为默认仓库，默认标签 latest
   * @param img 目标镜像
   */
  const openTag = useCallback((img: ImageItem) => {
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
  }, []);

  /**
   * 提交打标签请求
   */
  const handleTag = useCallback(async () => {
    if (!tagTarget) return;
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
  }, [tagTarget, tagRepo, tagTag, showToast]);

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
   * 提交镜像导入请求（上传 tar 文件到后端 docker load）
   */
  const handleImport = useCallback(async () => {
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
  }, [importFile, showToast]);

  /**
   * 打开推送弹窗：以当前镜像完整名称为默认推送目标
   * @param img 目标镜像
   */
  const openPush = useCallback((img: ImageItem) => {
    setPushName(img.RepoTags?.[0] || img.Id);
    setPushUsername('');
    setPushPassword('');
    setPushTarget(img);
  }, []);

  /**
   * 提交镜像推送请求
   */
  const handlePush = useCallback(async () => {
    if (!pushTarget) return;
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
  }, [pushTarget, pushName, pushUsername, pushPassword, showToast]);

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
  const totalPages = Math.max(1, Math.ceil(sortedImages.length / PAGE_SIZE));

  /** 当前页码：当分页组合变化导致页码越界时，回退到最大有效页 */
  const safePage = Math.min(page, Math.max(1, totalPages));

  /** 当前页起始序号（用于"第 x-y 条"展示，空列表时为 0） */
  const pageStart = sortedImages.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  /** 当前页结束序号 */
  const pageEnd = Math.min(safePage * PAGE_SIZE, sortedImages.length);

  /** 当前页要展示的镜像 */
  const pageItems = sortedImages.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  /** 跳转到镜像详情页（name 用 encodeURIComponent 编码，页面内 useParams 会自动还原） */
  const goDetail = (img: ImageItem) => {
    const name = img.RepoTags?.[0] || img.Id;
    navigate(`/image/${encodeURIComponent(name)}`);
  };

  return (
    <div className="page">
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
            <Button variant="secondary" onClick={() => setPruneOpen(true)}>
              清理未使用镜像
            </Button>
            <Button variant="secondary" onClick={() => setImportOpen(true)}>
              导入镜像
            </Button>
            <Button variant="secondary" onClick={openSearch}>
              搜索镜像
            </Button>
            <Button variant="primary" onClick={() => setPullOpen(true)}>
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
                      <Button variant="ghost" size="sm" onClick={() => openTag(img)}>
                        打标签
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openPush(img)}>
                        推送
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(img)}>
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
            <span className="images__pagination-info">
              共 {sortedImages.length} 条，当前第 {pageStart}-{pageEnd} 条
            </span>
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
            <Button onClick={handlePull} loading={pulling}>
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
            <Button onClick={handleTag} loading={tagging}>
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
            <Button onClick={handleImport} loading={importing}>
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
            <Button onClick={handlePush} loading={pushing}>
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

      {/* 清理未使用镜像确认框 */}
      <ConfirmDialog
        open={pruneOpen}
        title="清理未使用镜像"
        message="确定要清理所有未被容器引用的镜像吗？此操作不可恢复。"
        confirmText="清理"
        danger
        loading={pruning}
        onConfirm={handlePrune}
        onCancel={() => setPruneOpen(false)}
      />
    </div>
  );
}
