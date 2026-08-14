/**
 * 站点 / SSL / 反向代理页面
 *
 * 管理反向代理站点（域名 → 上游），支持启停、删除、应用配置与证书替换。
 * 证书替换：填写证书/私钥文件路径，选择本地 .crt 文件上传，后端写入路径并应用。
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
import { Field, Input } from '../components/Form';
import './sites.less';

/** 站点 */
interface Site {
  id: string;
  domain: string;
  upstreamHost: string;
  upstreamPort: number;
  listenPort: number;
  enableHttps: boolean;
  certPath: string;
  enabled: boolean;
}

/** 列表响应 */
interface SitesResponse {
  sites: Site[];
}

/** 证书状态 */
interface CertStatus {
  certPath: string;
  exists: boolean;
  expiresAt: string | null;
}

/** 表单校验错误 */
interface FormError {
  domain?: string;
  upstreamHost?: string;
  upstreamPort?: string;
}

/**
 * 站点管理页面组件
 */
export default function SitesPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();
  const canDelete = isAdmin();
  const certInputRef = useRef<HTMLInputElement>(null);

  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(false);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  const [applying, setApplying] = useState(false);

  // 新增/编辑弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Site | null>(null);
  const [form, setForm] = useState({
    domain: '',
    upstreamHost: '',
    upstreamPort: '80',
    listenPort: '80',
    enableHttps: false,
    certPath: '',
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FormError>({});

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<Site | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 证书管理
  const [certSite, setCertSite] = useState<Site | null>(null);
  const [certPath, setCertPath] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certStatus, setCertStatus] = useState<CertStatus | null>(null);
  const [savingCert, setSavingCert] = useState(false);

  /**
   * 加载站点列表
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<SitesResponse>('/api/sites');
      setSites(data?.sites || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || '加载站点失败');
      showToast(e?.message || '加载站点失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 应用（reload）反代配置
   */
  const applyConfig = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可应用反代配置', 'error');
      return;
    }
    setApplying(true);
    try {
      const data = await post<{ ok: boolean; message: string }>('/api/sites/reload');
      showToast(data?.message || '配置已应用');
    } catch (e: any) {
      showToast(e?.message || '应用配置失败', 'info');
    } finally {
      setApplying(false);
    }
  }, [canManage, showToast]);

  /**
   * 打开新增弹窗
   */
  const openCreate = useCallback(() => {
    if (!canManage) {
      showToast('仅管理员可新增站点', 'error');
      return;
    }
    setEditing(null);
    setForm({ domain: '', upstreamHost: '', upstreamPort: '80', listenPort: '80', enableHttps: false, certPath: '' });
    setErrors({});
    setModalOpen(true);
  }, [canManage, showToast]);

  /**
   * 打开编辑弹窗
   * @param s 站点
   */
  const openEdit = useCallback((s: Site) => {
    if (!canManage) {
      showToast('仅管理员可编辑站点', 'error');
      return;
    }
    setEditing(s);
    setForm({
      domain: s.domain,
      upstreamHost: s.upstreamHost,
      upstreamPort: String(s.upstreamPort),
      listenPort: String(s.listenPort),
      enableHttps: s.enableHttps,
      certPath: s.certPath,
    });
    setErrors({});
    setModalOpen(true);
  }, [canManage, showToast]);

  /**
   * 校验并提交
   */
  const handleSubmit = useCallback(async () => {
    if (!canManage) {
      showToast(editing ? '仅管理员可编辑站点' : '仅管理员可新增站点', 'error');
      setModalOpen(false);
      return;
    }
    const err: FormError = {};
    if (!form.domain.trim()) err.domain = '请输入域名';
    if (!form.upstreamHost.trim()) err.upstreamHost = '请输入上游地址';
    const port = Number(form.upstreamPort);
    if (!(port >= 1 && port <= 65535)) err.upstreamPort = '端口无效';
    setErrors(err);
    if (Object.keys(err).length) return;

    setSaving(true);
    try {
      const body = {
        domain: form.domain.trim(),
        upstreamHost: form.upstreamHost.trim(),
        upstreamPort: Number(form.upstreamPort),
        listenPort: Number(form.listenPort),
        enableHttps: form.enableHttps,
        certPath: form.certPath.trim(),
      };
      const data = await (editing
        ? post<{ ok: boolean; proxy: { ok: boolean; message: string } }>(`/api/sites/${editing.id}`, body)
        : post<{ ok: boolean; proxy: { ok: boolean; message: string } }>('/api/sites', body));
      showToast(editing ? '站点已更新' : '站点已创建');
      if (data?.proxy && !data.proxy.ok) {
        showToast(data.proxy.message, 'info');
      }
      setModalOpen(false);
      load();
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [canManage, editing, form, load, showToast]);

  /**
   * 删除站点
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canDelete) {
      showToast('仅管理员可删除站点', 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/sites/${deleteTarget.id}`);
      showToast('站点已删除');
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canDelete, deleteTarget, load, showToast]);

  /**
   * 启停站点
   * @param s 站点
   */
  const handleToggle = useCallback(
    async (s: Site) => {
      if (!canManage) {
        showToast('仅管理员可启停站点', 'error');
        return;
      }
      try {
        await post(`/api/sites/${s.id}/toggle`);
        showToast(s.enabled ? '站点已停止' : '站点已启动');
        load();
      } catch (e: any) {
        showToast(e?.message || '操作失败', 'error');
      }
    },
    [canManage, load, showToast],
  );

  /**
   * 打开证书管理弹窗并加载现状
   * @param s 站点
   */
  const openCert = useCallback(
    async (s: Site) => {
      if (!canManage) {
        showToast('仅管理员可管理证书', 'error');
        return;
      }
      setCertSite(s);
      setCertPath(s.certPath);
      setKeyPath(s.certPath ? s.certPath.replace(/\.(crt|pem)$/i, '.key') : '');
      setCertFile(null);
      setCertStatus(null);
      try {
        const data = await get<CertStatus>(`/api/sites/${s.id}/cert`);
        setCertStatus(data || null);
      } catch {
        setCertStatus(null);
      }
    },
    [canManage, showToast],
  );

  /**
   * 上传并替换证书
   */
  const handleSaveCert = useCallback(async () => {
    if (!certSite) return;
    if (!canManage) {
      showToast('仅管理员可管理证书', 'error');
      setCertSite(null);
      return;
    }
    if (!certFile) {
      showToast('请选择证书文件', 'error');
      return;
    }
    if (!certPath.trim()) {
      showToast('请填写证书文件路径', 'error');
      return;
    }
    setSavingCert(true);
    try {
      const token = getToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const qs =
        `certPath=${encodeURIComponent(certPath.trim())}` +
        (keyPath.trim() ? `&keyPath=${encodeURIComponent(keyPath.trim())}` : '');
      const resp = await fetch(`/api/sites/${certSite.id}/cert?${qs}`, { method: 'POST', headers, body: certFile });
      if (!resp.ok) {
        let msg = `上传失败 (${resp.status})`;
        try {
          const data = await resp.json();
          msg = data?.error || data?.proxy?.message || msg;
        } catch {
          // 保留默认
        }
        throw new Error(msg);
      }
      showToast('证书已替换');
      // 刷新证书状态
      const data = await get<CertStatus>(`/api/sites/${certSite.id}/cert`);
      setCertStatus(data || null);
    } catch (e: any) {
      showToast(e?.message || '证书替换失败', 'error');
    } finally {
      setSavingCert(false);
    }
  }, [canManage, certSite, certPath, keyPath, certFile, showToast]);

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">站点 / 反向代理</h1>
        <p className="page__desc">通过内置 nginx 容器承载的反向代理站点与 SSL 证书管理</p>
      </div>

      <div className="toolbar">
        <Button onClick={openCreate} disabled={!canManage}>+ 新增站点</Button>
        <Button variant="ghost" onClick={load}>刷新</Button>
        <Button variant="secondary" loading={applying} onClick={applyConfig} disabled={!canManage}>应用配置</Button>
      </div>

      <Card>
        {loading ? (
          <SkeletonRows rows={4} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="加载站点失败"
            description={loadError || '请稍后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={load}>
                重试
              </Button>
            }
          />
        ) : sites.length === 0 ? (
          <Empty title="暂无站点" description="新增一个反向代理站点，将域名代理到指定的上游地址与端口。" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '24%' }}>域名</th>
                <th style={{ width: '22%' }}>上游</th>
                <th style={{ width: '12%' }}>端口</th>
                <th style={{ width: '16%' }}>状态</th>
                <th style={{ width: '26%' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id}>
                  <td><span className="site-domain">{s.domain}</span></td>
                  <td className="site-upstream">{s.upstreamHost}:{s.upstreamPort}</td>
                  <td className="site-upstream">{s.listenPort}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      <span className={`site-badge ${s.enabled ? 'site-badge--on' : 'site-badge--off'}`}>
                        {s.enabled ? '运行中' : '已停止'}
                      </span>
                      {s.enableHttps && <span className="site-badge site-badge--https">HTTPS</span>}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      <Button variant="ghost" size="sm" onClick={() => handleToggle(s)} disabled={!canManage}>
                        {s.enabled ? '停止' : '启动'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openCert(s)} disabled={!canManage}>证书</Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(s)} disabled={!canManage}>编辑</Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(s)} disabled={!canDelete}>删除</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="site-hint" style={{ marginTop: 14 }}>
          说明：站点配置会写入宿主机 <code>data/nginx/conf.d</code> 并应用到内置 nginx 反代容器（dm-reverse-proxy）。
          启用 HTTPS 需在「证书」中提供证书与私钥路径。
        </div>
      </Card>

      {/* 新增/编辑站点弹窗 */}
      <Modal
        open={modalOpen}
        title={editing ? `编辑站点：${editing.domain}` : '新增站点'}
        onClose={() => setModalOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>取消</Button>
            <Button loading={saving} onClick={handleSubmit} disabled={!canManage}>{editing ? '保存' : '创建'}</Button>
          </div>
        }
      >
        <Field label="域名" required>
          <Input value={form.domain} placeholder="如 app.example.com" onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} />
          {errors.domain && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 12, marginTop: 4 }}>{errors.domain}</div>}
        </Field>
        <Field label="上游地址" required hint="要代理到的上游，如 localhost 或 127.0.0.1 或容器名">
          <Input value={form.upstreamHost} placeholder="127.0.0.1" onChange={(e) => setForm((f) => ({ ...f, upstreamHost: e.target.value }))} />
          {errors.upstreamHost && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 12, marginTop: 4 }}>{errors.upstreamHost}</div>}
        </Field>
        <Field label="上游端口" required>
          <Input value={form.upstreamPort} onChange={(e) => setForm((f) => ({ ...f, upstreamPort: e.target.value }))} />
          {errors.upstreamPort && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 12, marginTop: 4 }}>{errors.upstreamPort}</div>}
        </Field>
        <Field label="监听端口" hint="宿主机对外监听端口（HTTP 默认 80；启用 HTTPS 建议 443）">
          <Input value={form.listenPort} onChange={(e) => setForm((f) => ({ ...f, listenPort: e.target.value }))} />
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
          <input type="checkbox" checked={form.enableHttps} onChange={(e) => setForm((f) => ({ ...f, enableHttps: e.target.checked }))} />
          <span>启用 HTTPS</span>
        </label>
        {form.enableHttps && (
          <Field label="证书文件路径" hint="证书 .crt 文件在宿主机上的绝对路径">
            <Input value={form.certPath} placeholder="如 C:\\certs\\app.pem" onChange={(e) => setForm((f) => ({ ...f, certPath: e.target.value }))} />
          </Field>
        )}
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除站点"
        message={`确定删除站点「${deleteTarget?.domain}」吗？`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 证书管理弹窗 */}
      <Modal
        open={!!certSite}
        title={`证书管理：${certSite?.domain || ''}`}
        onClose={() => setCertSite(null)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setCertSite(null)}>关闭</Button>
            <Button loading={savingCert} onClick={handleSaveCert}>上传证书</Button>
          </div>
        }
      >
        <div className="site-hint" style={{ marginBottom: 10 }}>
          当前状态：
          {certStatus
            ? `${certStatus.exists ? '证书文件存在' : '证书文件不存在'}${certStatus.expiresAt ? `，到期 ${certStatus.expiresAt}` : ''}`
            : '未知'}
        </div>
        <Field label="证书文件路径" required>
          <Input value={certPath} placeholder="如 D:\\certs\\app.crt" onChange={(e) => setCertPath(e.target.value)} />
        </Field>
        <Field label="私钥文件路径">
          <Input value={keyPath} placeholder="如 D:\\certs\\app.key" onChange={(e) => setKeyPath(e.target.value)} />
        </Field>
        <div style={{ marginTop: 10 }} />
        <div className="site-hint" style={{ marginBottom: 8 }}>选择本地证书文件（.crt / .pem），上传后将写入上述路径并应用配置：</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button variant="secondary" size="sm" onClick={() => certInputRef.current?.click()}>
            {certFile ? certFile.name : '选择证书文件'}
          </Button>
          {certFile && <span className="site-upstream">{certFile.name}</span>}
        </div>
        <input
          ref={certInputRef}
          type="file"
          accept=".crt,.pem,.cert"
          style={{ display: 'none', marginTop: 8 }}
          onChange={(e) => setCertFile(e.target.files?.[0] || null)}
        />
      </Modal>
    </div>
  );
}
