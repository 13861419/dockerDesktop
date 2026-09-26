/**
 * 批量编辑资源限制弹窗（CPU / 内存，对应 docker update）
 *
 * 从容器列表页抽出（1.92.0 重构）：对选中的多个容器在线更新资源限制，
 * 留空字段不修改。提交成功后回调 onDone（清空选择并刷新列表）。
 */
import { useEffect, useState } from 'react';
import { post } from '../api/client';
import { canOperate } from '../api/auth';
import Button from './Button';
import Modal from './Modal';
import { Field, Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface BatchResourceModalProps {
  open: boolean;
  /** 选中的容器 ID 列表 */
  ids: string[];
  onClose: () => void;
  /** 更新成功后通知调用方清空选择并刷新列表 */
  onDone: () => void;
}

export default function BatchResourceModal({ open, ids, onClose, onDone }: BatchResourceModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  // CPU 核数 / 内存 GB（留空=不修改），loading 控制提交中
  const [batchEditCpu, setBatchEditCpu] = useState('');
  const [batchEditMem, setBatchEditMem] = useState('');
  const [batchEditLoading, setBatchEditLoading] = useState(false);

  // 每次打开时清空输入（留空=不修改）
  useEffect(() => {
    if (open) {
      setBatchEditCpu('');
      setBatchEditMem('');
    }
  }, [open]);

  /**
   * 提交批量资源限制更新。
   * 留空的字段不传，表示不修改；填值则完成单位换算（CPU 核数 -> 纳核，内存 GB -> 字节）。
   * 调用 POST /api/containers/batch/update 后按 success/fail 提示并刷新列表。
   */
  async function confirmBatchEdit() {
    if (ids.length === 0) return;
    if (!canOperate()) {
      showToast(t('仅管理员或运维人员可编辑资源限制'), 'error');
      onClose();
      return;
    }
    const body: Record<string, unknown> = { ids };
    // CPU：留空表示不修改；填 0 表示取消限制；否则核数转纳核
    if (batchEditCpu.trim() !== '') {
      const cpus = parseFloat(batchEditCpu);
      if (isNaN(cpus) || cpus < 0) {
        showToast(t('请输入有效的 CPU 核数（如 1 或 1.5）'), 'error');
        return;
      }
      body.cpuLimit = Math.round(cpus * 1e9);
    }
    // 内存：留空表示不修改；填 0 表示取消限制；否则 GB 转字节
    if (batchEditMem.trim() !== '') {
      const gb = parseFloat(batchEditMem);
      if (isNaN(gb) || gb < 0) {
        showToast(t('请输入有效的内存大小（GB，如 2）'), 'error');
        return;
      }
      body.memLimit = Math.round(gb * 1024 * 1024 * 1024);
    }
    // 至少需填写一项，否则无任何可更新内容
    if (body.cpuLimit === undefined && body.memLimit === undefined) {
      showToast(t('请至少填写 CPU 或内存限制其一'), 'error');
      return;
    }
    setBatchEditLoading(true);
    try {
      const r = await post<{ success: number; fail: number }>('/api/containers/batch/update', body);
      const success = r?.success ?? 0;
      const fail = r?.fail ?? 0;
      onClose();
      onDone();
      if (fail === 0) {
        showToast(t('已更新 {{success}} 个容器的资源限制', { success }));
      } else if (success === 0) {
        showToast(t('更新失败 {{fail}} 个容器', { fail }), 'error');
      } else {
        showToast(t('更新成功 {{success}} 个，失败 {{fail}} 个容器', { success, fail }), 'info');
      }
    } catch (e: any) {
      showToast(t('批量更新失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setBatchEditLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t('批量编辑资源限制')}
      onClose={() => !batchEditLoading && onClose()}
      width={520}
      footer={
        <div className="create-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={batchEditLoading}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={batchEditLoading} onClick={confirmBatchEdit}>
            {t('保存')}
          </Button>
        </div>
      }
    >
      <div className="batch-edit__tip">
        {t('将为选中的 {{n}} 个容器在线更新资源限制，无需重建、不中断运行。留空的字段将保持现状。', { n: ids.length })}
      </div>
      <div className="create-modal__grid">
        <Field label={t('CPU 限制（核数，留空不修改；填 0 取消限制）')} hint={t('如 1 或 1.5')}>
          <Input
            type="number"
            min={0}
            step="0.1"
            placeholder={t('如 1 或 1.5')}
            value={batchEditCpu}
            onChange={(e) => setBatchEditCpu(e.target.value)}
            disabled={batchEditLoading}
          />
        </Field>
        <Field label={t('内存限制（GB，留空不修改；填 0 取消限制）')} hint={t('如 2')}>
          <Input
            type="number"
            min={0}
            step="0.5"
            placeholder={t('如 2')}
            value={batchEditMem}
            onChange={(e) => setBatchEditMem(e.target.value)}
            disabled={batchEditLoading}
          />
        </Field>
      </div>
    </Modal>
  );
}
