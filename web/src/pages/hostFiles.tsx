/**
 * 宿主机文件管理页面
 *
 * 浏览 / 上传 / 下载 / 新建 / 编辑 / 重命名 / 删除宿主机文件。
 * 上传与下载均需携带鉴权头（原生 fetch / client.download）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, del, download } from '../api/client';
import { getToken } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { Field, Input, TextArea } from '../components/Form';
import './hostFiles.less';

/** 条目类型 */
type ItemType = 'drive' | 'dir' | 'file' | 'other';

/** 文件系统条目 */
interface FsItem {
  name: string;
  type: ItemType;
  size: number | null;
  mtime: number | null;
  path: string;
}

/** 列表响应 */
interface ListResponse {
  items: FsItem[];
  path: string;
}

/** 编辑器弹窗状态 */
interface EditorState {
  open: boolean;
  path: string;
  name: string;
  content: string;
  existing: boolean;
}

/**
 * 将字节数格式化为可读大小
 * @param bytes 字节数
 * @returns 格式化字符串
 */
function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 格式化修改时间
 * @param ms 毫秒时间戳
 * @returns 格式化字符串
 */
function formatTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 宿主机文件管理页面组件
 */
export default function HostFilesPage() {
  const { showToast } = useToast();
  const uploadRef = useRef<HTMLInputElement>(null);

  // 当前路径
  const [curPath, setCurPath] = useState('');
  // 路径输入框内容
  const [pathInput, setPathInput] = useState('');
  // 列表
  const [items, setItems] = useState<FsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  // 新建文件夹弹窗
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');

  // 新建文件弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');

  // 重命名弹窗
  const [renameTarget, setRenameTarget] = useState<FsItem | null>(null);
  const [renameName, setRenameName] = useState('');

  // 文本编辑器弹窗
  const [editor, setEditor] = useState<EditorState>({ open: false, path: '', name: '', content: '', existing: false });

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<FsItem | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /**
   * 加载指定路径的目录内容
   * @param path 目标路径（空=盘符列表）
   */
  const load = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const data = await get<ListResponse>('/api/hostfiles/list', { path });
      setCurPath(data?.path || path || '');
      setItems(data?.items || []);
    } catch (e: any) {
      showToast(e?.message || '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  // 首次加载盘符列表
  useEffect(() => {
    load('');
  }, [load]);

  /**
   * 进入目录
   * @param item 目录条目
   */
  const enterDir = useCallback(
    (item: FsItem) => {
      if (item.type === 'dir' || item.type === 'drive') {
        setPathInput(item.path);
        load(item.path);
      }
    },
    [load],
  );

  /**
   * 返回上级目录
   */
  const goUp = useCallback(() => {
    if (!curPath) return;
    const parent = curPath.replace(/[\\/]+$/, '');
    const idx = Math.max(parent.lastIndexOf('\\'), parent.lastIndexOf('/'));
    if (idx === -1) {
      // 盘符根，回盘符列表
      setPathInput('');
      load('');
    } else {
      const up = parent.slice(0, idx);
      setPathInput(up);
      load(up);
    }
  }, [curPath, load]);

  /**
   * 上传文件
   * @param file 待上传文件
   */
  const handleUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const token = getToken();
        const headers: Record<string, string> = {
          'Content-Type': 'application/octet-stream',
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const resp = await fetch(
          `/api/hostfiles/upload?path=${encodeURIComponent(curPath)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', headers, body: file },
        );
        if (!resp.ok) {
          let msg = `上传失败 (${resp.status})`;
          try {
            const data = await resp.json();
            msg = data?.error || data?.message || msg;
          } catch {
            // 非 JSON 响应
          }
          throw new Error(msg);
        }
        showToast(`已上传 ${file.name}`);
        load(curPath);
      } catch (e: any) {
        showToast(e?.message || '上传失败', 'error');
      } finally {
        setUploading(false);
        if (uploadRef.current) uploadRef.current.value = '';
      }
    },
    [curPath, load, showToast],
  );

  /**
   * 下载文件
   * @param item 文件条目
   */
  const handleDownload = useCallback(
    async (item: FsItem) => {
      try {
        await download(`/api/hostfiles/download?path=${encodeURIComponent(item.path)}`, item.name);
        showToast(`已开始下载 ${item.name}`);
      } catch (e: any) {
        showToast(e?.message || '下载失败', 'error');
      }
    },
    [showToast],
  );

  /**
   * 确认新建文件夹
   */
  const handleMkdir = useCallback(async () => {
    if (!mkdirName.trim()) return;
    try {
      await post('/api/hostfiles/mkdir', { path: curPath, name: mkdirName.trim() });
      showToast('目录已创建');
      setMkdirOpen(false);
      setMkdirName('');
      load(curPath);
    } catch (e: any) {
      showToast(e?.message || '创建失败', 'error');
    }
  }, [mkdirName, curPath, load, showToast]);

  /**
   * 确认新建文件（空文件）
   */
  const handleCreateFile = useCallback(async () => {
    if (!createName.trim()) return;
    try {
      const target = curPath.replace(/\\$/, '') + '\\' + createName.trim();
      await post('/api/hostfiles/write', { path: target, content: '' });
      showToast('文件已创建');
      setCreateOpen(false);
      setCreateName('');
      load(curPath);
    } catch (e: any) {
      showToast(e?.message || '创建失败', 'error');
    }
  }, [createName, curPath, load, showToast]);

  /**
   * 打开文本编辑器（新建或编辑）
   * @param item 可选：已有文件条目
   */
  const openEditor = useCallback(
    async (item?: FsItem) => {
      if (item) {
        try {
          const data = await post<{ content: string }>('/api/hostfiles/read', { path: item.path });
          setEditor({
            open: true,
            path: item.path,
            name: item.name,
            content: data?.content ?? '',
            existing: true,
          });
        } catch (e: any) {
          showToast(e?.message || '读取失败', 'error');
        }
      } else {
        setEditor({ open: true, path: '', name: '', content: '', existing: false });
      }
    },
    [showToast],
  );

  /**
   * 保存编辑器内容
   */
  const handleSaveEditor = useCallback(async () => {
    try {
      if (editor.existing) {
        await post('/api/hostfiles/write', { path: editor.path, content: editor.content });
        showToast('已保存');
        setEditor((s) => ({ ...s, open: false }));
      } else {
        const name = editor.name.trim();
        if (!name) {
          showToast('请填写文件名', 'error');
          return;
        }
        const target = curPath.replace(/\\$/, '') + '\\' + name;
        await post('/api/hostfiles/write', { path: target, content: editor.content });
        showToast('文件已创建');
        setEditor((s) => ({ ...s, open: false }));
        load(curPath);
      }
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    }
  }, [editor, curPath, load, showToast]);

  /**
   * 确认重命名
   */
  const handleRename = useCallback(async () => {
    if (!renameTarget || !renameName.trim()) return;
    try {
      const dir = renameTarget.path.slice(0, renameTarget.path.length - renameTarget.name.length);
      const to = dir + renameName.trim();
      await post('/api/hostfiles/rename', { from: renameTarget.path, to });
      showToast('已重命名');
      setRenameTarget(null);
      load(curPath);
    } catch (e: any) {
      showToast(e?.message || '重命名失败', 'error');
    }
  }, [renameTarget, renameName, curPath, load, showToast]);

  /**
   * 确认删除
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await post('/api/hostfiles/delete', { path: deleteTarget.path, force: forceDelete });
      showToast('已删除');
      setDeleteTarget(null);
      setForceDelete(false);
      load(curPath);
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, forceDelete, curPath, load, showToast]);

  /**
   * 点击单元格：目录进入，文件打开编辑
   * @param item 条目
   */
  const handleRowClick = useCallback(
    (item: FsItem) => {
      if (item.type === 'file') openEditor(item);
      else enterDir(item);
    },
    [enterDir, openEditor],
  );

  // 错误处理提示的删除目标描述
  const deleteDesc = deleteTarget
    ? deleteTarget.type === 'dir'
      ? `目录「${deleteTarget.name}」（含其子项将被递归删除）`
      : `文件「${deleteTarget.name}」`
    : '';

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">宿主机文件</h1>
        <p className="page__desc">浏览与管理宿主机文件系统（Windows）</p>
      </div>

      <Card>
        <div className="hf-toolbar">
          <Input
            className="hf-toolbar__path"
            placeholder="输入宿主机路径后回车跳转，或点击目录进入"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') load(pathInput);
            }}
          />
          <div className="hf-toolbar__actions">
            <Button variant="secondary" size="sm" onClick={() => load(pathInput)}>跳转</Button>
            <Button variant="ghost" size="sm" onClick={goUp} disabled={!curPath}>上级</Button>
            <Button variant="ghost" size="sm" onClick={() => { setPathInput(''); load(''); }}>盘符</Button>
            <Button variant="ghost" size="sm" onClick={() => { setPathInput(curPath); load(curPath); }}>刷新</Button>
            <Button variant="secondary" size="sm" onClick={() => setMkdirOpen(true)}>新建文件夹</Button>
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>新建文件</Button>
            <Button variant="secondary" size="sm" loading={uploading} disabled={!curPath} onClick={() => uploadRef.current?.click()}>
              上传
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        {loading ? (
          <SkeletonRows rows={8} />
        ) : items.length === 0 ? (
          <Empty title={curPath ? '目录为空' : '未检测到磁盘'} />
        ) : (
          <div className="hf-table-wrap">
            <table className="hf-table">
              <thead>
                <tr>
                  <th style={{ width: '48%' }}>名称</th>
                  <th style={{ width: '10%' }}>类型</th>
                  <th style={{ width: '12%' }}>大小</th>
                  <th style={{ width: '16%' }}>修改时间</th>
                  <th style={{ width: '14%' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={`${item.path}-${idx}`} data-type={item.type} onClick={() => handleRowClick(item)}>
                    <td>
                      <div className="hf-name">
                        <span className={`hf-name__icon ${item.type === 'dir' || item.type === 'drive' ? 'hf-name__icon--dir' : 'hf-name__icon--file'}`}>
                          {item.type === 'dir' || item.type === 'drive' ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                            </svg>
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
                              <path d="M14 3v6h6" />
                            </svg>
                          )}
                        </span>
                        <span className="hf-name__text">{item.name}</span>
                      </div>
                    </td>
                    <td className="hf-type">{item.type === 'drive' ? '磁盘' : item.type === 'dir' ? '目录' : item.type === 'file' ? '文件' : '其他'}</td>
                    <td className="hf-size">{item.type === 'file' ? formatSize(item.size) : '—'}</td>
                    <td className="hf-time">{item.type === 'file' || item.type === 'dir' ? formatTime(item.mtime) : '—'}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="hf-actions">
                        {item.type === 'file' && (
                          <>
                            <button className="hf-link" onClick={() => handleDownload(item)}>下载</button>
                            <button className="hf-link" onClick={() => openEditor(item)}>编辑</button>
                          </>
                        )}
                        {item.type === 'dir' && (
                          <button className="hf-link" onClick={() => setRenameTarget({ ...item })}>重命名</button>
                        )}
                        {item.type === 'file' && (
                          <button className="hf-link" onClick={() => setRenameTarget({ ...item })}>重命名</button>
                        )}
                        <button className="hf-link hf-link--danger" onClick={() => setDeleteTarget({ ...item })}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <input
        ref={uploadRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
        }}
      />

      {/* 新建文件夹弹窗 */}
      <Modal
        open={mkdirOpen}
        title="新建文件夹"
        onClose={() => setMkdirOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setMkdirOpen(false)}>取消</Button>
            <Button onClick={handleMkdir}>创建</Button>
          </div>
        }
      >
        <Field label="文件夹名" required>
          <Input
            value={mkdirName}
            placeholder="例如：new_folder"
            autoFocus
            onChange={(e) => setMkdirName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleMkdir(); }}
          />
        </Field>
      </Modal>

      {/* 新建文件弹窗 */}
      <Modal
        open={createOpen}
        title="新建文件"
        onClose={() => setCreateOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={handleCreateFile}>创建</Button>
          </div>
        }
      >
        <Field label="文件名" required hint={`将创建于：${curPath}`}>
          <Input
            value={createName}
            placeholder="例如：config.txt"
            autoFocus
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFile(); }}
          />
        </Field>
      </Modal>

      {/* 重命名弹窗 */}
      <Modal
        open={!!renameTarget}
        title="重命名"
        onClose={() => setRenameTarget(null)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>取消</Button>
            <Button onClick={handleRename}>确定</Button>
          </div>
        }
      >
        <Field label="新名称" required>
          <Input
            value={renameName}
            autoFocus
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
          />
        </Field>
      </Modal>

      {/* 文本编辑器 */}
      <Modal
        open={editor.open}
        title={editor.existing ? `编辑 ${editor.name}` : '新建文本文件'}
        onClose={() => setEditor((s) => ({ ...s, open: false }))}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            {!editor.existing && (
              <Input
                placeholder="文件名（如 note.txt）"
                value={editor.name}
                onChange={(e) => setEditor((s) => ({ ...s, name: e.target.value }))}
                style={{ width: 220, marginRight: 'auto' }}
              />
            )}
            <Button variant="ghost" onClick={() => setEditor((s) => ({ ...s, open: false }))}>取消</Button>
            <Button onClick={handleSaveEditor}>保存</Button>
          </div>
        }
      >
        <div className="hf-editor">
          <TextArea
            value={editor.content}
            onChange={(e) => setEditor((s) => ({ ...s, content: e.target.value }))}
          />
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        open={!!deleteTarget}
        title="删除"
        onClose={() => { setDeleteTarget(null); setForceDelete(false); }}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => { setDeleteTarget(null); setForceDelete(false); }} disabled={deleting}>
              取消
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={deleting}>
              删除
            </Button>
          </div>
        }
      >
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>{deleteDesc}</div>
        {deleteTarget?.type === 'dir' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', marginTop: 10 }}>
            <input type="checkbox" checked={forceDelete} onChange={(e) => setForceDelete(e.target.checked)} />
            <span>递归删除整个目录（非空目录需勾选）</span>
          </label>
        )}
      </Modal>
    </div>
  );
}
