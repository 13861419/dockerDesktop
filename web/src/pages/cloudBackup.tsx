/**
 * 云端备份页面
 *
 * 管理 S3 / OSS / WebDAV 云端存储目标，并对指定目标上传备份文件。
 * 上传使用原生 fetch（application/octet-stream）+ 鉴权头，复用 express.raw 后端接口。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, del } from '../api/client';
import { getToken, isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { Field, Input, Select } from '../components/Form';
import { translateNow as t } from '../i18n';
import './cloudBackup.less';

/** 云目标类型 */
type CloudType = 's3' | 'oss' | 'webdav';

/** 云端目标 */
interface CloudTarget {
  id: string;
  name: string;
  type: CloudType;
  endpoint: string;
  bucket: string;
  path: string;
  accessKey: string;
  region: string;
  hasSecret: boolean;
}

/** 列表响应 */
interface TargetsResponse {
  targets: CloudTarget[];
}

/** 表单校验错误 */
interface FormError {
  name?: string;
  endpoint?: string;
}

const TYPE_LABEL: Record<CloudType, string> = {
  s3: 'S3',
  oss: t('阿里 OSS'),
  webdav: 'WebDAV',
};

/**
 * 云端备份页面组件
 */
export default function CloudBackupPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();
  const uploadRef = useRef<HTMLInputElement>(null);

  const [targets, setTargets] = useState<CloudTarget[]>([]);
  const [loading, setLoading] = useState(false);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');

  // 新增/编辑弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CloudTarget | null>(null);
  const [form, setForm] = useState({
    type: 'webdav' as CloudType,
    name: '',
    endpoint: '',
    bucket: '',
    path: '',
    accessKey: '',
    secret: '',
    region: '',
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FormError>({});

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<CloudTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 测试连接
  const [testingId, setTestingId] = useState<string | null>(null);

  // 上传
  const [uploadTargetId, setUploadTargetId] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  /**
   * 加载目标列表
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<TargetsResponse>('/api/cloud/targets');
      const list = data?.targets || [];
      setTargets(list);
      setLoadError('');
      if (list.length > 0 && !list.some((t) => t.id === uploadTargetId)) {
        setUploadTargetId(list[0].id);
      }
    } catch (e: any) {
      setLoadError(e?.message || t('加载失败'));
      showToast(e?.message || t('加载失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, uploadTargetId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 打开新增弹窗
   */
  const openCreate = useCallback(() => {
    if (!canManage) {
      showToast(t('仅管理员可新增云端目标'), 'error');
      return;
    }
    setEditing(null);
    setForm({ type: 'webdav', name: '', endpoint: '', bucket: '', path: '', accessKey: '', secret: '', region: '' });
    setErrors({});
    setModalOpen(true);
  }, [canManage, showToast]);

  /**
   * 打开编辑弹窗
   * @param t 目标
   */
  const openEdit = useCallback((tg: CloudTarget) => {
    if (!canManage) {
      showToast(t('仅管理员可编辑云端目标'), 'error');
      return;
    }
    setEditing(tg);
    setForm({
      type: tg.type,
      name: tg.name,
      endpoint: tg.endpoint,
      bucket: tg.bucket,
      path: tg.path,
      accessKey: tg.accessKey,
      secret: '',
      region: tg.region,
    });
    setErrors({});
    setModalOpen(true);
  }, [canManage, showToast]);

  /**
   * 校验并提交
   */
  const handleSubmit = useCallback(async () => {
    if (!canManage) {
      showToast(editing ? t('仅管理员可编辑云端目标') : t('仅管理员可新增云端目标'), 'error');
      setModalOpen(false);
      return;
    }
    const err: FormError = {};
    if (!form.name.trim()) err.name = t('请输入名称');
    if (!form.endpoint.trim()) err.endpoint = t('请输入端点地址');
    setErrors(err);
    if (Object.keys(err).length) return;

    setSaving(true);
    try {
      const body = {
        type: form.type,
        name: form.name.trim(),
        endpoint: form.endpoint.trim(),
        bucket: form.bucket.trim(),
        path: form.path.trim(),
        accessKey: form.accessKey.trim(),
        secret: form.secret,
        region: form.region.trim(),
      };
      if (editing) {
        await post(`/api/cloud/targets/${editing.id}`, body);
        showToast(t('目标已更新'));
      } else {
        await post('/api/cloud/targets', body);
        showToast(t('目标已添加'));
      }
      setModalOpen(false);
      load();
    } catch (e: any) {
      showToast(e?.message || t('保存失败'), 'error');
    } finally {
      setSaving(false);
    }
  }, [canManage, editing, form, load, showToast]);

  /**
   * 删除目标
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可删除云端目标'), 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/cloud/targets/${deleteTarget.id}`);
      showToast(t('目标已删除'));
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || t('删除失败'), 'error');
    } finally {
      setDeleting(false);
    }
  }, [canManage, deleteTarget, load, showToast]);

  /**
   * 测试连接
   * @param t 目标
   */
  const handleTest = useCallback(async (tg: CloudTarget) => {
    if (!canManage) {
      showToast(t('仅管理员可测试云端目标'), 'error');
      return;
    }
    setTestingId(tg.id);
    try {
      const data = await post<{ ok: boolean; message: string }>(`/api/cloud/targets/${tg.id}/test`);
      showToast(data?.message || (data?.ok ? t('连接成功') : t('连接失败')));
    } catch (e: any) {
      showToast(e?.message || t('测试失败'), 'error');
    } finally {
      setTestingId(null);
    }
  }, [canManage, showToast]);

  /**
   * 上传文件到所选目标
   */
  const handleUpload = useCallback(async () => {
    if (!canManage) {
      showToast(t('仅管理员可上传备份'), 'error');
      return;
    }
    if (!uploadTargetId) {
      showToast(t('请选择目标'), 'error');
      return;
    }
    if (!uploadFile) {
      showToast(t('请选择文件'), 'error');
      return;
    }
    setUploading(true);
    try {
      const token = getToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const resp = await fetch(
        `/api/cloud/upload?id=${encodeURIComponent(uploadTargetId)}&filename=${encodeURIComponent(uploadFile.name)}`,
        { method: 'POST', headers, body: uploadFile },
      );
      if (!resp.ok) {
        let msg = t('上传失败 ({{v1}})', { v1: resp.status });
        try {
          const data = await resp.json();
          msg = data?.error || msg;
        } catch {
          // 保留默认
        }
        throw new Error(msg);
      }
      showToast(t('已上传到云端：{{v1}}', { v1: uploadFile.name }));
      if (uploadRef.current) uploadRef.current.value = '';
      setUploadFile(null);
    } catch (e: any) {
      showToast(e?.message || t('上传失败'), 'error');
    } finally {
      setUploading(false);
    }
  }, [canManage, uploadTargetId, uploadFile, showToast]);

  // 目标类型提示
  const endpointHint =
    form.type === 'webdav'
      ? t('WebDAV 服务器地址，如 https://dav.example.com/dav')
      : form.type === 'oss'
        ? t('OSS 端点，如 https://oss-cn-hangzhou.aliyuncs.com')
        : t('S3 端点，如 https://s3.region.amazonaws.com');

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">{t('云端备份')}</h1>
        <p className="page__desc">{t('将备份文件上传到 S3 / 阿里 OSS / WebDAV 存储')}</p>
      </div>

      {/* 上传区 */}
      <Card>
        <div className="cb-upload">
          <Select
            className="cb-upload__select"
            value={uploadTargetId}
            onChange={(e) => setUploadTargetId(e.target.value)}
          >
            {targets.length === 0 && <option value="">{t('暂无目标')}</option>}
{targets.map((tg) => (
<option key={tg.id} value={tg.id}>{tg.name}（{t(TYPE_LABEL[tg.type])}）</option>
))}
          </Select>
          <div className="cb-upload__file">
            <Button variant="secondary" size="sm" onClick={() => uploadRef.current?.click()}>
              {uploadFile ? t('重新选择') : t('选择文件')}
            </Button>
            {uploadFile && <span className="cb-upload__name">{uploadFile.name}</span>}
          </div>
          <Button loading={uploading} disabled={!uploadFile || targets.length === 0 || !canManage} onClick={handleUpload}>
            {uploading ? t('上传中...') : t('上传')}
          </Button>
        </div>
        <input
          ref={uploadRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
        />
      </Card>

      {/* 目标列表 */}
      <div className="toolbar">
        <Button onClick={openCreate} disabled={!canManage}>{t('+ 新增目标')}</Button>
        <Button variant="ghost" onClick={load}>{t('刷新')}</Button>
      </div>

      <Card>
        {loading ? (
          <SkeletonRows rows={4} />
        ) : loadError ? (
          <Empty
            kind="error"
            title={t('加载云端目标失败')}
            description={loadError || t('请稍后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={load}>
                {t('重试')}
              </Button>
            }
          />
        ) : targets.length === 0 ? (
          <Empty title={t('暂无云端目标')} description="先新增一个 S3 / OSS / WebDAV 目标，即可上传备份文件。" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '20%' }}>{t('名称')}</th>
                <th style={{ width: '10%' }}>{t('类型')}</th>
                <th style={{ width: '32%' }}>{t('端点')}</th>
                <th style={{ width: '12%' }}>{t('密钥')}</th>
                <th style={{ width: '26%' }}>{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
{targets.map((tg) => (
<tr key={tg.id}>
<td><strong>{tg.name}</strong></td>
<td><span className="cb-badge">{t(TYPE_LABEL[tg.type])}</span></td>
<td className="cb-endpoint">{tg.endpoint}</td>
<td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
{tg.hasSecret ? t('已配置') : t('未配置')}
</td>
                  <td>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      <Button variant="ghost" size="sm" loading={testingId === tg.id} disabled={!canManage} onClick={() => handleTest(tg)}>
                        {t('测试连接')}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => openEdit(tg)}>{t('编辑')}</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(tg)} disabled={!canManage}>{t('删除')}</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="cb-type-hint" style={{ marginTop: 14 }}>
          {t('WebDAV：PUT + Basic 认证（AccessKey=用户名，Secret=密码）。')}
          {t('S3/OSS：使用 AccessKey + SecretKey 签名上传。')}
        </div>
      </Card>

      {/* 新增/编辑目标弹窗 */}
      <Modal
        open={modalOpen}
        title={editing ? t('编辑目标：{{v1}}', { v1: editing.name }) : t('新增云端目标')}
        onClose={() => setModalOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>{t('取消')}</Button>
            <Button loading={saving} onClick={handleSubmit} disabled={!canManage}>{editing ? t('保存') : t('新增')}</Button>
          </div>
        }
      >
        <Field label={t('类型')}>
          <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as CloudType }))}>
            <option value="webdav">WebDAV</option>
            <option value="s3">S3</option>
            <option value="oss">{t('阿里 OSS')}</option>
          </Select>
        </Field>
        <Field label={t('名称')} required>
          <Input value={form.name} placeholder={t('如：我的 NAS/腾讯云 COS')} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          {errors.name && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 12, marginTop: 4 }}>{errors.name}</div>}
        </Field>
        <Field label={t('端点地址')} required hint={endpointHint}>
          <Input value={form.endpoint} placeholder="https://..." onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))} />
          {errors.endpoint && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 12, marginTop: 4 }}>{errors.endpoint}</div>}
        </Field>
        {form.type !== 'webdav' && (
          <Field label={t('桶名（Bucket）')} required>
            <Input value={form.bucket} placeholder="my-bucket" onChange={(e) => setForm((f) => ({ ...f, bucket: e.target.value }))} />
          </Field>
        )}
        {form.type === 's3' && (
          <Field label="Region">
            <Input value={form.region} placeholder="us-east-1" onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))} />
          </Field>
        )}
        <Field label={t('基路径（可选）')}>
          <Input value={form.path} placeholder="backup/app1" onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))} />
        </Field>
        <Field label={t('AccessKey / 用户名')} hint={form.type === 'webdav' ? t('WebDAV 用户名') : t('访问密钥 ID')}>
          <Input value={form.accessKey} onChange={(e) => setForm((f) => ({ ...f, accessKey: e.target.value }))} />
        </Field>
        <Field label={form.type === 'webdav' ? t('密码') : 'SecretKey'} hint={editing ? t('留空则保持原密钥不变') : undefined}>
          <Input type="password" value={form.secret} onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))} />
        </Field>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('删除目标')}
        message={t('确定删除云端目标「{{v1}}」吗？', { v1: deleteTarget?.name || '' })}
        confirmText={t('删除')}
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
