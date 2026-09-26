/**
 * 编辑挂载卷弹窗（通过重建容器生效）
 *
 * 从容器详情页抽出（1.92.0 重构）：以当前挂载卷初始化草稿（来源 / 容器内路径 / 读写），
 * 提交后组装 Binds 数组并重建容器。条件渲染，成功后回调 onDone 刷新详情。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface MountEditModalProps {
  containerId: string;
  /** 当前容器的挂载卷（用于初始化草稿） */
  mounts: Array<{ source?: string; destination?: string; rw?: boolean }>;
  onClose: () => void;
  /** 保存成功后通知调用方刷新详情 */
  onDone: () => void;
}

export default function MountEditModal({ containerId, mounts, onClose, onDone }: MountEditModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [mountDraft, setMountDraft] = useState<Array<{ source: string; destination: string; rw: boolean }>>(() => {
    const entries = (mounts || []).map((m) => ({
      source: m.source || '',
      destination: m.destination || '',
      rw: m.rw !== false,
    }));
    return entries.length ? entries : [{ source: '', destination: '', rw: true }];
  });
  const [mountSaving, setMountSaving] = useState(false);

  /** 更新挂载卷草稿中单个条目 */
  function updateMountDraft(index: number, field: 'source' | 'destination' | 'rw', value: any) {
    setMountDraft((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /** 删除挂载卷草稿中某个条目 */
  function removeMountDraft(index: number) {
    setMountDraft((prev) => prev.filter((_, i) => i !== index));
  }

  /** 新增一个挂载卷条目 */
  function addMountDraft() {
    setMountDraft((prev) => [...prev, { source: '', destination: '', rw: true }]);
  }

  /**
   * 保存挂载卷：组装 "source:destination[:ro]" 数组并重建容器
   */
  async function saveMounts() {
    // 过滤缺项的挂载，并组装 Binds 数组
    const binds: string[] = [];
    for (const item of mountDraft) {
      const source = item.source.trim();
      const destination = item.destination.trim();
      if (!source || !destination) continue;
      binds.push(`${source}:${destination}${item.rw ? '' : ':ro'}`);
    }
    setMountSaving(true);
    try {
      await post(`/api/containers/${containerId}/recreate`, { binds });
      showToast(t('挂载卷已更新（容器已重建）'));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('更新失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setMountSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t('编辑挂载卷')}
      onClose={() => !mountSaving && onClose()}
      width={640}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={mountSaving}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={mountSaving} onClick={saveMounts}>
            {t('保存并重建')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('修改挂载卷需重新创建容器（保留镜像、端口、网络、环境变量等配置）。「来源」为宿主机路径或已存在的卷名，「目标」为容器内路径。')}
      </div>
      <div className="mount-modal__head">
        <span className="mount-modal__col-source">{t('来源')}</span>
        <span className="mount-modal__col-dst">{t('容器内路径')}</span>
        <span className="mount-modal__col-rw">{t('读写')}</span>
        <span className="mount-modal__col-op" />
      </div>
      <div className="mount-modal__list">
        {mountDraft.map((item, index) => (
          <div className="mount-modal__row" key={index}>
            <Input
              className="mount-modal__col-source"
              placeholder={t('宿主机路径或卷名')}
              value={item.source}
              onChange={(e) => updateMountDraft(index, 'source', e.target.value)}
            />
            <Input
              className="mount-modal__col-dst"
              placeholder={t('/容器/路径')}
              value={item.destination}
              onChange={(e) => updateMountDraft(index, 'destination', e.target.value)}
            />
            <label className="mount-modal__rw">
              <input
                type="checkbox"
                checked={item.rw}
                onChange={(e) => updateMountDraft(index, 'rw', e.target.checked)}
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="mount-modal__col-op"
              onClick={() => removeMountDraft(index)}
              disabled={mountSaving}
              title={t('删除这项挂载')}
            >
              {t('删除')}
            </Button>
          </div>
        ))}
      </div>
      <div className="env-modal__add">
        <Button variant="secondary" size="sm" onClick={addMountDraft} disabled={mountSaving}>
          {t('+ 添加挂载')}
        </Button>
      </div>
    </Modal>
  );
}
