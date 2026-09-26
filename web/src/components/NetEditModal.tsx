/**
 * 网络编辑弹窗（通过重建容器生效）
 *
 * 从容器详情页抽出（1.92.0 重构）：挂载时拉取可用网络列表（内置 bridge / host / none），
 * 提交后基于现有容器重建并切换到所选网络。条件渲染，成功后回调 onDone 刷新详情。
 */
import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Select } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface NetEditModalProps {
  containerId: string;
  /** 当前网络名（用于初始化选择） */
  current: string;
  onClose: () => void;
  /** 保存成功后通知调用方刷新详情 */
  onDone: () => void;
}

export default function NetEditModal({ containerId, current, onClose, onDone }: NetEditModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [netDraft, setNetDraft] = useState(current);
  const [netOptions, setNetOptions] = useState<Array<{ Name: string; Id: string; Driver: string }>>([]);
  const [netSaving, setNetSaving] = useState(false);

  // 挂载时加载可用网络列表（失败不阻塞，仍可选内置网络）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await get<Array<{ Name: string; Id: string; Driver: string }>>('/api/networks');
        if (!cancelled) setNetOptions(list || []);
      } catch (e: any) {
        showToast(t('获取网络列表失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
        if (!cancelled) setNetOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 保存网络：基于现有容器重建并切换到所选网络
   */
  async function saveNet() {
    if (!netDraft) {
      showToast(t('请选择网络'), 'error');
      return;
    }
    setNetSaving(true);
    try {
      await post(`/api/containers/${containerId}/recreate`, { network: netDraft });
      showToast(t('网络已更新（容器已重建）'));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('更新失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setNetSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t('选择网络')}
      onClose={() => !netSaving && onClose()}
      width={520}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={netSaving}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={netSaving} onClick={saveNet}>
            {t('保存并重建')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('切换网络需重新创建容器（保留镜像、端口、挂载、环境变量等配置）。重建会导致容器短暂中断，容器 ID 会改变。')}
      </div>
      <Field label={t('网络')} required>
        <Select value={netDraft} onChange={(e) => setNetDraft(e.target.value)}>
          <option value="bridge">{t('bridge（默认桥接）')}</option>
          <option value="host">{t('host（使用宿主机网络）')}</option>
          <option value="none">{t('none（禁用网络）')}</option>
          {netOptions.map((n) => (
            <option key={n.Name} value={n.Name}>
              {n.Name}（{n.Driver}）
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}
