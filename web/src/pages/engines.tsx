/**
 * Docker 引擎管理页面
 *
 * 管理多个 Docker 引擎端点，可新增/编辑/删除/切换当前引擎。
 * 切换当前引擎后，面板所有 Docker 相关能力（容器/镜像/卷/网络/Compose/事件等）指向新引擎。
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
import { Field, Input, Select } from '../components/Form';
import {
  EngineAggregate,
  EngineAggregateResponse,
  EngineAggregateSummary,
  ImageItem,
  TransferBatchResponse,
} from '../types';
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
 * 将字节数格式化为人类可读大小
 * @param bytes 字节数
 */
function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 从镜像列表项中取可分发镜像名（优先取第一个标签，空标签时用 Id 前 12 位）
 * @param img 镜像项
 */
function imageName(img: ImageItem): string {
  if (img.RepoTags && img.RepoTags.length > 0 && img.RepoTags[0]) return img.RepoTags[0];
  return img.Id.slice(0, 12);
}

/**
 * Docker 引擎管理页面组件
 */
export default function EnginesPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();

  const [engines, setEngines] = useState<Engine[]>([]);
  const [loading, setLoading] = useState(false);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  // 跨引擎聚合总览
  const [aggregate, setAggregate] = useState<EngineAggregate[]>([]);
  const [totals, setTotals] = useState<EngineAggregateSummary | null>(null);
  const [aggLoading, setAggLoading] = useState(true);
  const [aggError, setAggError] = useState('');

  // 批量镜像分发
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferImages, setTransferImages] = useState<ImageItem[]>([]);
  const [transferImage, setTransferImage] = useState('');
  const [selectedTargets, setSelectedTargets] = useState<Record<string, boolean>>({});
  const [transferResults, setTransferResults] = useState<TransferBatchResponse | null>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  // 分发操作的目标引擎集合（除当前引擎外的其它引擎）
  const [transferTargets, setTransferTargets] = useState<Engine[]>([]);

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
   * 加载跨引擎聚合总览数据
   */
  const loadAggregate = useCallback(async () => {
    setAggLoading(true);
    try {
      const data = await get<EngineAggregateResponse>('/api/aggregate/engines');
      setAggregate(data?.engines || []);
      setTotals(data?.totals || null);
      setAggError('');
    } catch (e: any) {
      setAggregate([]);
      setTotals(null);
      setAggError(e?.message || '加载聚合总览失败');
    } finally {
      setAggLoading(false);
    }
  }, []);

  /**
   * 加载引擎列表及跨引擎聚合总览
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
    loadAggregate();
  }, [showToast, loadAggregate]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 打开新增弹窗
   */
  const openCreate = useCallback(() => {
    if (!canManage) {
      showToast('仅管理员可新增引擎', 'error');
      return;
    }
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
    if (!canManage) {
      showToast('仅管理员可编辑引擎', 'error');
      return;
    }
    setEditing(engine);
    setName(engine.name);
    setEndpoint(engine.endpoint);
    setErrors({});
    setModalOpen(true);
  }, [canManage, showToast]);

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
        await put(`/api/engines/${editing.id}`, { name: name.trim(), endpoint: endpoint.trim() });
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
  }, [canManage, editing, name, endpoint, load, showToast]);

  /**
   * 切换当前引擎
   * @param engine 目标引擎
   */
  const handleSwitch = useCallback(
    async (engine: Engine) => {
      if (!canManage) {
        showToast('仅管理员可切换引擎', 'error');
        return;
      }
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
    if (!canManage) {
      showToast('仅管理员可删除引擎', 'error');
      return;
    }
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
  }, [canManage, deleteTarget, load, showToast]);

  // 当前引擎（分发镜像的源引擎）
  const currentEngine = engines.find((e) => e.isCurrent) || null;
  // 可分发条件：存在当前引擎，且除当前引擎外至少还有一个其它引擎
  const transferAvailable = !!currentEngine && engines.some((e) => (e.id !== currentEngine.id)) && canManage;

  /**
   * 打开「分发镜像」弹窗
   * 以当前引擎为源，拉取其镜像列表作为可分发镜像；目标为除当前引擎外的其它引擎。
   */
  const openTransfer = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可分发镜像', 'error');
      return;
    }
    if (!currentEngine) {
      showToast('未检测到当前引擎，无法分发镜像', 'error');
      return;
    }
    const targets = engines.filter((e) => e.id !== currentEngine.id);
    setTransferTargets(targets);
    setSelectedTargets({});
    setTransferImage('');
    setTransferResults(null);
    setTransferOpen(true);
    // 拉取当前引擎已有镜像（/api/images 返回当前引擎镜像）
    try {
      const data = await get<ImageItem[]>('/api/images');
      setTransferImages(data || []);
      if (data && data.length > 0) setTransferImage(imageName(data[0]));
    } catch (e: any) {
      setTransferImages([]);
      showToast(e?.message || '加载镜像列表失败', 'error');
    }
  }, [canManage, currentEngine, engines, showToast]);

  /**
   * 提交批量镜像分发
   */
  const handleTransferSubmit = useCallback(async () => {
    if (!currentEngine) return;
    if (!transferImage) {
      showToast('请选择要分发的镜像', 'error');
      return;
    }
    const targetEngineIds = Object.keys(selectedTargets).filter((id) => selectedTargets[id]);
    if (targetEngineIds.length === 0) {
      showToast('请至少选择一个目标引擎', 'error');
      return;
    }
    setTransferLoading(true);
    try {
      const res = await post<TransferBatchResponse>('/api/transfer/batch', {
        image: transferImage,
        sourceEngineId: currentEngine.id,
        targetEngineIds,
      });
      setTransferResults(res || null);
      showToast(res && res.okCount > 0 ? `分发完成：成功 ${res.okCount}，失败 ${res.failedCount || 0}` : '分发完成');
    } catch (e: any) {
      showToast(e?.message || '镜像分发失败', 'error');
    } finally {
      setTransferLoading(false);
    }
  }, [currentEngine, transferImage, selectedTargets, showToast]);

  const totalCount = aggregate?.length || 0;
  const onlineCount = aggregate?.filter((a) => a.online).length || 0;
  const runningContainers = aggregate?.reduce((s, a) => s + (a.counts?.running || 0), 0) || 0;
  const containerCount = aggregate?.reduce((s, a) => s + (a.counts?.containers || 0), 0) || 0;
  const imgCount = aggregate?.reduce((s, a) => s + (a.counts?.images || 0), 0) || 0;
  const volumeCount = aggregate?.reduce((s, a) => s + (a.counts?.volumes || 0), 0) || 0;
  const networkCount = aggregate?.reduce((s, a) => s + (a.counts?.networks || 0), 0) || 0;
  const cpuTotal = aggregate?.reduce((s, a) => s + (a.resources?.nCPU || 0), 0) || 0;
  const memTotal = totals?.memTotal || aggregate?.reduce((s, a) => s + (a.resources?.memTotal || 0), 0) || 0;

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

      <Card title="跨引擎总览">
        {aggLoading ? (
          <SkeletonRows rows={3} />
        ) : aggError ? (
          <Empty
            kind="error"
            title="加载聚合总览失败"
            description={aggError || '请稍后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={loadAggregate}>
                重试
              </Button>
            }
          />
        ) : aggregate.length === 0 ? (
          <Empty title="暂无聚合数据" description="配置多个引擎后可在本区域查看跨引擎资源总览。" />
        ) : (
          <>
            <div className="en-summary">
              <div className="en-summary__item">
                <span className="en-summary__label">引擎总数</span>
                <span className="en-summary__value">{totalCount}</span>
              </div>
              <div className="en-summary__item">
                <span className="en-summary__label">在线数</span>
                <span className="en-summary__value">{onlineCount}</span>
              </div>
              <div className="en-summary__item">
                <span className="en-summary__label">容器（运行/总数）</span>
                <span className="en-summary__value en-summary__value--tiny">
                  {runningContainers}/{containerCount}
                </span>
              </div>
              <div className="en-summary__item">
                <span className="en-summary__label">镜像</span>
                <span className="en-summary__value">{imgCount}</span>
              </div>
              <div className="en-summary__item">
                <span className="en-summary__label">卷</span>
                <span className="en-summary__value">{volumeCount}</span>
              </div>
              <div className="en-summary__item">
                <span className="en-summary__label">网络</span>
                <span className="en-summary__value">{networkCount}</span>
              </div>
              <div className="en-summary__item">
                <span className="en-summary__label">CPU 核数</span>
                <span className="en-summary__value">{cpuTotal}</span>
              </div>
              <div className="en-summary__item">
                <span className="en-summary__label">内存</span>
                <span className="en-summary__value en-summary__value--tiny">{formatSize(memTotal)}</span>
              </div>
            </div>

            <div className="en-cards">
              {aggregate.map((a) => (
                <div key={a.id} className="en-card">
                  <div className="en-card__head">
                    <span className="en-card__name">
                      {a.name}
                      {a.isCurrent && <span className="en-badge en-badge--current">当前</span>}
                    </span>
                    <span className={`en-badge ${a.online ? 'en-badge--online' : 'en-badge--offline'}`}>
                      {a.online ? '在线' : '离线'}
                    </span>
                  </div>
                  {a.online ? (
                    <>
                      <div className="en-card__meta">
                        <span>v{a.version?.version || '-'}</span>
                        <span>{a.version?.os || '-'}/{a.version?.arch || '-'}</span>
                      </div>
                      <div className="en-card__meta">
                        <span>CPU {a.resources?.nCPU ?? '-'}</span>
                        <span>内存 {formatSize(a.resources?.memTotal)}</span>
                      </div>
                      <div className="en-card__counts">
                        <span>容器 {a.counts?.containers ?? 0}</span>
                        <span>镜像 {a.counts?.images ?? 0}</span>
                        <span>卷 {a.counts?.volumes ?? 0}</span>
                        <span>网络 {a.counts?.networks ?? 0}</span>
                      </div>
                    </>
                  ) : (
                    <div className="en-card__error">{a.error || '引擎不在线'}</div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

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
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={openTransfer}
                        disabled={!transferAvailable}
                        title={
                          !canManage
                            ? '仅管理员可分发镜像'
                            : !currentEngine
                              ? '未检测到当前引擎，无法分发'
                              : canManage && transferAvailable
                                ? '将当前引擎的镜像批量分发到其它引擎'
                                : '需要至少两个引擎且当前引擎外存在其它引擎'
                        }
                      >
                        分发镜像
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(e)} disabled={!canManage}>编辑</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(e)} disabled={!canManage}>删除</Button>
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
            disabled={!canManage}
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
            disabled={!canManage}
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

      {/* 批量镜像分发弹窗：以当前引擎为源，分发到其它引擎 */}
      <Modal
        open={transferOpen}
        title="批量分发镜像"
        onClose={() => setTransferOpen(false)}
        width={640}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setTransferOpen(false)}>取消</Button>
            <Button loading={transferLoading} onClick={handleTransferSubmit}>开始分发</Button>
          </div>
        }
      >
        <p className="en-hint" style={{ marginBottom: 12 }}>
          源：<strong>{currentEngine?.name || '-'}</strong>（当前引擎）
        </p>

        <Field label="源镜像" required>
          <Select
            value={transferImage}
            onChange={(e) => setTransferImage(e.target.value)}
            disabled={transferImages.length === 0}
          >
            {transferImages.length === 0 ? (
              <option value="">当前引擎暂无镜像</option>
            ) : (
              transferImages.map((img) => (
                <option key={img.Id} value={imageName(img)}>
                  {imageName(img)}
                </option>
              ))
            )}
          </Select>
        </Field>

        <Field label="目标引擎（可多选）" required>
          {transferTargets.length === 0 ? (
            <div className="en-hint">尚无可用目标引擎</div>
          ) : (
            transferTargets.map((t) => (
              <label
                key={t.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={!!selectedTargets[t.id]}
                  onChange={(e) =>
                    setSelectedTargets((prev) => ({ ...prev, [t.id]: e.target.checked }))
                  }
                />
                <span>{t.name}</span>
                {t.isCurrent && <span className="en-badge en-badge--current">当前</span>}
              </label>
            ))
          )}
        </Field>

        {transferResults && (
          <div style={{ marginTop: 12 }}>
            <div className="en-hint" style={{ marginBottom: 8 }}>
              分发结果：成功 {transferResults.okCount}，失败 {transferResults.failedCount}，
              共 {transferResults.total} 个目标
            </div>
            <div className="en-cards" style={{ gridTemplateColumns: '1fr' }}>
              {transferResults.results.map((r) => (
                <div key={r.engineId} className="en-card">
                  <div className="en-card__head">
                    <span className="en-card__name">{r.name}</span>
                    <span className={`en-badge ${r.ok ? 'en-badge--online' : 'en-badge--offline'}`}>
                      {r.ok ? '成功' : '失败'}
                    </span>
                  </div>
                  {r.ok ? (
                    <div className="en-card__meta">{r.loaded ? `已加载：${r.loaded}` : '已完成'}</div>
                  ) : (
                    <div className="en-card__error">{r.error || '分发失败'}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
