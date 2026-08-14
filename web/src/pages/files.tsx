/**
 * 容器内文件管理页
 *
 * 顶部下拉选择容器后，进入该容器的文件系统浏览。
 * 支持文件列表查看（面包屑进入子目录）、预览、下载、上传、新建目录、
 * 重命名与删除（删除目录时递归删除，需二次确认）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import { Field, Input, Select } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, download } from '../api/client';
import { getToken, isAdmin } from '../api/auth';
import { ContainerFileItem } from '../types';
import './files.less';

/** 容器下拉选项（来自 /api/containers?all=true） */
interface ContainerOption {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
}

/** 预览弹窗内容 */
interface PreviewData {
  content: string;
  truncated: boolean;
}

/** 待重命名的文件目标 */
interface RenameTarget {
  item: ContainerFileItem;
  path: string;
}

/** 待删除的文件目标 */
interface DeleteTarget {
  item: ContainerFileItem;
  path: string;
}

/** 根目录标识，用于文件名拼接（不要以斜杠为根名） */
const ROOT_NAME = '/';

/**
 * 规范化拼接路径：确保目录以斜杠结尾，拼接后合并多余斜杠
 * @param dir 父目录路径（可为空、斜杠或具体目录）
 * @param name 子项名称
 * @returns 拼接后的完整路径
 */
function joinPath(dir: string, name: string): string {
  const base = dir && dir !== '/' ? dir.replace(/\/+$/, '') : '';
  return base ? `${base}/${name}` : name;
}

/**
 * 容器内文件管理页组件
 */
