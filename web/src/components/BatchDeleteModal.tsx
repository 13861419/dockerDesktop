/**
 * Compose 批量删除确认弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：含外部项目时需显式勾选知晓，
 * 支持同时删除数据卷。条件渲染，成功后回调 onDone（清空选择并刷新）。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface BatchDeleteModalProps {
  /** 待删除的项目名列表 */
  names: string[];
  /** 其中外部项目名列表（需显式确认知晓） */
  externals: string[];
  /** 删除权限（compose.write） */
  canDelete: boolean;
  onClose: () => void;
  /** 删除成功后通知调用方清空选择并刷新 */
  onDone: () => void;
}

export default function BatchDeleteModal({ names, externals, canDelete, onClose, onDone }: BatchDeleteModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [batchVolumes, setBatchVolumes] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchExternalAck, setBatchExternalAck] = useState(false);

  /** 批量删除：调后端批量端点，按成功/失败计数提示 */
  async function handleBatchDelete() {
    if (!canDelete) {
      showToast(t('仅管理员可删除 Compose 项目'), 'error');
      onClose();
      return;
    }
    setBatchDeleting(true);
    try {
      const r = await post<{ ok: boolean; deleted: string[]; failed: Array<{ name: string; error: string }> }>(
        '/api/compose/batch-delete',
        { names, volumes: batchVolumes },
      );
      const okCount = r?.deleted?.length || 0;
      const failCount = r?.failed?.length || 0;
      showToast(
        failCount === 0 ? t('已删除 {{n}} 个项目', { n: okCount }) : t('成功 {{n}} 个，失败 {{m}} 个', { n: okCount, m: failCount }),
        failCount === 0 ? undefined : 'error',
      );
      onClose();
      onDone();
    } catch (e: any) {
      showToast(e?.message || t('批量删除失败'), 'error');
    } finally {
      setBatchDeleting(false);
    }
  }

  return (
    <Modal
      open
      title={t('批量删除项目')}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={batchDeleting}>
            {t('取消')}
          </Button>
          <Button
            variant="danger"
            onClick={handleBatchDelete}
            loading={batchDeleting}
            disabled={!canDelete || (externals.length > 0 && !batchExternalAck)}
          >
            {t('删除')}
          </Button>
        </>
      }
    >
      <div className="compose-confirm">
        <p>{t('确定要删除 {{n}} 个 Compose 项目吗？此操作不可恢复。', { n: names.length })}</p>
        {externals.length > 0 && (
          <div className="compose-confirm__warn">
            <p>
              {t('含 {{n}} 个外部项目，删除将下线其容器（compose 文件保留）：', { n: externals.length })}
            </p>
            <p className="compose-confirm__warn-names">{externals.join('、')}</p>
            <label className="compose-confirm__check">
              <input
                type="checkbox"
                checked={batchExternalAck}
                onChange={(e) => setBatchExternalAck(e.target.checked)}
              />
              <span>{t('我已知晓外部项目将被下线容器')}</span>
            </label>
          </div>
        )}
        <label className="compose-confirm__check">
          <input
            type="checkbox"
            checked={batchVolumes}
            onChange={(e) => setBatchVolumes(e.target.checked)}
          />
          <span>{t('同时删除数据卷（volumes）')}</span>
        </label>
      </div>
    </Modal>
  );
}
