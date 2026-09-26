/**
 * Compose 查看配置弹窗（规范化配置只读展示）
 *
 * 从 Compose 页抽出（1.92.0 重构）：挂载时拉取项目规范化配置。
 * 条件渲染。
 */
import { useEffect, useState } from 'react';
import { get } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface ComposeConfigModalProps {
  /** 项目名 */
  name: string;
  onClose: () => void;
}

export default function ComposeConfigModal({ name, onClose }: ComposeConfigModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [configContent, setConfigContent] = useState('');

  // 挂载时拉取规范化配置
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await get<any>('/api/compose/' + encodeURIComponent(name) + '/config');
        const content =
          typeof res === 'string'
            ? res
            : res?.content ||
              res?.config ||
              JSON.stringify(res, null, 2);
        if (!cancelled) setConfigContent(content || t('（无配置文件）'));
      } catch (e: any) {
        showToast(e?.message || t('获取配置失败'), 'error');
        if (!cancelled) onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  return (
    <Modal
      open
      title={t('{{configTitle}} - 配置', { configTitle: name + ' · ' + t('规范化配置') })}
      onClose={onClose}
      width={720}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('关闭')}
        </Button>
      }
    >
      <pre className="config-viewer">{configContent}</pre>
    </Modal>
  );
}
