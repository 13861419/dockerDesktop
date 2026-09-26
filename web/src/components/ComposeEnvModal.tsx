/**
 * Compose 环境变量（.env）编辑弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：挂载时读取项目 .env 内容，
 * 保存后提示需重新「启动」应用。条件渲染。
 */
import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface ComposeEnvModalProps {
  /** 项目名 */
  name: string;
  onClose: () => void;
}

export default function ComposeEnvModal({ name, onClose }: ComposeEnvModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [envLoading, setEnvLoading] = useState(false);
  const [envContent, setEnvContent] = useState('');
  const [envExists, setEnvExists] = useState(false);
  const [envSaving, setEnvSaving] = useState(false);

  // 挂载时读取 .env 内容
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setEnvLoading(true);
      try {
        const data = await get<{ content: string; exists: boolean }>('/api/compose/' + encodeURIComponent(name) + '/env');
        if (!cancelled) {
          setEnvContent(data?.content || '');
          setEnvExists(!!data?.exists);
        }
      } catch (e: any) {
        showToast(e?.message || t('读取环境变量失败'), 'error');
        if (!cancelled) onClose();
      } finally {
        if (!cancelled) setEnvLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  /** 保存 .env（保存后需再次「启动」应用） */
  async function saveEnv() {
    setEnvSaving(true);
    try {
      await post('/api/compose/' + encodeURIComponent(name) + '/env', { content: envContent });
      showToast(t('环境变量已保存，重新「启动」项目后生效'), 'success');
      onClose();
    } catch (e: any) {
      showToast(e?.message || t('保存失败'), 'error');
    } finally {
      setEnvSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t('环境变量 - {{envName}}', { envName: name })}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={envSaving}>
            {t('取消')}
          </Button>
          <Button onClick={saveEnv} loading={envSaving}>
            {t('保存')}
          </Button>
        </>
      }
    >
      {envLoading ? (
        <div className="log-empty">{t('正在加载…')}</div>
      ) : (
        <>
          {!envExists && (
            <div className="name-sub" style={{ marginBottom: 8 }}>
              {t('项目目录下还没有 .env 文件，保存后将创建。')}
            </div>
          )}
          <textarea
            className="compose-env-textarea"
            value={envContent}
            onChange={(e) => setEnvContent(e.target.value)}
            rows={16}
            spellCheck={false}
            placeholder={t('KEY=value 格式，每行一条，如：') + '\nDATABASE_URL=postgres://postgres:pass@postgres:5432/postgres'}
          />
          <div className="name-sub" style={{ marginTop: 6 }}>
            {t('提示：保存后需重新「启动」项目才会应用环境变量')}
          </div>
        </>
      )}
    </Modal>
  );
}
