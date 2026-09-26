/**
 * 容器回收站弹窗
 *
 * 列出被删除容器的配置快照，支持按原配置一键重建（可改名）、
 * 删除单条记录与清空。恢复成功后回调 onDone 通知容器列表刷新。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../api/client';
import { canOperate } from '../api/auth';
import Button from './Button';
import Modal from './Modal';
import { Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface RecycleItem {
  id: number;
  name: string;
  image: string | null;
  deleted_by: string | null;
  deleted_at: number;
}

interface RecycleBinModalProps {
  open: boolean;
  onClose: () => void;
  /** 恢复成功后通知容器列表刷新 */
  onDone: () => void;
}

export default function RecycleBinModal({ open, onClose, onDone }: RecycleBinModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [items, setItems] = useState<RecycleItem[]>([]);
  const [loading, setLoading] = useState(false);
  /** 正在恢复的记录（id + 可编辑的容器名） */
  const [restoring, setRestoring] = useState<{ id: number; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 清空按钮两段式确认（第二次点击才执行） */
  const [purgeArmed, setPurgeArmed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await get<RecycleItem[]>('/api/recycle'));
    } catch (e: any) {
      showToast(t('加载回收站失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setLoading(false);
    }
  }, [t, showToast]);

  useEffect(() => {
    if (open) {
      load();
      setRestoring(null);
      setPurgeArmed(false);
    }
  }, [open, load]);

  /** 恢复容器：按快照重建（默认启动） */
  async function confirmRestore() {
    if (!restoring) return;
    if (!canOperate()) {
      showToast(t('仅管理员或运维人员可恢复容器'), 'error');
      return;
    }
    const name = restoring.name.trim();
    if (!name) {
      showToast(t('容器名称不能为空'), 'error');
      return;
    }
    setBusy(true);
    try {
      await post(`/api/recycle/${restoring.id}/restore`, { name });
      showToast(t('容器已恢复并启动'));
      setRestoring(null);
      await load();
      onDone();
    } catch (e: any) {
      showToast(t('恢复失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 删除单条记录 */
  async function removeItem(id: number) {
    if (!canOperate()) {
      showToast(t('仅管理员或运维人员可操作回收站'), 'error');
      return;
    }
    setBusy(true);
    try {
      await del(`/api/recycle/${id}`);
      showToast(t('记录已删除'));
      await load();
    } catch (e: any) {
      showToast(t('删除失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 清空回收站（两段式确认） */
  async function purgeAll() {
    if (!purgeArmed) {
      setPurgeArmed(true);
      return;
    }
    if (!canOperate()) {
      showToast(t('仅管理员或运维人员可操作回收站'), 'error');
      return;
    }
    setBusy(true);
    try {
      await post('/api/recycle/purge', {});
      showToast(t('回收站已清空'));
      setPurgeArmed(false);
      await load();
    } catch (e: any) {
      showToast(t('清空失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t('容器回收站')}
      onClose={onClose}
      width={720}
      footer={
        <div className="create-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose}>
            {t('关闭')}
          </Button>
          <Button variant="danger" size="md" onClick={purgeAll} disabled={busy || items.length === 0}>
            {purgeArmed ? t('再点一次确认清空') : t('清空回收站')}
          </Button>
        </div>
      }
    >
      <div className="recycle-bin">
        <p className="recycle-bin__hint">{t('经面板删除的容器会自动保存配置快照（最多保留 100 条），可按原配置一键重建。')}</p>
        {loading ? (
          <div className="recycle-bin__empty">{t('加载中…')}</div>
        ) : items.length === 0 ? (
          <div className="recycle-bin__empty">{t('回收站为空')}</div>
        ) : (
          <div className="recycle-bin__list">
            {items.map((item) => (
              <div key={item.id} className="recycle-bin__row">
                <div className="recycle-bin__info">
                  <div className="recycle-bin__name" title={item.name}>
                    {item.name}
                  </div>
                  <div className="recycle-bin__meta" title={item.image || ''}>
                    {item.image || t('未知镜像')} · {t('由 {{user}} 删除', { user: item.deleted_by || '-' })} ·{' '}
                    {new Date(item.deleted_at).toLocaleString()}
                  </div>
                </div>
                <div className="recycle-bin__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRestoring({ id: item.id, name: item.name })}
                  >
                    {t('恢复')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => removeItem(item.id)}>
                    {t('删除记录')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {restoring && (
          <div className="recycle-bin__restore">
            <div className="recycle-bin__restore-title">{t('按快照重建容器')}</div>
            <Input
              placeholder={t('容器名称')}
              value={restoring.name}
              onChange={(e) => setRestoring({ ...restoring, name: e.target.value })}
              disabled={busy}
            />
            <div className="recycle-bin__restore-actions">
              <Button variant="primary" size="sm" loading={busy} onClick={confirmRestore}>
                {t('确认恢复')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRestoring(null)} disabled={busy}>
                {t('取消')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
