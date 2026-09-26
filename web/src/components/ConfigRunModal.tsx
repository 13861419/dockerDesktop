/**
 * 运行配置编辑弹窗（重启策略 / 特权模式，通过重建容器生效）
 *
 * 从容器详情页抽出（1.92.0 重构）：以当前配置预填，提交后重建容器。
 * 条件渲染，成功后回调 onDone 刷新详情。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Select } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface ConfigRunModalProps {
  containerId: string;
  /** 当前重启策略（用于初始化草稿） */
  restartPolicy: string;
  /** 当前是否特权模式 */
  privileged: boolean;
  onClose: () => void;
  /** 保存成功后通知调用方刷新详情 */
  onDone: () => void;
}

export default function ConfigRunModal({ containerId, restartPolicy, privileged, onClose, onDone }: ConfigRunModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [cfgRestartDraft, setCfgRestartDraft] = useState(restartPolicy || 'no');
  const [cfgPrivilegedDraft, setCfgPrivilegedDraft] = useState(!!privileged);
  const [cfgSaving, setCfgSaving] = useState(false);

  /**
   * 保存运行配置：更新重启策略与特权模式并重建容器
   */
  async function saveCfg() {
    setCfgSaving(true);
    try {
      await post(`/api/containers/${containerId}/recreate`, {
        restartPolicy: cfgRestartDraft,
        privileged: cfgPrivilegedDraft,
      });
      showToast(t('运行配置已更新（容器已重建）'));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('更新失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setCfgSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t('运行配置')}
      onClose={() => !cfgSaving && onClose()}
      width={520}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={cfgSaving}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={cfgSaving} onClick={saveCfg}>
            {t('保存并重建')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('修改重启策略或特权模式需重新创建容器（保留镜像、端口、挂载、网络、环境变量等配置）。重建会导致容器短暂中断，容器 ID 会改变。')}
      </div>
      <Field label={t('重启策略')} required>
        <Select value={cfgRestartDraft} onChange={(e) => setCfgRestartDraft(e.target.value)}>
          <option value="no">{t('no（不自动重启）')}</option>
          <option value="always">{t('always（总是重启）')}</option>
          <option value="on-failure">{t('on-failure（失败时重启）')}</option>
          <option value="unless-stopped">{t('unless-stopped（除非停止，否则重启）')}</option>
        </Select>
      </Field>
      <Field label={t('特权模式')}>
        <label className="cfg-modal__priv">
          <input
            type="checkbox"
            checked={cfgPrivilegedDraft}
            onChange={(e) => setCfgPrivilegedDraft(e.target.checked)}
          />
          {t('以特权模式运行（授予容器更多 host 权限）')}
        </label>
      </Field>
    </Modal>
  );
}
