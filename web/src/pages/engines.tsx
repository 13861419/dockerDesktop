/**
 * Docker 引擎管理页面
 *
 * 管理多个 Docker 引擎端点，可新增/编辑/删除/切换当前引擎。
 * 切换当前引擎后，面板所有 Docker 相关能力（容器/镜像/卷/网络/Compose/事件等）指向新引擎。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../api/client';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { Field, Input } from '../components/Form';
import './engines.less';

/** 引擎 */
interface Engine {
  id: string;
  name: string;
  endpoint: string;
  isCurrent: boolean;
}

/** 列表响应 */
interface EnginesResponse {
  engines: Engine[];
}

/** 编辑弹窗校验错误 */
interface FormError {
  name?: string;
  endpoint?: string;
}

/**
 * Docker 引擎管理页面组件
 */
export default function EnginesPage() {
  const { showToast } = useToast();

  const [engines, setEngines] = useState<Engine[]>([]);
  const [loading, setLoading] = useState(false);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  // 新增/编辑弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Engine | null>(null);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FormError>({});

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<Engine | null>(null);
  const [deleting, setDeleting] = useState(false);

  /**
   * 加载引擎列表
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<EnginesResponse>('/api/engines');
      setEngines(data?.engines || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || '加载引擎失败');
      showToast(e?.message || '加载引擎失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 打开新增弹窗
   */
  const openCreate = useCallback(() => {
    setEditing(null);
    setName('');
    setEndpoint('');
    setErrors({});
    setModalOpen(true);
  }, []);

  /**
   * 打开编辑弹窗
   * @param engine 待编辑引擎
   */
  const openEdit = useCallback((engine: Engine) => {
    setEditing(engine);
    setName(engine.name);
    setEndpoint(engine.endpoint);
    setErrors({});
    setModalOpen(true);
  }, []);

  /**
   * 校验并提交表单（新增或编辑）
   */
  const handleSubmit = useCallback(async () => {
    const err: FormError = {};
    if (!name.trim()) err.name = '请输入引擎名称';
    if (!endpoint.trim()) err.endpoint = '请输入端点（如 tcp://host:2375）';
    setErrors(err);
    if (Object.keys(err).length) return;

    setSaving(true);
    try {
      if (editing) {
        await post(`/api/engines/${editing.id}`, { name: name.trim(), endpoint: endpoint.trim() });
        showToast('引擎已更新');
      } else {
        const data = await post<{ ok: boolean; isCurrent: boolean }>('/api/engines', {
          name: name.trim(),
          endpoint: endpoint.trim(),
        });
        showToast(`引擎已添加${data?.isCurrent ? '（已设为当前）' : ''}`);
      }
      setModalOpen(false);
      load();
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [editing, name, endpoint, load, showToast]);

  /**
   * 切换当前引擎
   * @param engine 目标引擎
   */
  const handleSwitch = useCallback(
    async (engine: Engine) => {
      setSwitchingId(engine.id);
      try {
        await post(`/api/engines/${engine.id}/switch`);
        showToast(`已切换到「${engine.name}」`);
        load();
      } catch (e: any) {
        showToast(e?.message || '切换失败', 'error');
      } finally {
        setSwitchingId(null);
      }
    },
    [load, showToast],
  );

  /**
   * 删除引擎
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await del(`/api/engines/${deleteTarget.id}`);
      showToast('引擎已删除');
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load, showToast]);

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">Docker 引擎</h1>
        <p className="page__desc">配置多个 Docker 引擎端点，并在其中切换</p>
      </div>

      <div className="toolbar">
        <Button onClick={openCreate}>+ 新增引擎</Button>
        <Button variant="ghost" onClick={load}>刷新</Button>
      </div>

      <Card>
        {loading ? (
          <SkeletonRows rows={4} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="加载引擎失败"
            description={loadError || '请稍后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={load}>
                重试
              </Button>
            }
          />
        ) : engines.length === 0 ? (
          <Empty title="尚未配置引擎" description="当前使用本机自动探测的默认 Docker 引擎。可新增引擎进行多引擎管理。" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '26%' }}>名称</th>
                <th style={{ width: '42%' }}>端点</th>
                <th style={{ width: '14%' }}>状态</th>
                <th style={{ width: '18%' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {engines.map((e) => (
                <tr key={e.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong>{e.name}</strong>
                      {e.isCurrent && <span className="en-badge en-badge--current">当前</span>}
                    </div>
                  </td>
                  <td className="en-endpoint">{e.endpoint}</td>
                  <td>
                    <span className={`en-badge ${e.isCurrent ? 'en-badge--current' : 'en-badge--default'}`}>
                      {e.isCurrent ? '使用中' : '备用'}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      {!e.isCurrent && (
                        <Button variant="secondary" size="sm" loading={switchingId === e.id} onClick={() => handleSwitch(e)}>
                          设为当前
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => openEdit(e)}>编辑</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(e)}>删除</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="en-hint" style={{ marginTop: 14 }}>
          提示：默认（未配置任何引擎）时使用环境变量 DOCKER_HOST 或本机自动探测的引擎。
          切换当前引擎后，容器、镜像、数据卷、网络、Compose、监控与事件流等能力均切到新引擎。
        </div>
      </Card>

      {/* 新增/编辑引擎弹窗 */}
      <Modal
        open={modalOpen}
        title={editing ? `编辑引擎：${editing.name}` : '新增引擎'}
        onClose={() => setModalOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>取消</Button>
            <Button loading={saving} onClick={handleSubmit}>{editing ? '保存' : '新增'}</Button>
          </div>
        }
      >
        <Field label="引擎名称" required error={errors.name}>
          <Input
            value={name}
            error={!!errors.name}
            placeholder="如：服务器B"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="端点地址"
          required
          error={errors.endpoint}
          hint="npipe:////./pipe/dockerDesktopLinuxEngine · tcp://host:2375 · unix:///var/run/docker.sock"
        >
          <Input
            value={endpoint}
            error={!!errors.endpoint}
            placeholder="tcp://192.168.1.10:2375"
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </Field>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除引擎"
        message={`确定删除引擎「${deleteTarget?.name}」吗？`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
