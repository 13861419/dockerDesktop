/**
 * Compose 结构视图弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：解析项目结构并以服务卡片展示
 * 端口 / 依赖 / 卷 / 环境变量，支持单服务 start / stop / restart。
 * 条件渲染，挂载时拉取结构数据。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import Empty from './Empty';
import { useToast } from './Toast';
import { useCanManage } from '../hooks/useCanManage';
import { ComposeStructure } from '../types';
import { translateNow as t } from '../i18n';

interface ComposeStructureModalProps {
  /** 项目名 */
  name: string;
  onClose: () => void;
  /** 打开某服务的日志弹窗 */
  onViewLog: (name: string, service: string) => void;
  /** 服务操作成功后通知调用方刷新项目列表 */
  onRefresh: () => void;
}

export default function ComposeStructureModal({ name, onClose, onViewLog, onRefresh }: ComposeStructureModalProps) {
  const { showToast } = useToast();
  const canManage = useCanManage();
  const [structureData, setStructureData] = useState<ComposeStructure | null>(null);
  const [structureLoading, setStructureLoading] = useState(false);
  const [serviceOpKey, setServiceOpKey] = useState<string | null>(null);

  /** 关闭结构视图弹窗 */
  function closeStructure() {
    onClose();
  }

  // 挂载时拉取 Compose 结构
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStructureLoading(true);
      try {
        const data = await get<ComposeStructure>('/api/compose/' + encodeURIComponent(name) + '/structure');
        if (!cancelled) {
          setStructureData({
            name,
            services: data?.services || [],
            volumes: data?.volumes || [],
            networks: data?.networks || [],
          });
        }
      } catch (e: any) {
        showToast(e?.message || t('获取 Compose 结构失败'), 'error');
        if (!cancelled) onClose();
      } finally {
        if (!cancelled) setStructureLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 对单个 compose 服务执行 start / stop / restart 操作
   * @param service 服务名
   * @param action 动作标识
   * @param successMsg 成功提示
   */
  const runServiceAction = useCallback(
    async (service: string, action: string, successMsg: string) => {
      if (!canManage) {
        showToast(t('仅管理员可操作 Compose 服务'), 'error');
        return;
      }
      const key = `${service}/${action}`;
      setServiceOpKey(key);
      try {
        await post('/api/compose/' + encodeURIComponent(name) + '/services/' + encodeURIComponent(service) + '/' + action);
        showToast(successMsg);
        // 操作后刷新结构数据与项目状态
        const data = await get<ComposeStructure>('/api/compose/' + encodeURIComponent(name) + '/structure').catch(() => structureData);
        if (data) {
          setStructureData(data);
        }
        onRefresh();
      } catch (e: any) {
        showToast(e?.message || successMsg.replace(t('成功'), t('失败')), 'error');
      } finally {
        setServiceOpKey(null);
      }
    },
    [canManage, name, structureData, showToast, onRefresh]
  );

  return (
    <Modal
      open
      title={structureData ? t('{{v1}} - 结构', { v1: structureData.name }) : t('Compose 结构')}
      onClose={closeStructure}
      width={760}
      footer={
        <Button variant="secondary" onClick={closeStructure} disabled={structureLoading}>
          {t('关闭')}
        </Button>
      }
    >
      {structureLoading ? (
        <div className="log-empty">{t('正在解析 Compose 结构…')}</div>
      ) : structureData ? (
        <div className="structure">
          <div className="structure__meta">
            <span>
              {t('项目：')}<b>{structureData.name}</b>
            </span>
            <span>
              {t('服务：')}<b>{structureData.services.length}</b>
            </span>
            {structureData.volumes.length > 0 && (
              <span>
                {t('卷：')}<b>{structureData.volumes.join(', ') || '-'}</b>
              </span>
            )}
            {structureData.networks.length > 0 && (
              <span>
                {t('网络：')}<b>{structureData.networks.join(', ') || '-'}</b>
              </span>
            )}
          </div>
          {structureData.services.length === 0 ? (
            <Empty title={t('暂无服务')} description={t('该 Compose 项目未定义任何服务')} />
          ) : (
            <div className="structure__list">
              {structureData.services.map((svc) => {
                const isOp = serviceOpKey && serviceOpKey.startsWith(svc.name + '/');
                return (
                  <div className="structure-card" key={svc.name}>
                    <div className="structure-card__head">
                      <span className="structure-card__name">{svc.name}</span>
                      <span className="structure-card__image" title={svc.image || ''}>
                        {svc.image || t('（build 构建）')}
                      </span>
                      <div className="structure-card__actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={serviceOpKey === `${svc.name}/start`}
                          disabled={!canManage || !!isOp}
                          onClick={() => runServiceAction(svc.name, 'start', t('{{v1}} 启动成功', { v1: svc.name }))}
                        >
                          {t('启动')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={serviceOpKey === `${svc.name}/stop`}
                          disabled={!canManage || !!isOp}
                          onClick={() => runServiceAction(svc.name, 'stop', t('{{v1}} 停止成功', { v1: svc.name }))}
                        >
                          {t('停止')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={serviceOpKey === `${svc.name}/restart`}
                          disabled={!canManage || !!isOp}
                          onClick={() => runServiceAction(svc.name, 'restart', t('{{v1}} 重启成功', { v1: svc.name }))}
                        >
                          {t('重启')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onViewLog(structureData.name, svc.name)}
                        >
                          {t('日志')}
                        </Button>
                      </div>
                    </div>
                    <div className="structure-card__body">
                      {svc.ports.length > 0 && (
                        <div className="structure-line">
                          <span className="structure-label">{t('端口')}</span>
                          <span className="structure-value">
                            {svc.ports
                              .map((p) =>
                                p.published
                                  ? `${p.published}:${p.target}/${p.protocol}`
                                  : `${p.target}/${p.protocol}`
                              )
                              .join('，')}
                          </span>
                        </div>
                      )}
                      {svc.depends_on.length > 0 && (
                        <div className="structure-line">
                          <span className="structure-label">{t('依赖')}</span>
                          <span className="structure-value">{svc.depends_on.join('，')}</span>
                        </div>
                      )}
                      {svc.volumes.length > 0 && (
                        <div className="structure-line">
                          <span className="structure-label">{t('卷')}</span>
                          <span className="structure-value">
                            {svc.volumes
                              .map((v) => `${v.source || ''} -> ${v.target}${v.readOnly ? t(' (只读)') : ''}`.replace(/^\s+->/, ''))
                              .join('，')}
                          </span>
                        </div>
                      )}
                      {svc.environment.length > 0 && (
                        <div className="structure-line">
                          <span className="structure-label">{t('环境')}</span>
                          <span className="structure-value">{svc.environment.join('，')}</span>
                        </div>
                      )}
                      {svc.ports.length === 0 &&
                        svc.depends_on.length === 0 &&
                        svc.volumes.length === 0 &&
                        svc.environment.length === 0 && (
                          <div className="structure-line">
                            <span className="structure-value">{t('（无额外配置）')}</span>
                          </div>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