export default function FilesPage() {
  const { showToast } = useToast();
  // 是否可写（上传/新建目录/重命名/删除）：容器内文件写操作仅管理员可用，普通用户可只读浏览
  const canManage = isAdmin();
  // 容器下拉选项列表
  const [containers, setContainers] = useState<ContainerOption[]>([]);
  // 当前选中的容器 id（'' 表示未选择）
  const [selectedId, setSelectedId] = useState('');
  // 当前路径的面包屑分段（如 ['/', 'etc', 'nginx']）
  const [crumbs, setCrumbs] = useState<string[]>([ROOT_NAME]);
  // 当前目录文件列表
  const [items, setItems] = useState<ContainerFileItem[]>([]);
  // 列表加载中
  const [loading, setLoading] = useState(false);
  // 文件列表加载失败信息（如容器未运行）
  const [errorMsg, setErrorMsg] = useState('');
  // 预览弹窗
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewName, setPreviewName] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  // 上传输入框引用，点击「上传」按钮触发
  const uploadRef = useRef<HTMLInputElement>(null);
  // 上传进行中
  const [uploading, setUploading] = useState(false);
  // 新建目录弹窗
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [creatingDir, setCreatingDir] = useState(false);
  // 重命名弹窗
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  /**
   * 计算当前路径：由面包屑分段拼出完整路径
   */
  const currentPath = useCallback(() => {
    const parts = crumbs.filter((p) => p !== ROOT_NAME);
    return parts.length ? parts.join('/') : '/';
  }, [crumbs]);

  /**
   * 拉取容器下拉列表
   */
  const loadContainers = useCallback(async () => {
    try {
      const data = await get<ContainerOption[]>('/api/containers', { all: true });
      setContainers(data || []);
    } catch (e: any) {
      showToast(e?.message || '获取容器列表失败', 'error');
    }
  }, [showToast]);

  useEffect(() => {
    loadContainers();
  }, [loadContainers]);

  /**
   * 拉取指定路径下的文件列表
   * @param containerId 容器 id
   * @param path 目录路径
   */
  const loadFiles = useCallback(
    async (containerId: string, path: string) => {
      if (!containerId) return;
      setLoading(true);
      setErrorMsg('');
      try {
        const data = await get<{ items: ContainerFileItem[] }>(`/api/files/${containerId}/ls`, {
          path,
        });
        setItems((data?.items as ContainerFileItem[]) || []);
      } catch (e: any) {
        // 后端会返回"请先启动容器"等错误，捕获后 toast 展示并清空列表
        showToast(e?.message || '加载文件列表失败', 'error');
        setItems([]);
        setErrorMsg(e?.message || '加载文件列表失败');
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  /**
   * 选中某个容器后，重置面包屑并进入其根目录。
   * 实际加载交给下方 useEffect（监听 crumbs/selectedId）统一触发。
   * @param id 容器 id
   */
  const handleSelectContainer = (id: string) => {
    setSelectedId(id);
    setCrumbs([ROOT_NAME]);
    setItems([]);
  };

  /**
   * 进入子目录：点击目录行时触发
   * @param name 子目录名
   */
  const enterDir = (name: string) => {
    if (!selectedId) return;
    setCrumbs((prev) => [...prev, name]);
  };

  /**
   * 面包屑导航：跳转到指定分段所在的目录
   * @param index 分段索引（0=根目录）
   */
  const navigateCrumb = (index: number) => {
    if (!selectedId) return;
    setCrumbs((prev) => prev.slice(0, index + 1));
  };

  /**
   * 切换到上/下级目录后，根据当前 crumbs 重新加载列表
   * 仅在选中容器且有路径变化时执行
   */
  useEffect(() => {
    if (selectedId) {
      loadFiles(selectedId, currentPath());
    }
    // currentPath 依赖 crumbs，此处触发即表示路径已更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crumbs, selectedId]);

  /**
   * 预览文件内容：读取文本并展示在弹窗中
   * @param item 文件项
   */
  const handlePreview = async (item: ContainerFileItem) => {
    if (!selectedId) return;
    const path = joinPath(currentPath(), item.name);
    setPreviewName(item.name);
    setPreviewLoading(true);
    setPreview(null);
    try {
      const data = await get<PreviewData>(`/api/files/${selectedId}/read`, { path });
      setPreview({ content: data?.content ?? '', truncated: !!data?.truncated });
    } catch (e: any) {
      showToast(e?.message || '预览失败', 'error');
    } finally {
      setPreviewLoading(false);
    }
  };

  /**
   * 下载文件：借助 download 封装触发浏览器另存为
   * @param item 文件项
   */
  const handleDownload = async (item: ContainerFileItem) => {
    if (!selectedId) return;
    const path = joinPath(currentPath(), item.name);
    try {
      await download(
        `/api/files/${selectedId}/download?path=${encodeURIComponent(path)}`,
        item.name
      );
      showToast('已开始下载');
    } catch (e: any) {
      showToast(e?.message || '下载失败', 'error');
    }
  };

  /**
   * 使用原生 fetch 上传文件到当前目录。
   * 不能使用 client.post（其会 JSON.stringify 请求体），故用原生 fetch 以原始字节上传。
   * @param file 待上传的文件
   */
  const handleUpload = async (file: File) => {
    if (!selectedId) return;
    if (!canManage) {
      showToast('仅管理员可上传文件', 'error');
      if (uploadRef.current) uploadRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const token = getToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const resp = await fetch(
        `/api/files/${selectedId}/upload?path=${encodeURIComponent(currentPath())}&name=${encodeURIComponent(
          file.name
        )}`,
        { method: 'POST', headers, body: file }
      );
      if (!resp.ok) {
        let msg = `上传失败 (${resp.status})`;
        try {
          const data = await resp.json();
          msg = data?.error || data?.message || msg;
        } catch {
          // 非 JSON 响应，保留默认错误信息
        }
        throw new Error(msg);
      }
      showToast(`已上传 ${file.name}`);
      loadFiles(selectedId, currentPath());
    } catch (e: any) {
      showToast(e?.message || '上传失败', 'error');
    } finally {
      setUploading(false);
      // 重置 input，允许重复选择同一文件
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };

  /**
   * 新建目录：输入目录名后创建于当前路径下
   */
  const handleMkdir = async () => {
    if (!selectedId) return;
    if (!canManage) {
      showToast('仅管理员可新建目录', 'error');
      return;
    }
    const name = mkdirName.trim();
    if (!name) {
      showToast('请输入目录名', 'error');
      return;
    }
    setCreatingDir(true);
    try {
      await post(`/api/files/${selectedId}/mkdir`, {
        path: joinPath(currentPath(), name),
      });
      showToast('目录创建成功');
      setMkdirOpen(false);
      setMkdirName('');
      loadFiles(selectedId, currentPath());
    } catch (e: any) {
      showToast(e?.message || '创建目录失败', 'error');
    } finally {
      setCreatingDir(false);
    }
  };

  /**
   * 打开重命名弹窗，以原名初始化输入框
   * @param item 文件项
   */
  const openRename = (item: ContainerFileItem) => {
    setRenameTarget({ item, path: joinPath(currentPath(), item.name) });
    setRenameValue(item.name);
  };

  /**
   * 执行重命名
   */
  const handleRename = async () => {
    if (!selectedId || !renameTarget) return;
    if (!canManage) {
      showToast('仅管理员可重命名', 'error');
      return;
    }
    const newName = renameValue.trim();
    if (!newName) {
      showToast('新名称不能为空', 'error');
      return;
    }
    if (newName === renameTarget.item.name) {
      showToast('名称未发生变化', 'error');
      return;
    }
    setRenaming(true);
    try {
      await post(`/api/files/${selectedId}/rename`, {
        path: renameTarget.path,
        newName,
      });
      showToast('重命名成功');
      setRenameTarget(null);
      loadFiles(selectedId, currentPath());
    } catch (e: any) {
      showToast(e?.message || '重命名失败', 'error');
    } finally {
      setRenaming(false);
    }
  };

  /**
   * 执行删除（目录为递归删除）
   */
  const handleDelete = async () => {
    if (!selectedId || !deleteTarget) return;
    if (!canManage) {
      showToast('仅管理员可删除文件', 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await post(`/api/files/${selectedId}/delete`, {
        path: deleteTarget.path,
        recursive: deleteTarget.item.type === 'dir',
      });
      showToast(`${deleteTarget.item.name} 已删除`);
      setDeleteTarget(null);
      loadFiles(selectedId, currentPath());
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  /**
   * 字节数格式化为可读大小
   * @param bytes 字节数
   */
  const formatSize = (bytes?: number): string => {
    if (bytes === undefined || bytes === null) return '-';
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(1)} ${units[i]}`;
  };

  /**
   * 修改时间（epoch 毫秒，后端已由 tar 秒转换为毫秒）格式化为本地日期时间
   * @param ms epoch 毫秒
   */
  const formatMtime = (ms?: number): string => {
    if (!ms) return '-';
    const d = new Date(ms);
    return d.toLocaleString('zh-CN', { hour12: false });
  };

  /**
   * 从容器选项提取显示名称（去前导斜杠）
   * @param c 容器选项
   */
  const containerName = (c: ContainerOption): string =>
    (c.Names && c.Names[0]?.replace(/^\//, '')) || c.Id;

  /**
   * 根据文件/目录类型渲染图标
   * @param type 文件类型
   */
  const renderIcon = (type: 'dir' | 'file') =>
    type === 'dir' ? (
      <span className="files-icon files-icon--dir" aria-hidden="true">
        📁
      </span>
    ) : (
      <span className="files-icon files-icon--file" aria-hidden="true">
        📄
      </span>
    );

  // 是否已进入某目录（非根目录）
  const notAtRoot = crumbs.length > 1;

  return (
    <div className="page">
      <Card
        title="文件管理"
        extra={
          <div className="files-toolbar">
            <Select
              className="files-container-select"
              value={selectedId}
              onChange={(e) => handleSelectContainer(e.target.value)}
            >
              <option value="">选择容器</option>
              {containers.map((c) => (
                <option key={c.Id} value={c.Id}>
                  {containerName(c)}（{c.Image || '未知镜像'}）
                </option>
              ))}
            </Select>
            {selectedId && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => uploadRef.current?.click()}
                  disabled={!canManage}
                >
                  上传
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMkdirOpen(true)}
                  disabled={!canManage}
                >
                  新建目录
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => loadFiles(selectedId, currentPath())}
                >
                  刷新
                </Button>
              </>
            )}
          </div>
        }
      >
        {!selectedId ? (
          <Empty title="请选择容器" description="从上方下拉列表选择一个容器后，即可浏览其内部文件" />
        ) : (
          <>
            {/* 面包屑导航 */}
            <div className="files-breadcrumb">
              {crumbs.map((c, i) => (
                <React.Fragment key={`${c}-${i}`}>
                  {i > 0 && <span className="files-breadcrumb__sep">/</span>}
                  <button
                    className={`files-breadcrumb__crumb ${i === crumbs.length - 1 ? 'files-breadcrumb__crumb--current' : ''}`}
                    onClick={() => navigateCrumb(i)}
                    title={c === ROOT_NAME ? '根目录' : c}
                  >
                    {c === ROOT_NAME ? '根目录' : c}
                  </button>
                </React.Fragment>
              ))}
            </div>

            {loading ? (
              <SkeletonRows rows={6} />
            ) : errorMsg ? (
              <Empty
                kind="error"
                title="加载失败"
                description={errorMsg}
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => loadFiles(selectedId, currentPath())}
                  >
                    重试
                  </Button>
                }
              />
            ) : items.length === 0 ? (
              <Empty
                title="目录为空"
                description="该目录下暂无文件，可点击上方「上传」或「新建目录」"
              />
            ) : (
              <div className="data-table-wrap">
                <table className="data-table files-table">
                  <thead>
                    <tr>
                      <th className="files-col-name">名称</th>
                      <th className="files-col-size">大小</th>
                      <th className="files-col-mtime">修改时间</th>
                      <th className="col-actions">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const isDir = item.type === 'dir';
                      return (
                        <tr key={item.name}>
                          <td className="files-col-name">
                            <button
                              className={`files-name ${isDir ? 'files-name--dir' : ''}`}
                              onClick={() => isDir && enterDir(item.name)}
                              title={isDir ? `进入 ${item.name}` : item.name}
                            >
                              {renderIcon(item.type)}
                              <span className="files-name__text">{item.name}</span>
                            </button>
                          </td>
                          <td className="files-col-size">{isDir ? '-' : formatSize(item.size)}</td>
                          <td className="files-col-mtime">{formatMtime(item.mtime)}</td>
                          <td className="col-actions">
                            <div className="row-actions">
                              {!isDir && (
                                <>
                                  <Button variant="ghost" size="sm" onClick={() => handlePreview(item)}>
                                    预览
                                  </Button>
                                  <Button variant="ghost" size="sm" onClick={() => handleDownload(item)}>
                                    下载
                                  </Button>
                                </>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openRename(item)}
                                disabled={!canManage}
                              >
                                重命名
                              </Button>
                              <Button
                                variant="danger"
                                size="sm"
                                disabled={!canManage}
                                onClick={() =>
                                  setDeleteTarget({
                                    item,
                                    path: joinPath(currentPath(), item.name),
                                  })
                                }
                              >
                                删除
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      {/* 预览弹窗 */}
      <Modal
        open={preview !== null || previewLoading}
        title={`预览 ${previewName}`}
        onClose={() => {
          setPreview(null);
          setPreviewName('');
        }}
        width={720}
      >
        {previewLoading ? (
          <div className="files-preview__loading">文件内容加载中...</div>
        ) : preview ? (
          <div className="files-preview">
            {preview.truncated && (
              <div className="files-preview__truncated">
                文件较大，已截断显示前一部分。如需完整内容，请使用「下载」。
              </div>
            )}
            <pre className="files-preview__content">{preview.content}</pre>
          </div>
        ) : (
          <div className="files-preview__loading">无内容</div>
        )}
      </Modal>

      {/* 隐藏的上传 input，由「上传」按钮触发 */}
      <input
        ref={uploadRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUpload(file);
        }}
      />

      {/* 新建目录弹窗 */}
      <Modal
        open={mkdirOpen}
        title="新建目录"
        onClose={() => !creatingDir && setMkdirOpen(false)}
        width={440}
        footer={
          <div className="create-modal__footer">
            <Button
              variant="ghost"
              size="md"
              onClick={() => setMkdirOpen(false)}
              disabled={creatingDir}
            >
              取消
            </Button>
            <Button variant="primary" size="md" loading={creatingDir} onClick={handleMkdir}>
              创建
            </Button>
          </div>
        }
      >
        <Field label="目录名" required hint={`将在 ${currentPath()} 下创建`}>
          <Input
            placeholder="新目录名称"
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            autoFocus
            disabled={creatingDir}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !creatingDir) handleMkdir();
            }}
          />
        </Field>
      </Modal>

      {/* 重命名弹窗 */}
      <Modal
        open={!!renameTarget}
        title="重命名"
        onClose={() => !renaming && setRenameTarget(null)}
        width={440}
        footer={
          <div className="create-modal__footer">
            <Button
              variant="ghost"
              size="md"
              onClick={() => setRenameTarget(null)}
              disabled={renaming}
            >
              取消
            </Button>
            <Button variant="primary" size="md" loading={renaming} onClick={handleRename}>
              重命名
            </Button>
          </div>
        }
      >
        <Field label="新名称" required>
          <Input
            placeholder="新文件/目录名称"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            autoFocus
            disabled={renaming}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !renaming) handleRename();
            }}
          />
        </Field>
      </Modal>

      {/* 删除确认框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除文件"
        message={
          deleteTarget?.item.type === 'dir'
            ? `确定要递归删除目录「${deleteTarget.item.name}」及其全部内容吗？此操作不可撤销。`
            : `确定要删除文件「${deleteTarget?.item.name || ''}」吗？此操作不可撤销。`
        }
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
