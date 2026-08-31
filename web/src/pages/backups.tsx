/**
 * 备份恢复页面
 *
 * 展示面板内已生成的各类备份（面板数据库 / 数据卷 / Compose 配置 / 站点配置），
 * 支持下载备份文件、从备份恢复以及删除备份记录。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, del, download } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { Field, Input, Select } from '../components/Form';
import { translateNow as t } from '../i18n';
import './backups.less';

/** 备份类型 */
type BackupKind = 'database' | 'volume' | 'compose' | 'site';

/** 备份记录 */
interface BackupListItem {
  id: string;
  kind: BackupKind;
  name: string;
  source: string;
  filePath: string;
  size: number;
  status: 'ready' | 'restoring' | 'failed';
  createdAt: string;
  updatedAt: string;
  exists: boolean;
  fileSize: number;
}

/** 列表响应 */
interface BackupsResponse {
  backups: BackupListItem[];
}

/** 创建备份请求体 */
interface CreateBackupBody {
  kind: BackupKind;
  name: string;
  source: string;
}

/** 恢复接口返回结果 */
interface RestoreResult {
  ok: boolean;
  supported: boolean;
  kind: string;
  id: string;
  message: string;
}

/** 恢复接口响应 */
interface RestoreResponse {
  result: RestoreResult;
}

/** 云端目标（用于备份上传归档） */
interface CloudTarget {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  path: string;
  hasSecret: boolean;
}

/** 备份类型中文标签 */
const KIND_LABEL: Record<BackupKind, string> = {
  database: t('面板数据库'),
  volume: t('数据卷'),
  compose: t('Compose 配置'),
  site: t('站点配置'),
};

/** 状态中文标签 */
const STATUS_LABEL: Record<BackupListItem['status'], string> = {
  ready: t('正常'),
  restoring: t('恢复中'),
  failed: t('失败'),
};

/**
 * 依据备份类型生成恢复确认文案
 * @param item 待恢复的备份项
 * @returns 确认提示文案
 */
const restoreMessage = (item: { kind: string; source: string }) => {
  const base = t('恢复将覆盖现有数据，确认继续？');
  if (item.kind === 'volume') return t('{{base}}（数据卷「{{v2}}」的内容将被备份内容覆盖）', { base, v2: item.source });
  if (item.kind === 'compose') return t('将还原 Compose 项目「{{v1}}」的配置文件（不会自动启停容器）。确认？', { v1: item.source });
  if (item.kind === 'site') return t('将还原站点「{{v1}}」的 nginx 配置与证书（不会自动重启反代容器）。确认？', { v1: item.source });
  return base;
};

/**
 * 将字节数格式化为可读大小
 * @param bytes 字节数
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 格式化日期时间字符串
 * @param iso 后端返回的时间字符串
 */
function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 备份恢复页面组件
 */
