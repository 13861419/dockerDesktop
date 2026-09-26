/**
 * 清理未使用资源确认弹窗
 *
 * 从容器列表页抽出（1.92.0 重构）：清理悬空镜像 / 已停止容器 / 未使用网络、
 * 卷与构建缓存（POST /api/system/prune），完成后回调 onDone 通知刷新。
 */
import { useState } from 'react';
import { post } from '../api/client';
import { canOperate } from '../api/auth';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface PruneModalProps {
  open: boolean;
  onClose: () => void;
  /** 清理成功后通知调用方刷新列表 */
  onDone: () => void;
}

/** 字节数格式化为可读大小 */
function formatSpace(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

export default function PruneModal({ open, onClose, onDone }: PruneModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [pruning, setPruning] = useState(false);

  /**
   * 清理未使用资源（悬空镜像 / 未使用网络 / 未使用卷 / build cache）。
   * 仅清理未使用资源，不会删除任何运行中的容器。
   */
  async function confirmPrune() {
    if (!canOperate()) {
      showToast(t('仅管理员可清理未使用资源'), 'error');
      onClose();
      return;
    }
    setPruning(true);
    try {
      const res = await post<any>('/api/system/prune', {
        images: true,
        containers: true,
        networks: true,
        volumes: true,
        buildCache: true,
      });
      const space = formatSpace(res?.totalSpace);
      showToast(t('清理完成，释放空间 {{space}}', { space }));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('清理失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setPruning(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title={t('清理未使用资源')}
      message={t('将清理未使用的镜像、已停止的容器、未使用的数据卷与网络、以及构建缓存。此操作不可撤销，但不会影响处于运行中的容器。')}
      confirmText={t('清理')}
      danger
      loading={pruning}
      onConfirm={confirmPrune}
      onCancel={onClose}
    />
  );
}
