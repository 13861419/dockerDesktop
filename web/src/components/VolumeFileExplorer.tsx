/**
 * 可复用的数据卷内文件浏览器组件
 *
 * 从容器文件浏览器组件（components/FileExplorer.tsx）抽取核心浏览逻辑改造而来，
 * 前端接口统一指向 /api/volume-files/:volume 前缀，支持在数据卷列表页等任意已知
 * volume 名称的场景下直接嵌入使用，免去跳转到独立文件管理页。
 *
 * 能力：目录浏览（面包屑导航）、文件预览、下载、上传、新建目录、重命名、删除。
 * 写操作（上传/新建目录/重命名/删除）受 useCanManage 权限管控，仅管理员可用，
 * 普通用户可只读浏览与下载。
 *
 * 后端接口（均以 /api/volume-files/:volume 为前缀）：
 *  - GET  /ls?path=           列目录
 *  - GET  /read?path=         读取小文件文本（预览）
 *  - GET  /download?path=     下载文件（attachment 原始字节）
 *  - POST /upload?path=&name= 上传文件（application/octet-stream 原始字节）
 *  - POST /mkdir              新建目录（body: { path }）
 *  - POST /rename             重命名（body: { path, newName }）
 *  - POST /delete             删除（body: { path, recursive }）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Button from './Button';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import { Field, Input } from './Form';
import Empty from './Empty';
import { SkeletonRows } from './Loading';
import { useToast } from './Toast';
import { get, post, download } from '../api/client';
import { getToken } from '../api/auth';
import { useCanManage } from '../hooks/useCanManage';
import { ContainerFileItem } from '../types';
import '../pages/files.less';

/** VolumeFileExplorer 组件 Props */
interface VolumeFileExplorerProps {
  /** 数据卷名称（由父组件提供，组件内部不再选择数据卷） */
  volume: string;
  /** 可选的根节点自定义类名 */
  className?: string;
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

/** 根目录标识，用于面包屑分段（不以斜杠作为根名，避免拼接歧义） */
const ROOT_NAME = '/';

/**
 * 规范化拼接路径：合并多余斜杠，确保得到形如 "etc/nginx/conf.d" 的路径
 * @param dir 父目录路径（可为空、斜杠或具体目录）
 * @param name 子项名称
 * @returns 拼接后的完整路径（不以 / 开头，根目录时为 /）
 */
function joinPath(dir: string, name: string): string {
  const base = dir && dir !== '/' ? dir.replace(/\/+$/, '') : '';
  return base ? `${base}/${name}` : name;
}

/**
 * 数据卷内文件浏览器组件
 *
 * 用法：在已知数据卷名称的页面中直接嵌入
 *   <VolumeFileExplorer volume={vol.Name} />
 */
export default function VolumeFileExplorer({ volume, className }: VolumeFileExplorerProps) {
  const { showToast } = useToast();
  // 是否可写（上传/新建目录/重命名/删除）：数据卷内文件写操作仅管理员可用，普通用户可只读浏览。
  // 采用服务端权威角色判定（useCanManage），防止基于被篡改的 localStorage 误放行
  const { canManage, checking } = useCanManage();
  // 当前路径的面包屑分段（如 ['/', 'etc', 'nginx']）
  const [crumbs, setCrumbs] = useState<string[]>([ROOT_NAME]);
  // 当前目录文件列表
  const [items, setItems] = useState<ContainerFileItem[]>([]);
  // 列表加载中
  const [loading, setLoading] = useState(false);
  // 文件列表加载失败信息
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

  /** 该组件的接口前缀（数据卷名经过 URI 编码以兼容特殊字符） */
  const baseUrl = `/api/volume-files/${encodeURIComponent(volume)}`;

  /**
   * 计算当前路径：由面包屑分段拼出完整路径
   * @returns 卷内绝对路径（根目录返回 '/'）
   */
  const currentPath = useCallback(() => {
    const parts = crumbs.filter((p) => p !== ROOT_NAME);
    return parts.length ? parts.join('/') : '/';
  }, [crumbs]);

  /**
   * 拉取指定路径下的文件列表
   * @param path 目录路径
   */
  const loadFiles = useCallback(
    async (path: string) => {
      if (!volume) return;
      setLoading(true);
      setErrorMsg('');
      try {
        const data = await get<{ items: ContainerFileItem[] }>(`${baseUrl}/ls`, {
          path,
        });
        setItems((data?.items as ContainerFileItem[]) || []);
      } catch (e: any) {
        // 后端会返回相应错误，捕获后 toast 展示并清空列表
        showToast(e?.message || '加载文件列表失败', 'error');
        setItems([]);
        setErrorMsg(e?.message || '加载文件列表失败');
      } finally {
        setLoading(false);
      }
    },
    [volume, baseUrl, showToast],
  );

  /**
   * 进入子目录：点击目录行时触发
   * @param name 子目录名
   */
  const enterDir = (name: string) => {
    setCrumbs((prev) => [...prev, name]);
  };

  /**
   * 面包屑导航：跳转到指定分段所在的目录
   * @param index 分段索引（0=根目录）
   */
  const navigateCrumb = (index: number) => {
    setCrumbs((prev) => prev.slice(0, index + 1));
  };

  /**
   * 切换路径或数据卷后，根据当前 crumbs 重新加载列表。
   * 组件首次挂载时 crumbs 为根目录，会自动加载根目录文件列表。
   */
  useEffect(() => {
    if (volume) {
      loadFiles(currentPath());
    }
    // currentPath 依赖 crumbs，此处触发即表示路径已更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crumbs, volume]);

  /**
   * 预览文件内容：读取文本并展示在弹窗中
   * @param item 文件项
   */
  const handlePreview = async (item: ContainerFileItem) => {
    if (!volume) return;
    const path = joinPath(currentPath(), item.name);
    setPreviewName(item.name);
    setPreviewLoading(true);
    setPreview(null);
    try {
      const data = await get<PreviewData>(`${baseUrl}/read`, { path });
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
    if (!volume) return;
    const path = joinPath(currentPath(), item.name);
    try {
      await download(
        `${baseUrl}/download?path=${encodeURIComponent(path)}`,
        item.name,
      );
      showToast('已开始下载');
    } catch (e: any) {
      showToast(e?.message || '下载失败', 'error');
    }
  };

  /**
   * 使用原生 fetch 上传文件到当前目录。
   * 不能使用 client.post（其会 JSON.stringify 请求体），故用原生 fetch 以原始字节上传。
   * 上传同名文件会覆盖原文件，因此也可作为"编辑覆盖"使用。
   * @param file 待上传的文件
   */
  const handleUpload = async (file: File) => {
    if (!volume) return;
    // 服务端角色未确认前（checking）也不放行写操作，避免误信被篡改的本地 role
    if (!canManage || checking) {
      showToast(checking ? '正在确认权限，请稍候' : '仅管理员可上传文件', 'error');
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
        `${baseUrl}/upload?path=${encodeURIComponent(currentPath())}&name=${encodeURIComponent(
          file.name,
        )}`,
        { method: 'POST', headers, body: file },
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
      loadFiles(currentPath());
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
    if (!volume) return;
    if (!canManage || checking) {
      showToast(checking ? '正在确认权限，请稍候' : '仅管理员可新建目录', 'error');
      return;
    }
    const name = mkdirName.trim();
    if (!name) {
      showToast('请输入目录名', 'error');
      return;
    }
    setCreatingDir(true);
    try {
      await post(`${baseUrl}/mkdir`, {
        path: joinPath(currentPath(), name),
      });
      showToast('目录创建成功');
      setMkdirOpen(false);
      setMkdirName('');
      loadFiles(currentPath());
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
    if (!volume || !renameTarget) return;
    if (!canManage || checking) {
      showToast(checking ? '正在确认权限，请稍候' : '仅管理员可重命名', 'error');
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
      await post(`${baseUrl}/rename`, {
        path: renameTarget.path,
        newName,
      });
      showToast('重命名成功');
      setRenameTarget(null);
      loadFiles(currentPath());
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
    if (!volume || !deleteTarget) return;
    if (!canManage || checking) {
      showToast(checking ? '正在确认权限，请稍候' : '仅管理员可删除文件', 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await post(`${baseUrl}/delete`, {
        path: deleteTarget.path,
        recursive: deleteTarget.item.type === 'dir',
      });
      showToast(`${deleteTarget.item.name} 已删除`);
      setDeleteTarget(null);
      loadFiles(currentPath());
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  /**
   * 字节数格式化为可读大小
   * @param bytes 字节数
   * @returns 形如 "1.2 KB" 的可读字符串
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
   * 修改时间（epoch 毫秒）格式化为本地日期时间
   * @param ms epoch 毫秒
   * @returns 本地日期时间字符串，无值时返回 '-'
   */
  const formatMtime = (ms?: number): string => {
    if (!ms) return '-';
    const d = new Date(ms);
    return d.toLocaleString('zh-CN', { hour12: false });
  };

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

  return (
    <div className={`files-explorer ${className || ''}`}>
      {/* 顶部工具栏：上传 / 新建目录 / 刷新 */}
      <div className="files-toolbar" style={{ marginBottom: 12 }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => uploadRef.current?.click()}
          disabled={!canManage || uploading}
          loading={uploading}
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
          onClick={() => loadFiles(currentPath())}
          disabled={loading}
        >
          刷新
        </Button>
      </div>

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

      {/* 文件列表区域 */}
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
              onClick={() => loadFiles(currentPath())}
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
