/**
 * SSL 证书页（/certs）
 *
 * Let’s Encrypt（ACME）自动签发与管理：域名 http-01 验证 → 证书落盘 → 到期前自动续期。
 */
import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import { Field, Input } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { translateNow as t } from '../i18n';
import './certs.less';

/** 证书条目（/api/certs 返回结构） */
interface CertItem {
  id: string;
  domains: string[];
  source: string;
  issuedAt: number;
  expiresAt: number;
  certPath: string;
  keyPath: string;
  certFileReady: boolean;
}

/** 挑战服务状态 */
interface CertsStatus {
  challengeServer: { listening: boolean; port: number; error: string };
  directoryUrl: string;
}

/** 剩余天数 → 展示文案 */
function expiryInfo(expiresAt: number): { text: string; level: 'ok' | 'warn' | 'danger' } {
  const days = Math.floor((expiresAt - Date.now()) / (24 * 3600 * 1000));
  if (days < 0) return { text: t('已过期'), level: 'danger' };
  if (days < 30) return { text: t('{{n}} 天后续期', { n: days }), level: 'warn' };
  return { text: t('剩余 {{n}} 天', { n: days }), level: 'ok' };
}

/**
 * SSL 证书页面组件
 */
export default function CertsPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();
  const [certs, setCerts] = useState<CertItem[]>([]);
  const [status, setStatus] = useState<CertsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  // 签发弹窗
  const [issueOpen, setIssueOpen] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [issuing, setIssuing] = useState(false);
  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<CertItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchCerts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<{ certs: CertItem[] }>('/api/certs');
      setCerts(data?.certs || []);
      setStatus(await get<CertsStatus>('/api/certs/status'));
    } catch (e: any) {
      showToast(e?.message || t('加载证书列表失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchCerts();
  }, [fetchCerts, refreshKey]);

  /** 提交签发 */
  const handleIssue = useCallback(async () => {
    setIssuing(true);
    try {
      await post('/api/certs/issue', { domains: domainInput });
      showToast(t('证书签发成功'), 'success');
      setIssueOpen(false);
      setDomainInput('');
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('签发失败'), 'error');
    } finally {
      setIssuing(false);
    }
  }, [domainInput, showToast]);

  /** 手动触发续期巡检 */
  const handleRenew = useCallback(async () => {
    try {
      const data = await post<{ results: Array<{ domain: string; ok: boolean; detail: string }> }>('/api/certs/renew', {});
      const n = data?.results?.length || 0;
      showToast(n === 0 ? t('暂无需要续期的证书') : t('续期巡检完成，{{n}} 张待处理', { n }), 'success');
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('续期失败'), 'error');
    }
  }, [showToast]);

  /** 删除证书 */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await del(`/api/certs/${deleteTarget.id}`);
      showToast(t('证书已删除'), 'success');
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('删除失败'), 'error');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, showToast]);

  return (
    <Card
      title={t('SSL 证书')}
      extra={
        <div className="certs-actions">
          {canManage && (
            <>
              <Button variant="secondary" size="sm" onClick={handleRenew}>
                {t('续期巡检')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => setIssueOpen(true)}>
                {t('签发证书')}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
            {t('刷新')}
          </Button>
        </div>
      }
    >
      <div className="certs-status">
        {t('通过 Let’s Encrypt 自动签发与续期证书（http-01 验证，需 80 端口可达）')}
      </div>
      <div className={`certs-status ${status?.challengeServer?.listening ? 'is-ok' : 'is-warn'}`}>
        {status?.challengeServer?.listening
          ? t('http-01 验证服务运行中（端口 {{n}}）', { n: status.challengeServer.port })
          : t('http-01 验证服务未就绪（{{e}}）——签发时需 80 端口未被占用且域名解析指向本机', {
              e: status?.challengeServer?.error || '未监听',
            })}
      </div>

      {loading ? (
        <SkeletonRows rows={4} />
      ) : certs.length === 0 ? (
        <Empty kind="empty" title={t('暂无证书')} description={t('点击「签发证书」为你的域名申请一张免费的 Let’s Encrypt 证书。')} />
      ) : (
        <table className="certs-table">
          <thead>
            <tr>
              <th>{t('主域名')}</th>
              <th>{t('全部域名')}</th>
              <th>{t('到期情况')}</th>
              <th>{t('签发时间')}</th>
              <th>{t('操作')}</th>
            </tr>
          </thead>
          <tbody>
            {certs.map((c) => {
              const info = expiryInfo(c.expiresAt);
              return (
                <tr key={c.id}>
                  <td className="certs-table__domain">{c.id}</td>
                  <td title={c.domains.join(', ')}>{c.domains.join(', ')}</td>
                  <td>
                    <span className={`certs-badge certs-badge--${info.level}`}>{info.text}</span>
                    <div className="certs-table__path" title={c.certPath}>
                      {c.certPath}
                    </div>
                  </td>
                  <td>{new Date(c.issuedAt).toLocaleString()}</td>
                  <td>
                    {canManage && (
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(c)}>
                        {t('删除')}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* 签发弹窗 */}
      <Modal
        open={issueOpen}
        title={t('签发 SSL 证书')}
        onClose={() => setIssueOpen(false)}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setIssueOpen(false)} disabled={issuing}>
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" onClick={handleIssue} disabled={issuing}>
              {issuing ? t('签发中…') : t('开始签发')}
            </Button>
          </>
        }
      >
        <Field
          label={t('域名')}
          hint={t('多个域名用逗号分隔，首个为主域名（不支持通配符 *.example.com）')}
        >
          <Input
            value={domainInput}
            placeholder="example.com, www.example.com"
            onChange={(ev) => setDomainInput(ev.target.value)}
          />
        </Field>
        <div className="certs-tip">
          {t('签发过程：面板在本机 80 端口应答 Let’s Encrypt 的 http-01 校验（约 10~30 秒）。证书与私钥将写入面板数据目录 certs/ 下，可直接在「站点反代」中引用。')}
        </div>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('删除证书')}
        message={t('确定要删除 "{{v1}}" 的证书吗？证书记录与本地文件将一并删除。', { v1: deleteTarget?.id || '' })}
        confirmText={t('删除')}
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
