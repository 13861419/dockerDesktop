/**
 * Compose 历史版本弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：列出保存历史，载入某版本回调给编辑器。
 * 条件渲染，挂载时拉取历史列表。
 */
import { useEffect, useState } from 'react';
import { get } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import Empty from './Empty';
import { SkeletonRows } from './Loading';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface ComposeHistoryModalProps {
  /** 项目名 */
  name: string;
  onClose: () => void;
  /** 载入某历史版本内容（写入编辑器，保存后生效） */
  onLoaded: (content: string) => void;
}

export default function ComposeHistoryModal({ name, onClose, onLoaded }: ComposeHistoryModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [histLoading, setHistLoading] = useState(false);
  const [histItems, setHistItems] = useState<Array<{ id: number; username: string; createdAt: number }>>([]);
  const [histLoadingId, setHistLoadingId] = useState<number | null>(null);

  // 挂载时拉取历史列表
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHistLoading(true);
      try {
        const data = await get<{ items: Array<{ id: number; username: string; createdAt: number }> }>(
          '/api/compose/' + encodeURIComponent(name) + '/history'
        );
        if (!cancelled) setHistItems(data?.items || []);
      } catch {
        if (!cancelled) setHistItems([]);
      } finally {
        if (!cancelled) setHistLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name]);

  /** 载入某个历史版本到编辑器（保存后生效） */
  async function loadHistoryVersion(id: number) {
    setHistLoadingId(id);
    try {
      const data = await get<{ content: string }>('/api/compose/' + encodeURIComponent(name) + '/history/' + id + '/content');
      showToast(t('已载入历史版本，保存后生效'), 'success');
      onLoaded(data?.content || '');
    } catch (e: any) {
      showToast(e?.message || t('载入历史版本失败'), 'error');
    } finally {
      setHistLoadingId(null);
    }
  }

  return (
    <Modal
      open
      title={t('历史版本 - {{editName}}', { editName: name })}
      onClose={onClose}
      width={520}
    >
      {histLoading ? (
        <SkeletonRows rows={4} />
      ) : histItems.length === 0 ? (
        <Empty title={t('暂无历史版本记录')} description={t('每次保存前的上一版内容会自动记录（保留最近 20 条），可随时载入回退')} />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('保存时间')}</th>
              <th>{t('保存人')}</th>
              <th style={{ width: 90 }}>{t('操作')}</th>
            </tr>
          </thead>
          <tbody>
            {histItems.map((h) => (
              <tr key={h.id}>
                <td className="mono">{new Date(h.createdAt).toLocaleString()}</td>
                <td>{h.username || '—'}</td>
                <td>
                  <Button variant="ghost" size="sm" onClick={() => loadHistoryVersion(h.id)} loading={histLoadingId === h.id}>
                    {t('载入')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
