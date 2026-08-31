/**
 * Swarm 服务管理页面
 *
 * 展示当前引擎的 Swarm 集群状态与服务列表，提供服务副本缩放与服务删除能力。
 * 未启用 Swarm 时显示空态提示并隐藏服务列表。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { Field, Input } from '../components/Form';
import { SwarmStatus, SwarmServiceItem } from '../types';
import { translateNow as t } from '../i18n';
import './swarm.less';

/** Swarm 节点精简结构（对齐 /api/swarm/status 返回） */
interface SwarmNode {
  id: string;
  hostname: string;
  role: string;
  availability: string;
  status: string;
  managerStatus?: { leader?: boolean; reachability?: string; addr?: string };
}

/** Swarm 状态响应（/api/swarm/status），nodes 为节点列表 */
interface SwarmStatusResponse {
  enabled: boolean;
  localNodeState: string;
  controlAvailable: boolean;
  managers?: number;
  nodeID?: string;
  nodes: SwarmNode[];
}

/** 服务列表响应（/api/swarm/services） */
interface ServicesResponse {
  ok: boolean;
  services?: SwarmServiceItem[];
  error?: string;
}

/** 缩放弹窗的目标服务状态 */
interface ScaleTarget {
  id: string;
  name: string;
  replicas: number;
}

/** 删除确认的服务状态 */
interface DeleteTarget {
  id: string;
  name: string;
}

/**
 * Swarm 服务管理页面组件
 */