export default function BackupsPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();

  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [loading, setLoading] = useState(false);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');

  // 创建备份弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateBackupBody>({ kind: 'database', name: '', source: '' });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ name?: string }>({});

  // 恢复确认
  const [restoreTarget, setRestoreTarget] = useState<BackupListItem | null>(null);
  const [restoring, setRestoring] = useState(false);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<BackupListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 云上传弹窗
  const [uploadTarget, setUploadTarget] = useState<BackupListItem | null>(null);
  const [cloudTargets, setCloudTargets] = useState<CloudTarget[]>([]);
  const [selectedCloudId, setSelectedCloudId] = useState('');
  const [uploading, setUploading] = useState(false);

  /**
   * 加载备份列表
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<BackupsResponse>('/api/backups');
      setBackups(data?.backups || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || t('加载失败'));
      showToast(e?.message || t('加载失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 打开创建备份弹窗
   */
  const openCreate = useCallback(() => {
    if (!canManage) {
      showToast(t('仅管理员可创建备份'), 'error');
      return;
    }
    setForm({ kind: 'database', name: '', source: '' });
    setErrors({});
    setCreateOpen(true);
  }, [canManage, showToast]);

  /**
   * 提交创建备份
   */
  const handleCreate = useCallback(async () => {
    if (!canManage) {
      showToast(t('仅管理员可创建备份'), 'error');
      setCreateOpen(false);
      return;
    }
    const err: { name?: string } = {};
    if (!form.name.trim()) err.name = t('请输入名称');
    setErrors(err);
    if (Object.keys(err).length) return;

    setSaving(true);
    try {
      await post('/api/backups', {
        kind: form.kind,
        name: form.name.trim(),
        source: form.source.trim(),
      });
      showToast(t('备份已创建'));
      setCreateOpen(false);
      load();
    } catch (e: any) {
      showToast(e?.message || t('创建失败'), 'error');
    } finally {
      setSaving(false);
    }
  }, [canManage, form, load, showToast]);

  /**
   * 下载备份文件
   * @param item 备份记录
   */
  const handleDownload = useCallback(async (item: BackupListItem) => {
    try {
      await download(`/api/backups/${item.id}/download`, 'backup.bin');
      showToast(t('开始下载'));
    } catch (e: any) {
      showToast(e?.message || t('下载失败'), 'error');
    }
  }, [showToast]);

  /**
   * 确认恢复备份
   */
  const handleRestore = useCallback(async () => {
    if (!restoreTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可恢复备份'), 'error');
      setRestoreTarget(null);
      return;
    }
    setRestoring(true);
    try {
      const data = await post<RestoreResponse>(`/api/backups/${restoreTarget.id}/restore`);
      const result = data?.result;
      if (result?.ok) {
        showToast(result.message || t('恢复成功'));
      } else {
        showToast(result?.message || t('恢复失败'), 'error');
      }
      setRestoreTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || t('恢复失败'), 'error');
    } finally {
      setRestoring(false);
    }
  }, [canManage, restoreTarget, load, showToast]);

  /**
   * 确认删除备份
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可删除备份'), 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/backups/${deleteTarget.id}`);
      showToast(t('备份已删除'));
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || t('删除失败'), 'error');
    } finally {
      setDeleting(false);
    }
  }, [canManage, deleteTarget, load, showToast]);

  /**
   * 打开"上传到云端"弹窗并加载可用云端目标
   * @param item 待上传的备份记录
   */
  const openUpload = useCallback(
    async (item: BackupListItem) => {
      if (!canManage) {
        showToast(t('仅管理员可将备份上传到云端'), 'error');
        return;
      }
      setSelectedCloudId('');
      setUploadTarget(item);
      try {
        const resp = await get<{ targets: CloudTarget[] }>('/api/cloud/targets');
        const list = (resp?.targets || []).filter((t) => t.hasSecret);
        setCloudTargets(list);
        if (list.length === 1) setSelectedCloudId(list[0].id);
      } catch {
        setCloudTargets([]);
      }
    },
    [canManage, showToast],
  );

  /**
   * 确认将备份上传到所选云端目标
   */
  const confirmUploadCloud = useCallback(async () => {
    if (!uploadTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可将备份上传到云端'), 'error');
      setUploadTarget(null);
      return;
    }
    if (!selectedCloudId) {
      showToast(t('请选择云端目标'), 'error');
      return;
    }
    setUploading(true);
    try {
      const resp = await post<{ ok: boolean; target: string; size: number; filename: string }>(
        `/api/backups/${uploadTarget.id}/upload-to-cloud`,
        { targetId: selectedCloudId },
      );
      showToast(t('已上传到云端「{{v1}}」', { v1: resp?.target }));
      setUploadTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || t('上传失败'), 'error');
    } finally {
      setUploading(false);
    }
  }, [canManage, uploadTarget, selectedCloudId, load, showToast]);

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">{t('备份恢复')}</h1>
        <p className="page__desc">{t('管理面板数据库、数据卷、Compose 与站点配置的备份与恢复')}</p>
      </div>

      <div className="toolbar">
        <Button onClick={openCreate} disabled={!canManage}>{t('+ 创建备份')}</Button>
        <Button variant="ghost" onClick={load}>{t('刷新')}</Button>
      </div>

      <Card>
        {loading ? (
          <SkeletonRows rows={4} />
        ) : loadError ? (
          <Empty
            kind="error"
            title={t('加载备份列表失败')}
            description={loadError || t('请稍后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={load}>
                {t('重试')}
              </Button>
            }
          />
        ) : backups.length === 0 ? (
          <Empty title={t('暂无备份记录')} description={t('点击右上角「创建备份」生成第一条备份。')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '18%' }}>{t('名称')}</th>
                <th style={{ width: '10%' }}>{t('类型')}</th>
                <th style={{ width: '18%' }}>{t('来源')}</th>
                <th style={{ width: '10%' }}>{t('大小')}</th>
                <th style={{ width: '10%' }}>{t('状态')}</th>
                <th style={{ width: '16%' }}>{t('创建时间')}</th>
                <th style={{ width: '18%' }}>{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.name}</strong>
                    {!b.exists && (
                      <div className="bk-missing">{t('文件缺失，仅保留记录')}</div>
                    )}
                  </td>
                  <td><span className="bk-kind">{KIND_LABEL[b.kind]}</span></td>
                  <td className="bk-source">{b.source || '—'}</td>
                  <td>{b.exists ? formatBytes(b.fileSize) : '—'}</td>
                  <td>
                    <span className={`bk-status bk-status--${b.status}`}>
                      {STATUS_LABEL[b.status]}
                    </span>
                  </td>
                  <td className="bk-time">{formatDate(b.createdAt)}</td>
                  <td>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      <Button variant="ghost" size="sm" disabled={!b.exists} onClick={() => handleDownload(b)}>
                        {t('下载')}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={!b.exists || !canManage} onClick={() => openUpload(b)}>{t('上传云端')}</Button>
                      <Button variant="ghost" size="sm" disabled={!b.exists} onClick={() => setRestoreTarget(b)}>{t('恢复')}</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(b)} disabled={!canManage}>{t('删除')}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 创建备份弹窗 */}
      <Modal
        open={createOpen}
        title={t('创建备份')}
        onClose={() => setCreateOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>{t('取消')}</Button>
            <Button loading={saving} onClick={handleCreate} disabled={!canManage}>{t('创建')}</Button>
          </div>
        }
      >
        <Field label={t('类型')}>
          <Select
            value={form.kind}
            onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as BackupKind }))}
          >
            <option value="database">{t('面板数据库')}</option>
            <option value="volume">{t('数据卷')}</option>
            <option value="compose">{t('Compose 配置')}</option>
            <option value="site">{t('站点配置')}</option>
          </Select>
        </Field>
        <Field label={t('名称')} required>
          <Input
            value={form.name}
            placeholder={t('如：面板数据库全量备份')}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          {errors.name && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 12, marginTop: 4 }}>{errors.name}</div>}
        </Field>
        <Field label={t('来源（可选）')}>
          <Input
            value={form.source}
            placeholder={t('数据卷名 / 应用标识等')}
            onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
          />
        </Field>
      </Modal>

      {/* 恢复确认 */}
      <ConfirmDialog
        open={!!restoreTarget}
        title={t('恢复备份')}
        message={restoreTarget ? `${restoreMessage(restoreTarget)}（${restoreTarget.name || ''}）` : ''}
        confirmText={t('恢复')}
        danger
        loading={restoring}
        onConfirm={handleRestore}
        onCancel={() => setRestoreTarget(null)}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('删除备份')}
        message={t('确定删除备份「{{v1}}」吗？删除后不可恢复。', { v1: deleteTarget?.name || '' })}
        confirmText={t('删除')}
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 上传到云端弹窗 */}
      <Modal
        open={!!uploadTarget}
        title={t('上传备份到云端：{{v1}}', { v1: uploadTarget?.name || '' })}
        onClose={() => setUploadTarget(null)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setUploadTarget(null)}>{t('取消')}</Button>
            <Button loading={uploading} onClick={confirmUploadCloud} disabled={!canManage || !selectedCloudId}>{t('上传')}</Button>
          </div>
        }
      >
        {cloudTargets.length === 0 ? (
          <Empty
            title={t('暂无可用的云端目标')}
            description={t('请先到「云端备份」页面配置并测试一个 S3 / OSS / WebDAV 目标。')}
          />
        ) : (
          <Field label={t('选择云端目标')}>
            <Select value={selectedCloudId} onChange={(e) => setSelectedCloudId(e.target.value)}>
              <option value="">{t('请选择目标')}</option>
              {cloudTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}（{t.type.toUpperCase()} · {t.endpoint}）
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Modal>
    </div>
  );
}
