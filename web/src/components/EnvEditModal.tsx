/**
 * 编辑环境变量弹窗（通过重建容器生效）
 *
 * 从容器详情页抽出（1.92.0 重构）：以当前环境变量初始化草稿，可增删改条目，
 * 提交后基于现有容器重建（其余配置保留）。条件渲染，成功后回调 onDone 刷新详情。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface EnvEditModalProps {
  containerId: string;
  /** 当前容器的环境变量（用于初始化草稿） */
  env: Record<string, string>;
  onClose: () => void;
  /** 保存成功后通知调用方刷新详情 */
  onDone: () => void;
}

export default function EnvEditModal({ containerId, env, onClose, onDone }: EnvEditModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [envDraft, setEnvDraft] = useState<Array<{ key: string; value: string }>>(() => {
    const entries = Object.entries(env || {}).map(([k, v]) => ({ key: k, value: v }));
    return entries.length ? entries : [{ key: '', value: '' }];
  });
  const [envSaving, setEnvSaving] = useState(false);

  /** 更新草稿中单个环境变量 */
  function updateEnvDraft(index: number, field: 'key' | 'value', value: string) {
    setEnvDraft((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /** 删除草稿中某个环境变量 */
  function removeEnvDraft(index: number) {
    setEnvDraft((prev) => prev.filter((_, i) => i !== index));
  }

  /** 新增一个空的环境变量条目 */
  function addEnvDraft() {
    setEnvDraft((prev) => [...prev, { key: '', value: '' }]);
  }

  /**
   * 保存环境变量：基于现有容器重建（其余配置保留），替换为新的环境变量
   */
  async function saveEnv() {
    // 过滤空键名条目，并校验重复
    const cleaned: Record<string, string> = {};
    let valid = true;
    for (const item of envDraft) {
      const k = item.key.trim();
      if (!k) continue;
      if (k in cleaned) {
        showToast(t('环境变量 {{k}} 重复定义', { k }), 'error');
        valid = false;
        break;
      }
      cleaned[k] = item.value;
    }
    if (!valid) return;
    setEnvSaving(true);
    try {
      await post(`/api/containers/${containerId}/recreate`, { env: cleaned });
      showToast(t('环境变量已更新（容器已重建）'));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('更新失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setEnvSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t('编辑环境变量')}
      onClose={() => !envSaving && onClose()}
      width={620}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={envSaving}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" size="md" loading={envSaving} onClick={saveEnv}>
            {t('保存并重建')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('修改环境变量需重新创建容器（保留镜像、端口、挂载、网络等配置）。重建会导致容器短暂中断，容器 ID 会改变。')}
      </div>
      <div className="env-modal__list">
        {envDraft.map((item, index) => (
          <div className="env-modal__row" key={index}>
            <Input
              className="env-modal__key"
              placeholder={t('变量名')}
              value={item.key}
              onChange={(e) => updateEnvDraft(index, 'key', e.target.value)}
            />
            <Input
              className="env-modal__value"
              placeholder={t('变量值')}
              value={item.value}
              onChange={(e) => updateEnvDraft(index, 'value', e.target.value)}
            />
            <Button
              variant="ghost"
              size="sm"
              className="env-modal__del"
              onClick={() => removeEnvDraft(index)}
              disabled={envSaving}
              title={t('删除这项')}
            >
              {t('删除')}
            </Button>
          </div>
        ))}
      </div>
      <div className="env-modal__add">
        <Button variant="secondary" size="sm" onClick={addEnvDraft} disabled={envSaving}>
          {t('+ 添加环境变量')}
        </Button>
      </div>
    </Modal>
  );
}
