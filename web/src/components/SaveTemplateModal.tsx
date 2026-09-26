/**
 * 保存为容器模板弹窗
 *
 * 从容器详情页抽出（1.92.0 重构）：挂载时拉取当前容器导出配置预填名称与描述，
 * 提交后调用 POST /api/templates 保存完整配置。条件渲染。
 */
import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface SaveTemplateModalProps {
  containerId: string;
  /** 源容器名（用于预填模板名称与提示） */
  containerName: string;
  onClose: () => void;
}

export default function SaveTemplateModal({ containerId, containerName, onClose }: SaveTemplateModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [saveTplName, setSaveTplName] = useState('');
  const [saveTplDesc, setSaveTplDesc] = useState('');
  const [saveTplSaving, setSaveTplSaving] = useState(false);

  // 挂载时拉取当前容器导出配置，预填模板名称（默认容器名）与描述
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await get<any>(`/api/containers/${containerId}/config`);
        const cfg = res?.config || res || {};
        if (!cancelled) {
          setSaveTplName(cfg?.name || containerName || '');
          setSaveTplDesc(cfg?.description || '');
        }
      } catch (e: any) {
        showToast(t('获取容器配置失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 提交保存当前容器配置为模板（调用 POST /api/templates）
   */
  async function submitSaveTemplate() {
    // 模板名称必填校验
    if (!saveTplName.trim()) {
      showToast(t('模板名称不能为空'), 'error');
      return;
    }
    setSaveTplSaving(true);
    try {
      const res = await get<any>(`/api/containers/${containerId}/config`);
      const cfg = res?.config || res || {};
      await post('/api/templates', {
        name: saveTplName.trim(),
        description: saveTplDesc.trim(),
        image: cfg?.image || '',
        config: cfg,
      });
      showToast(t('已保存为模板'));
      onClose();
    } catch (e: any) {
      showToast(t('保存模板失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setSaveTplSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t('保存为容器模板')}
      onClose={() => !saveTplSaving && onClose()}
      width={520}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={saveTplSaving}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={saveTplSaving} onClick={submitSaveTemplate}>
            {t('保存')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('将当前容器「{{name}}」的完整配置保存为模板，日后可在容器页一键按模板创建。', { name: containerName })}
      </div>
      <Field label={t('模板名称')} required>
        <Input
          placeholder={t('模板名称')}
          value={saveTplName}
          onChange={(e) => setSaveTplName(e.target.value)}
          autoFocus
          disabled={saveTplSaving}
        />
      </Field>
      <Field label={t('描述（可选）')}>
        <Input
          placeholder={t('模板用途说明')}
          value={saveTplDesc}
          onChange={(e) => setSaveTplDesc(e.target.value)}
          disabled={saveTplSaving}
        />
      </Field>
    </Modal>
  );
}
