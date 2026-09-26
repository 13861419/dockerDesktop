/**
 * 更新配置弹窗（重启策略 / 资源限制，免重建，对应 docker update）
 *
 * 从容器详情页抽出（1.92.0 重构）：以当前重启策略 / 资源限制预填
 * （cpuLimit 纳核转核数、memLimit 字节转 GB），提交后调用 update 接口在线生效。
 * 条件渲染，成功后回调 onDone 刷新详情。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Input, Select } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface UpdateConfigModalProps {
  containerId: string;
  /** 当前重启策略（用于初始化草稿） */
  restartPolicy: string;
  /** 当前 CPU 限制（纳核，0/空 = 未设置） */
  cpuLimit: number;
  /** 当前内存限制（字节，0/空 = 未设置） */
  memLimit: number;
  onClose: () => void;
  /** 更新成功后通知调用方刷新详情 */
  onDone: () => void;
}

export default function UpdateConfigModal({
  containerId,
  restartPolicy,
  cpuLimit,
  memLimit,
  onClose,
  onDone,
}: UpdateConfigModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [uRestart, setURestart] = useState(restartPolicy || 'no');
  const [uCpu, setUCpu] = useState(() => (cpuLimit ? String((cpuLimit / 1e9).toFixed(3)) : ''));
  const [uMem, setUMem] = useState(() => (memLimit ? String((memLimit / 1024 / 1024 / 1024).toFixed(2)) : ''));
  const [updating, setUpdating] = useState(false);

  /** 在线更新容器配置：提交重启策略与资源限制（对应 docker update，免重建） */
  async function saveUpdate() {
    const body: Record<string, unknown> = { restartPolicy: uRestart };
    // CPU：留空表示不修改；填数字则转为纳核
    if (uCpu.trim() !== '') {
      const cpus = parseFloat(uCpu);
      if (isNaN(cpus) || cpus < 0) {
        showToast(t('请输入有效的 CPU 核数（如 1 或 1.5）'), 'error');
        return;
      }
      body.cpuLimit = Math.round(cpus * 1e9);
    }
    // 内存：留空表示不修改；填数字则转为字节
    if (uMem.trim() !== '') {
      const gb = parseFloat(uMem);
      if (isNaN(gb) || gb < 0) {
        showToast(t('请输入有效的内存大小（GB，如 2）'), 'error');
        return;
      }
      body.memLimit = Math.round(gb * 1024 * 1024 * 1024);
    }
    setUpdating(true);
    try {
      await post(`/api/containers/${containerId}/update`, body);
      showToast(t('容器配置已在线更新'));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(e?.message || t('更新失败'), 'error');
    } finally {
      setUpdating(false);
    }
  }

  return (
    <Modal
      open
      title={t('更新配置')}
      onClose={() => !updating && onClose()}
      width={520}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={updating}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={updating} onClick={saveUpdate}>
            {t('保存')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('在线更新无需重建容器，不中断运行、不改变容器 ID。留空的字段将保持现状。')}
      </div>
      <Field label={t('重启策略')} required>
        <Select value={uRestart} onChange={(e) => setURestart(e.target.value)}>
          <option value="no">{t('no（不自动重启）')}</option>
          <option value="always">{t('always（总是重启）')}</option>
          <option value="on-failure">{t('on-failure（失败时重启）')}</option>
          <option value="unless-stopped">{t('unless-stopped（除非停止，否则重启）')}</option>
        </Select>
      </Field>
      <Field label={t('CPU 限制（核数，留空不修改；填 0 取消限制）')}>
        <Input
          type="number"
          min={0}
          step="0.1"
          placeholder={t('如 1 或 1.5')}
          value={uCpu}
          onChange={(e) => setUCpu(e.target.value)}
        />
      </Field>
      <Field label={t('内存限制（GB，留空不修改；填 0 取消限制）')}>
        <Input
          type="number"
          min={0}
          step="0.5"
          placeholder={t('如 2')}
          value={uMem}
          onChange={(e) => setUMem(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
