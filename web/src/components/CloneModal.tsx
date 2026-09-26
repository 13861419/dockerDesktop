/**
 * 克隆容器弹窗（详情页）
 *
 * 从容器详情页抽出（1.92.0 重构）：预填 <原名>-clone 与「创建后启动」选项，
 * 基于现有容器复制配置创建新容器（不删除原容器）。条件渲染，成功后回调 onDone。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface CloneModalProps {
  containerId: string;
  /** 源容器名（用于预填与提示） */
  containerName: string;
  onClose: () => void;
  /** 克隆成功后通知调用方刷新详情 */
  onDone: () => void;
}

export default function CloneModal({ containerId, containerName, onClose, onDone }: CloneModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [cloneValue, setCloneValue] = useState(containerName ? `${containerName}-clone` : '');
  const [cloneStart, setCloneStart] = useState(true);
  const [cloning, setCloning] = useState(false);

  /**
   * 执行克隆：基于现有容器复制配置创建新容器，不删除原容器
   *
   * 成功后提示新容器名并刷新详情；失败时 toast 后端错误信息。
   */
  async function submitClone() {
    // 新名称必填校验
    if (!cloneValue.trim()) {
      showToast(t('新名称不能为空'), 'error');
      return;
    }
    setCloning(true);
    try {
      const res = await post<any>(`/api/containers/${containerId}/clone`, {
        name: cloneValue.trim(),
        start: cloneStart,
      });
      // 以后端返回的新容器名为准，缺省回退到输入框内容
      const clonedName = res?.name || cloneValue.trim();
      showToast(t('已克隆为 {{clonedName}}', { clonedName }));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('克隆失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setCloning(false);
    }
  }

  return (
    <Modal
      open
      title={t('克隆容器')}
      onClose={() => !cloning && onClose()}
      width={520}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={cloning}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={cloning} onClick={submitClone}>
            {t('克隆')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('基于「{{name}}」复制配置并创建新容器，原容器保留不变。', { name: containerName })}
      </div>
      <Field label={t('新名称')} required>
        <Input
          placeholder={t('新容器名称')}
          value={cloneValue}
          onChange={(e) => setCloneValue(e.target.value)}
          autoFocus
          disabled={cloning}
        />
      </Field>
      <label className="clone-modal__start">
        <input
          type="checkbox"
          checked={cloneStart}
          onChange={(e) => setCloneStart(e.target.checked)}
          disabled={cloning}
        />
        {t('创建后启动')}
      </label>
    </Modal>
  );
}
