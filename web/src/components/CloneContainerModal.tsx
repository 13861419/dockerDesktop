/**
 * 克隆容器弹窗
 *
 * 从容器列表页抽出（1.92.0 重构）：预填 <原名>-clone，调用 clone 接口复制容器。
 * 条件渲染（target 非空才挂载），成功后回调 onDone 通知刷新。
 */
import { useEffect, useState } from 'react';
import { post } from '../api/client';
import { canOperate } from '../api/auth';
import Button from './Button';
import Modal from './Modal';
import { Field, Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface CloneContainerModalProps {
  target: { id: string; name: string } | null;
  onClose: () => void;
  /** 克隆成功后通知调用方刷新列表与端口冲突映射 */
  onDone: () => void;
}

export default function CloneContainerModal({ target, onClose, onDone }: CloneContainerModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [cloneValue, setCloneValue] = useState('');
  const [cloning, setCloning] = useState(false);

  // 打开（或切换目标）时预填 <原名>-clone
  useEffect(() => {
    if (target) setCloneValue(`${target.name}-clone`);
  }, [target]);

  /** 执行克隆（确认后调用后端接口） */
  async function confirmClone() {
    if (!target) return;
    if (!canOperate()) {
      showToast(t('仅管理员可克隆容器'), 'error');
      onClose();
      return;
    }
    const newName = cloneValue.trim();
    // 名称必填校验
    if (!newName) {
      showToast(t('新名称不能为空'), 'error');
      return;
    }
    setCloning(true);
    try {
      const res = await post<any>(`/api/containers/${target.id}/clone`, { name: newName });
      const clonedName = res?.name || newName;
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
      open={!!target}
      title={t('克隆容器')}
      onClose={() => !cloning && onClose()}
      width={440}
      footer={
        <div className="create-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={cloning}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={cloning} onClick={confirmClone}>
            {t('克隆')}
          </Button>
        </div>
      }
    >
      <Field label={t('新名称')} required hint={t('将基于「{{v1}}」复制配置并创建新容器，原容器保留', { v1: target?.name || '' })}>
        <Input
          placeholder={t('新容器名称')}
          value={cloneValue}
          onChange={(e) => setCloneValue(e.target.value)}
          autoFocus
          disabled={cloning}
        />
      </Field>
    </Modal>
  );
}
