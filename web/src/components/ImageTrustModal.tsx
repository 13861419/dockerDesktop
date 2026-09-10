/**
 * 镜像信任锁定弹窗（1.34.0）
 *
 * 信任锁定 = 为镜像仓库记录期望的 RepoDigest；运行中容器若使用了
 * 与锁定摘要不一致的同仓库镜像（供应链漂移/被篡改替换），会在此列表中标红提示。
 */
import { useCallback, useEffect, useState } from 'react';
import { del, get, post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { useToast } from './Toast';
import { translateNow as t } from '../i18n';

interface TrustItem {
  container: string;
  image: string;
  repo: string;
  pinned: boolean;
  ok: boolean | null;
  digest: string;
  expected: string;
}

interface TrustResponse {
  pins: Array<{ repo: string; expected_digest: string; updated_at: number }>;
  items: TrustItem[];
}

export default function ImageTrustModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useToast();
  const [data, setData] = useState<TrustResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinRepo, setPinRepo] = useState('');
  const [pinDigest, setPinDigest] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await get<TrustResponse>('/api/images/trust'));
    } catch (e) {
      showToast((e as Error)?.message || t('加载信任状态失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /** 锁定：从运行镜像中取该仓库当前摘要作为期望值 */
  const pin = async () => {
    if (!pinRepo.trim() || !pinDigest.trim()) {
      showToast(t('请填写仓库与摘要'), 'error');
      return;
    }
    try {
      await post('/api/images/trust', { repo: pinRepo.trim(), digest: pinDigest.trim() });
      showToast(t('已锁定'), 'success');
      setPinRepo('');
      setPinDigest('');
      await load();
    } catch (e) {
      showToast((e as Error)?.message || t('锁定失败'), 'error');
    }
  };

  const unpin = async (repo: string) => {
    try {
      await del(`/api/images/trust/${encodeURIComponent(repo)}`);
      showToast(t('已解除锁定'), 'success');
      await load();
    } catch (e) {
      showToast((e as Error)?.message || t('操作失败'), 'error');
    }
  };

  /** 取某仓库当前运行镜像的完整摘要（填充锁定表单） */
  const fillDigest = (item: TrustItem) => {
    setPinRepo(item.repo);
    setPinDigest(item.digest);
  };

  return (
    <Modal open={open} title={t('镜像信任锁定')} onClose={onClose} width={900}>
      <p style={{ fontSize: 12, opacity: 0.65, margin: '0 0 10px' }}>
        {t('为镜像仓库锁定期望的 sha256 摘要；运行中容器的镜像摘要与锁定值不一致时将标红提示（供应链漂移检测）。')}
      </p>
      {loading ? (
        <p>{t('加载中…')}</p>
      ) : (
        <>
          {data && data.items.length > 0 ? (
            <div style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('容器')}</th>
                    <th>{t('镜像')}</th>
                    <th>{t('信任状态')}</th>
                    <th className="col-actions">{t('操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((it, i) => (
                    <tr key={i}>
                      <td>{it.container}</td>
                      <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={it.image}>
                        {it.image}
                      </td>
                      <td>
                        {!it.pinned ? (
                          <span className="badge badge--muted">{t('未锁定')}</span>
                        ) : it.ok ? (
                          <span className="badge badge--running">{t('摘要一致')}</span>
                        ) : (
                          <span className="badge badge--danger" title={`${t('期望')} ${it.expected}`}>
                            {t('摘要漂移')}
                          </span>
                        )}
                      </td>
                      <td className="col-actions">
                        <Button variant="ghost" size="sm" onClick={() => fillDigest(it)}>
                          {it.pinned ? t('更新锁定') : t('锁定摘要')}
                        </Button>
                        {it.pinned && (
                          <Button variant="ghost" size="sm" onClick={() => void unpin(it.repo)}>
                            {t('解除')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ fontSize: 13, opacity: 0.7 }}>{t('暂无运行中的容器')}</p>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>{t('仓库名（如 nginx / redis）')}</div>
              <input className="input" value={pinRepo} onChange={(e) => setPinRepo(e.target.value)} placeholder="nginx" />
            </div>
            <div style={{ flex: 2, minWidth: 260 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>sha256 {t('摘要')}</div>
              <input
                className="input"
                value={pinDigest}
                onChange={(e) => setPinDigest(e.target.value)}
                placeholder="sha256:abc123…"
                style={{ fontFamily: 'JetBrains Mono, Consolas, monospace' }}
              />
            </div>
            <Button variant="primary" onClick={() => void pin()}>
              {t('锁定')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
