/**
 * 容器模板管理页
 *
 * 提供容器模板的完整 CRUD：
 *  - 新建 / 编辑模板（名称、描述、镜像、config JSON 文本）
 *  - 列表展示（名称、描述、镜像、创建时间）
 *  - 删除（二次确认）
 *  - "使用"按钮：引导用户到容器页"从模板创建"
 * 仅管理员可进入（路由级 RequireAdmin + 页面内 isAdmin 控制）。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, put, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { Field, Input } from '../components/Form';
import './templates.less';

/** 容器模板项（对齐 /api/templates 返回结构） */
interface TemplateItem {
  id: string;
  name: string;
  description: string;
  image: string;
  config: any;
  createdAt: number;
  updatedAt: number;
}

/** 新建/编辑弹窗表单草稿 */
interface TemplateForm {
  name: string;
  description: string;
  image: string;
  config: string;
}

/** 空表单初始值 */
const EMPTY_FORM: TemplateForm = { name: '', description: '', image: '', config: '{}' };

/**
 * 格式化时间（秒级时间戳 → 本地时间字符串）
 * @param sec 秒级时间戳
 */
function formatTime(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 容器模板管理页组件
 */
export default function TemplatesPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();

  const [list, setList] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // 新建/编辑弹窗
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState('');

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<TemplateItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  /**
   * 加载模板列表
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<TemplateItem[]>('/api/templates');
      setList(res || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || '加载模板列表失败');
      showToast(e?.message || '加载模板列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 打开"新建模板"弹窗
   */
  const openCreate = useCallback(() => {
    if (!canManage) {
      showToast('仅管理员可新建模板', 'error');
      return;
    }
    setEditingId(null);
    setForm(EMPTY_FORM);
    setConfigError('');
    setEditorOpen(true);
  }, [canManage, showToast]);

  /**
   * 打开"编辑模板"弹窗，回填现有值
   * @param tpl 待编辑的模板项
   */
  const openEdit = useCallback(
    (tpl: TemplateItem) => {
      if (!canManage) {
        showToast('仅管理员可编辑模板', 'error');
        return;
      }
      setEditingId(tpl.id);
      setForm({
        name: tpl.name || '',
        description: tpl.description || '',
        image: tpl.image || '',
        config: JSON.stringify(tpl.config ?? {}, null, 2),
      });
      setConfigError('');
      setEditorOpen(true);
    },
    [canManage, showToast],
  );

  /**
   * 提交新建或编辑模板
   */
  const handleSave = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可操作模板', 'error');
      setEditorOpen(false);
      return;
    }
    // 名称必填校验
    if (!form.name.trim()) {
      showToast('模板名称不能为空', 'error');
      return;
    }
    // config 为 JSON 文本，解析失败则拦截
    let configObj: any = {};
    try {
      configObj = form.config.trim() ? JSON.parse(form.config) : {};
    } catch {
      setConfigError('config 不是合法 JSON，请检查格式');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim(),
        image: form.image.trim(),
        config: configObj,
      };
      if (editingId) {
        await put(`/api/templates/${editingId}`, body);
        showToast('模板已更新');
      } else {
        await post('/api/templates', body);
        showToast('模板已创建');
      }
      setEditorOpen(false);
      load();
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [canManage, form, editingId, load, showToast]);

  /**
   * 删除指定模板
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await del(`/api/templates/${deleteTarget.id}`);
      showToast('模板已删除');
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load, showToast]);

  /**
   * "使用"模板：引导用户到容器页从模板创建
   */
  const handleUse = useCallback(
    (tpl: TemplateItem) => {
      showToast(`请在「容器」页 →「从模板创建」选择「${tpl.name}」`);
    },
    [showToast],
  );

  return (
    <div className="templates-page">
      <div className="templates-page__header">
        <h1 className="templates-page__title">容器模板</h1>
        <p className="templates-page__desc">管理容器部署模板，可在容器页一键按模板创建容器</p>
      </div>

      <div className="templates-toolbar">
        <Button onClick={openCreate} disabled={!canManage}>+ 新建模板</Button>
        <Button variant="ghost" onClick={load}>刷新</Button>
      </div>

      <Card>
        {loading ? (
          <SkeletonRows rows={4} />
        ) : loadError ? (
          <Empty kind="error" title="加载模板列表失败" description={loadError} />
        ) : list.length === 0 ? (
          <Empty
            title="暂无模板"
            description="点击「新建模板」创建，或在容器详情页将容器配置保存为模板。"
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '18%' }}>名称</th>
                <th style={{ width: '26%' }}>描述</th>
                <th style={{ width: '20%' }}>镜像</th>
                <th style={{ width: '18%' }}>创建时间</th>
                <th style={{ width: '18%' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong></td>
                  <td className="templates-cell--ellipsis" title={t.description}>{t.description || '—'}</td>
                  <td className="templates-cell--ellipsis" title={t.image}>{t.image || '—'}</td>
                  <td>{formatTime(t.createdAt)}</td>
                  <td>
                    <div className="templates-actions">
                      <Button variant="ghost" size="sm" onClick={() => handleUse(t)}>使用</Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(t)} disabled={!canManage}>
                        编辑
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => setDeleteTarget(t)} disabled={!canManage}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 新建/编辑模板弹窗 */}
      <Modal
        open={editorOpen}
        title={editingId ? '编辑模板' : '新建模板'}
        onClose={() => !saving && setEditorOpen(false)}
        width={620}
        footer={
          <div className="templates-modal__footer">
            <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={saving}>取消</Button>
            <Button loading={saving} onClick={handleSave} disabled={!canManage}>
              {editingId ? '保存' : '创建'}
            </Button>
          </div>
        }
      >
        <Field label="模板名称" required>
          <Input
            value={form.name}
            placeholder="如：Nginx 站点"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            disabled={saving}
          />
        </Field>
        <Field label="描述（可选）">
          <Input
            value={form.description}
            placeholder="模板用途说明"
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            disabled={saving}
          />
        </Field>
        <Field label="镜像（可选）">
          <Input
            value={form.image}
            placeholder="如 nginx:latest"
            onChange={(e) => setForm((f) => ({ ...f, image: e.target.value }))}
            disabled={saving}
          />
        </Field>
        <Field label="config（JSON）" hint="与容器导出配置的 config 结构一致">
          <textarea
            className="templates-config__area"
            value={form.config}
            spellCheck={false}
            disabled={saving}
            onChange={(e) => {
              setForm((f) => ({ ...f, config: e.target.value }));
              setConfigError('');
            }}
          />
          {configError && <div className="templates-config__error">{configError}</div>}
        </Field>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除容器模板"
        message={`确定删除模板「${deleteTarget?.name || ''}」吗？删除后不可恢复。`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
