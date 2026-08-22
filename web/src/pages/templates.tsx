/**
 * 容器模板管理页
 *
 * 提供容器模板的完整 CRUD：
 *  - 新建 / 编辑模板（名称、描述、镜像、config JSON 文本）
 *  - 卡片网格展示（名称、镜像、描述、创建时间、config 预览）
 *  - 支持按名称/描述/镜像搜索过滤
 *  - 删除（二次确认）
 *  - "使用"按钮：引导用户到容器页"从模板创建"
 * 仅管理员可进入（路由级 RequireAdmin + 页面内 isAdmin 控制）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, put, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
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

/** 从模板名取首字符作为卡片图标 */
function initials(name: string): string {
  return (name?.trim()?.[0] || 'T').toUpperCase();
}

/**
 * 格式化时间（秒级时间戳 → 本地时间字符串）
 * @param sec 秒级时间戳
 */
function formatTime(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  // 搜索关键字（匹配名称 / 描述 / 镜像）
  const [keyword, setKeyword] = useState('');
  // 展开查看 config 的模板 id
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  // 搜索过滤
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return list;
    return list.filter((t) =>
      [t.name, t.description, t.image].some((v) => (v || '').toLowerCase().includes(kw)),
    );
  }, [list, keyword]);

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
        <p className="templates-page__desc">
          管理容器部署模板，可在容器页一键按模板创建容器 · 共 {filtered.length} / {list.length} 个
        </p>
      </div>

      <div className="templates-toolbar">
        <input
          className="input templates-toolbar__search"
          placeholder="搜索名称 / 描述 / 镜像"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="templates-toolbar__spacer" />
        <Button onClick={openCreate} disabled={!canManage}>+ 新建模板</Button>
        <Button variant="ghost" onClick={load}>刷新</Button>
      </div>

      {loading ? (
        <SkeletonRows rows={4} />
      ) : loadError ? (
        <Empty kind="error" title="加载模板列表失败" description={loadError} />
      ) : filtered.length === 0 ? (
        <Empty
          title={list.length === 0 ? '暂无模板' : '未找到匹配模板'}
          description={
            list.length === 0
              ? '点击「新建模板」创建，或在容器详情页将容器配置保存为模板。'
              : '尝试更换搜索关键字'
          }
        />
      ) : (
        <div className="templates-grid">
          {filtered.map((t) => {
            const expanded = expandedId === t.id;
            return (
              <div className="templates-card" key={t.id}>
                <div className="templates-card__head">
                  <div className="templates-card__icon" aria-hidden="true">
                    {initials(t.name)}
                  </div>
                  <div className="templates-card__meta">
                    <div className="templates-card__name" title={t.name}>
                      {t.name}
                    </div>
                    {t.image ? (
                      <span className="templates-card__image" title={t.image}>
                        {t.image}
                      </span>
                    ) : (
                      <span className="templates-card__image templates-card__image--empty">未指定镜像</span>
                    )}
                  </div>
                </div>

                <div className="templates-card__desc" title={t.description || ''}>
                  {t.description || '暂无描述'}
                </div>

                <div className="templates-card__config">
                  <button
                    type="button"
                    className="templates-card__config-toggle"
                    onClick={() => setExpandedId(expanded ? null : t.id)}
                  >
                    <span>config</span>
                    <span className="templates-card__config-arrow">{expanded ? '▾' : '▸'}</span>
                  </button>
                  {expanded && (
                    <pre className="templates-card__config-body">
                      {JSON.stringify(t.config ?? {}, null, 2)}
                    </pre>
                  )}
                </div>

                <div className="templates-card__footer">
                  <span className="templates-card__time">创建于 {formatTime(t.createdAt)}</span>
                  <div className="templates-card__actions">
                    <Button variant="ghost" size="sm" onClick={() => handleUse(t)}>使用</Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(t)} disabled={!canManage}>
                      编辑
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setDeleteTarget(t)} disabled={!canManage}>
                      删除
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
