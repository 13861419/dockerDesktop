/**
 * Compose 停止（down）确认弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：可选同时删除数据卷，
 * 支持审批流（approvalPending）。条件渲染，成功后回调 onDone 刷新。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { useToast } from './Toast';
import { useCanManage } from '../hooks/useCanManage';
import { useLang } from '../i18n';

interface StopDownModalProps {
  /** 项目名 */
  name: string;
  onClose: () => void;
  /** 停止成功（或已提交审批）后通知调用方刷新 */
  onDone: () => void;
}

export default function StopDownModal({ name, onClose, onDone }: StopDownModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const canManage = useCanManage();
  const [stopVolumes, setStopVolumes] = useState(false);
  const [stopping, setStopping] = useState(false);

  /** 执行停止（down）操作，带删卷选择 */
  async function handleStopConfirm() {
    setStopping(true);
    try {
      const resp = await post<{ ok: boolean; approvalPending?: boolean }>('/api/compose/' + encodeURIComponent(name) + '/down', {
        volumes: stopVolumes,
      });
      if (resp?.approvalPending) {
        showToast(t('该操作已提交审批，等待管理员批准后执行'), 'info');
      } else {
        showToast(stopVolumes ? t('项目已停止，数据卷已删除') : t('项目已停止'));
      }
      onClose();
      onDone();
      return;
    } catch (e: any) {
      showToast(e?.message || t('停止项目失败'), 'error');
    }
    setStopping(false);
  }

  return (
    <Modal
      open
      title={t('停止项目')}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={stopping}>
            {t('取消')}
          </Button>
          <Button onClick={handleStopConfirm} loading={stopping} disabled={!canManage}>
            {t('停止')}
          </Button>
        </>
      }
    >
      <div className="compose-confirm">
        <p>{t('确定要停止 Compose 项目 "{{name}}" 吗？', { name })}</p>
        <label className="compose-confirm__check">
          <input
            type="checkbox"
            checked={stopVolumes}
            onChange={(e) => setStopVolumes(e.target.checked)}
          />
          <span>{t('同时删除该项目的数据卷（volumes）')}</span>
        </label>
      </div>
    </Modal>
  );
}
