/**
 * 确认对话框组件
 *
 * 用于删除、停止等破坏性操作前的二次确认。
 */
import Modal from './Modal';
import Button from './Button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 二次确认对话框
 * @param param0 属性
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>{message}</div>
    </Modal>
  );
}
