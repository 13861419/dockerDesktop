/**
 * Compose 删除项目确认弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：可选同时删除数据卷，
 * 外部项目删除将仅下线容器并保留 compose 文件。条件渲染。
 */
import { useState } from 'react';
import { del } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface DeleteProjectModalProps {
  /** 项目名 */
  name: string;
  /** 删除权限（compose.write） */
  canDelete: boolean;
  onClose: () => void;
  /** 删除成功后通知调用方刷新 */
  onDone: () => void;
}

export default function DeleteProjectModal({ name, canDelete, onClose, onDone }: DeleteProjectModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /** 删除项目（根据 deleteVolumes 决定是否同时删除数据卷） */
  async function handleDelete() {
    if (!canDelete) {
      showToast(t('仅管理员可删除 Compose 项目'), 'error');
      onClose();
      return;
    }
    setDeleting(true);
    try {
      const r = await del<{ ok: boolean; external?: boolean }>('/api/compose/' + encodeURIComponent(name), { volumes: deleteVolumes });
      showToast(r?.external ? t('外部项目已下线容器，compose 文件已保留') : t('项目删除成功'));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(e?.message || t('项目删除失败'), 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open
      title={t('删除项目')}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
              setDeleteVolumes(false);
            }}
            disabled={deleting}
          >
            {t('取消')}
          </Button>
          <Button variant="danger" onClick={handleDelete} loading={deleting} disabled={!canDelete}>
            {t('删除')}
          </Button>
        </>
      }
    >
      <div className="compose-confirm">
        <p>{t('确定要删除 Compose 项目 "{{name}}" 吗？此操作不可恢复。', { name })}</p>
        <label className="compose-confirm__check">
          <input
            type="checkbox"
            checked={deleteVolumes}
            onChange={(e) => setDeleteVolumes(e.target.checked)}
          />
          <span>{t('同时删除该项目的数据卷（volumes）')}</span>
        </label>
      </div>
    </Modal>
  );
}