export default function SwarmPage() {
  const { showToast } = useToast();
  // 缩放/删除均为管理员操作（后端 requireAdmin），用 isAdmin 控制按钮显隐
  const canManage = isAdmin();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<SwarmStatus | null>(null);
  const [nodes, setNodes] = useState<SwarmNode[]>([]);
  const [services, setServices] = useState<SwarmServiceItem[]>([]);

  // 缩放弹窗状态
  const [scaleTarget, setScaleTarget] = useState<ScaleTarget | null>(null);
  const [scaleValue, setScaleValue] = useState('');
  const [scaling, setScaling] = useState(false);

  // 删除确认状态
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  /**
   * 加载 Swarm 状态、节点与服务列表
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const statusRes = await get<SwarmStatusResponse>('/api/swarm/status');
      // 状态条需要的精简状态字段（nodes 一律以节点列表为准）
      setStatus({
        enabled: statusRes?.enabled,
        localNodeState: statusRes?.localNodeState,
        controlAvailable: statusRes?.controlAvailable,
        managers: statusRes?.managers,
        nodeID: statusRes?.nodeID,
      });
      setNodes(statusRes?.nodes || []);

      // 仅在启用 Swarm 时拉取服务列表
      if (statusRes?.enabled) {
        const svcRes = await get<ServicesResponse>('/api/swarm/services');
        setServices(svcRes?.services || []);
        if (!svcRes?.ok) {
          showToast(svcRes?.error === 'swarm-not-enabled' ? t('Swarm 未启用') : (svcRes?.error || t('获取服务列表失败')), 'error');
        }
      } else {
        setServices([]);
      }
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || t('获取 Swarm 状态失败'));
      showToast(e?.message || t('获取 Swarm 状态失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 打开缩放弹窗，预填当前期望副本数
   * @param svc 目标服务
   */
  function openScale(svc: SwarmServiceItem) {
    if (!canManage) {
      showToast(t('仅管理员可缩放服务'), 'error');
      return;
    }
    setScaleTarget({ id: svc.id, name: svc.name, replicas: svc.desired ?? svc.runningTasks });
    setScaleValue(String(svc.desired ?? svc.runningTasks ?? 0));
  }

  /**
   * 提交缩放操作
   */
  async function confirmScale() {
    if (!scaleTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可缩放服务'), 'error');
      setScaleTarget(null);
      return;
    }
    const replicas = Number(scaleValue.trim());
    // 校验目标副本数：须为非负整数
    if (!Number.isInteger(replicas) || replicas < 0) {
      showToast(t('请输入有效的非负整数副本数'), 'error');
      return;
    }
    setScaling(true);
    try {
      const res = await post<{ ok: boolean; error?: string }>(`/api/swarm/services/${scaleTarget.id}/scale`, {
        replicas,
      });
      if (!res?.ok) {
        showToast(res?.error || t('缩放服务失败'), 'error');
        setScaleTarget(null);
        return;
      }
      showToast(t('已将 {{v1}} 缩放到 {{replicas}} 副本', { v1: scaleTarget.name, replicas }));
      setScaleTarget(null);
      load();
    } catch (e: any) {
      showToast(t('缩放失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setScaling(false);
    }
  }

  /**
   * 打开删除确认
   * @param svc 目标服务
   */
  function openDelete(svc: SwarmServiceItem) {
    if (!canManage) {
      showToast(t('仅管理员可删除服务'), 'error');
      return;
    }
    setDeleteTarget({ id: svc.id, name: svc.name });
  }

  /**
   * 提交删除操作
   */
  async function confirmDelete() {
    if (!canManage) {
      showToast(t('仅管理员可删除服务'), 'error');
      setDeleteTarget(null);
      return;
    }
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await del<{ ok: boolean; error?: string }>(`/api/swarm/services/${deleteTarget.id}`);
      if (!res?.ok) {
        showToast(res?.error || t('删除服务失败'), 'error');
        setDeleteTarget(null);
        return;
      }
      showToast(t('已删除服务 {{v1}}', { v1: deleteTarget.name }));
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(t('删除失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setDeleting(false);
    }
  }

  /**
   * 格式化更新时间（毫秒时间戳）
   * @param ts 毫秒时间戳
   */
  function formatUpdatedAt(ts: number): string {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  /**
   * 渲染服务模式标签
   * @param mode 服务模式（global/replicated）
   */
  function renderMode(mode: string): string {
    return mode === 'global' ? t('全局') : t('副本');
  }

  if (loading) {
    return (
      <div className="swarm-page">
        <h1 className="swarm-page__title">{t('Swarm 服务')}</h1>
        <SkeletonRows rows={1} />
      </div>
    );
  }

  const enabled = !!status?.enabled;

  return (
    <div className="swarm-page">
      <h1 className="swarm-page__title">{t('Swarm 服务')}</h1>

      {/* 顶部 Swarm 状态条 */}
      <Card className="swarm-status">
        <div className="swarm-status__row">
          <div className="swarm-status__item">
            <span className="swarm-status__label">{t('集群状态')}</span>
            <span className={`swarm-status__value swarm-status__badge ${enabled ? 'swarm-status__badge--on' : 'swarm-status__badge--off'}`}>
              <span className="swarm-status__dot" />
              {enabled ? t('已启用') : t('未启用')}
            </span>
          </div>
          <div className="swarm-status__item">
            <span className="swarm-status__label">{t('节点状态')}</span>
            <span className="swarm-status__value">{status?.localNodeState || '-'}</span>
          </div>
          <div className="swarm-status__item">
            <span className="swarm-status__label">{t('集群节点')}</span>
            <span className="swarm-status__value">{nodes.length}</span>
          </div>
          <div className="swarm-status__item">
            <span className="swarm-status__label">{t('管理节点')}</span>
            <span className="swarm-status__value">{typeof status?.managers === 'number' ? status.managers : '-'}</span>
          </div>
          <div className="swarm-status__item">
            <span className="swarm-status__label">{t('本节点 ID')}</span>
            <span className="swarm-status__value swarm-status__value--mono">{status?.nodeID || '-'}</span>
          </div>
          <div className="swarm-status__item swarm-status__item--right">
            <Button variant="secondary" size="sm" onClick={load}>
              {t('刷新')}
            </Button>
          </div>
        </div>
      </Card>

      {/* 未启用 Swarm：显示空态提示，隐藏服务列表 */}
      {!enabled ? (
        <Card>
          <Empty
            kind="empty"
            title={t('Swarm 集群未启用')}
            description="当前 Docker 引擎未启用 Swarm 模式。请先在 Docker 中初始化或加入 Swarm 集群后，再回到此页面查看与管理服务。"
          />
        </Card>
      ) : loadError ? (
        <Card>
          <Empty
            kind="error"
            title={t('加载 Swarm 服务失败')}
            description={loadError || t('请检查 Docker 引擎连接后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={load}>
                {t('重试')}
              </Button>
            }
          />
        </Card>
      ) : (
        <Card title={t('服务列表（{{v1}}）', { v1: services.length })}>
          {services.length === 0 ? (
            <Empty kind="empty" title={t('暂无服务')} description="当前 Swarm 集群中尚未部署任何服务" />
          ) : (
            <div className="swarm-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('服务名')}</th>
                    <th>{t('镜像')}</th>
                    <th>{t('模式')}</th>
                    <th>{t('期望副本')}</th>
                    <th>{t('运行副本')}</th>
                    <th>{t('更新时间')}</th>
                    <th className="col-actions">{t('操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map((svc) => (
                    <tr key={svc.id}>
                      <td className="col-name" title={svc.id}>
                        <span className="name-main">{svc.name || svc.id}</span>
                      </td>
                      <td className="col-mono">{svc.image || '-'}</td>
                      <td>{renderMode(svc.mode)}</td>
                      <td>{svc.desired ?? '-'}</td>
                      <td>
                        <span
                          className={`swarm-task ${svc.desired != null && svc.desired > 0 && svc.runningTasks < svc.desired ? 'swarm-task--partial' : ''}`}
                        >
                          {svc.runningTasks}
                        </span>
                      </td>
                      <td className="swarm-page__time">{formatUpdatedAt(svc.updatedAt)}</td>
                      <td className="col-actions">
                        <div className="swarm-page__actions">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openScale(svc)}
                            disabled={!canManage || svc.mode === 'global'}
                            title={svc.mode === 'global' ? t('全局模式服务不支持缩放副本数') : t('调整副本数')}
                          >
                            {t('缩放')}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => openDelete(svc)}
                            disabled={!canManage}
                          >
                            {t('删除')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* 缩放弹窗 */}
      <Modal
        open={!!scaleTarget}
        title={t('缩放服务{{v1}}', { v1: scaleTarget ? t('「{{name}}」', { name: scaleTarget.name }) : '' })}
        onClose={() => !scaling && setScaleTarget(null)}
        width={440}
        footer={
          <div className="swarm-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setScaleTarget(null)} disabled={scaling}>
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" loading={scaling} onClick={confirmScale}>
              {t('确定缩放')}
            </Button>
          </div>
        }
      >
        <Field label={t('目标副本数')} required hint={t('输入服务期望运行的副本数量（非负整数），立即生效。')}>
          <Input
            type="number"
            min={0}
            step={1}
            placeholder={t('如 3')}
            value={scaleValue}
            onChange={(e) => setScaleValue(e.target.value)}
            autoFocus
            disabled={scaling}
          />
        </Field>
      </Modal>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('删除服务')}
        message={t('确定要删除服务「{{v1}}」吗？删除后其下所有任务将被停止，此操作不可撤销。', { v1: deleteTarget?.name || '' })}
        confirmText={t('删除')}
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
