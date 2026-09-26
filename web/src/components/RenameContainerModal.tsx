/**
 * 重命名容器弹窗
 *
 * 从容器列表页抽出（1.92.0 重构）：输入新名称并调用 rename 接口。
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

interface RenameContainerModalProps {
  target: { id: string; name: string } | null;
  onClose: () => void;
  /** 重命名成功后通知调用方刷新列表与端口冲突映射 */
  onDone: () => void;
}

export default function RenameContainerModal({ target, onClose, onDone }: RenameContainerModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  // 打开（或切换目标）时以当前名称初始化输入框
  useEffect(() => {
    if (target) setRenameValue(target.name);
  }, [target]);

  /** 执行重命名（确认后调用后端接口） */
  async function confirmRename() {
    if (!target) return;
    if (!canOperate()) {
      showToast(t('仅管理员可重命名容器'), 'error');
      onClose();
      return;
    }
    const newName = renameValue.trim();
    // 名称必填与未变更校验
    if (!newName) {
      showToast(t('新名称不能为空'), 'error');
      return;
    }
    if (newName === target.name) {
      showToast(t('名称未发生变化'), 'error');
      return;
    }
    setRenaming(true);
    try {
      await post(`/api/containers/${target.id}/rename`, { name: newName });
      showToast(t('已重命名为 {{newName}}', { newName }));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('重命名失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setRenaming(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title={t('重命名容器')}
      onClose={() => !renaming && onClose()}
      width={440}
      footer={
        <div className="create-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={renaming}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={renaming} onClick={confirmRename}>
            {t('重命名')}
          </Button>
        </div>
      }
    >
      <Field label={t('新名称')} required hint={t('修改后立即生效')}>
        <Input
          placeholder={t('新容器名称')}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          autoFocus
          disabled={renaming}
        />
      </Field>
    </Modal>
  );
}
