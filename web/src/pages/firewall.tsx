/**
 * Windows 防火墙端口放行页面
 *
 * 通过后端 /api/firewall 接口，基于系统 netsh 管理入站端口放行规则。
 * 仅 Windows 平台可用；增删操作需管理员权限（netsh 需管理员）。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { Field, Input, Select } from '../components/Form';
import './firewall.less';

/** 端口放行规则 */
interface FirewallPort {
  id: string;
  port: number;
  proto: string;
  name: string;
  remark: string;
  createdAt: number;
}

/** 列表响应 */
interface PortsResponse {
  supported: boolean;
  ports: FirewallPort[];
  message?: string;
}

/** 平台/权限检测响应 */
interface CheckResponse {
  supported: boolean;
  writable: boolean;
  message?: string;
}

/**
 * 格式化时间
 * @param sec 秒级时间戳
 */
function formatTime(sec: number): string {
  if (!sec) return '—';
  const d = new Date(sec);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Windows 防火墙端口放行页面组件
 */
export default function FirewallPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();

  const [ports, setPorts] = useState<FirewallPort[]>([]);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [writable, setWritable] = useState(true);
  const [loadError, setLoadError] = useState('');

  // 新增弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<{ port: string; proto: string; remark: string }>({ port: '', proto: 'tcp', remark: '' });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ port?: string }>({});

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<FirewallPort | null>(null);
  const [deleting, setDeleting] = useState(false);

  /**
   * 加载端口规则与平台/权限状态
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pResp, cResp] = await Promise.all([
        get<PortsResponse>('/api/firewall/ports'),
        get<CheckResponse>('/api/firewall/check'),
      ]);
      setSupported(pResp?.supported ?? true);
      setPorts(pResp?.ports || []);
      setWritable(cResp?.writable ?? true);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || '加载失败');
      showToast(e?.message || '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 打开新增弹窗
   */
  const openCreate = useCallback(() => {
    if (!canManage) {
      showToast('仅管理员可开放端口', 'error');
      return;
    }
    setForm({ port: '', proto: 'tcp', remark: '' });
    setErrors({});
    setCreateOpen(true);
  }, [canManage, showToast]);

  /**
   * 提交新增规则
   */
  const handleCreate = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可开放端口', 'error');
      setCreateOpen(false);
      return;
    }
    const err: { port?: string } = {};
    const portNum = Number(form.port);
    if (!form.port.trim() || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      err.port = '请输入 1-65535 的端口号';
    }
    setErrors(err);
    if (Object.keys(err).length) return;

    setSaving(true);
    try {
      await post('/api/firewall/ports', {
        port: portNum,
        proto: form.proto,
        remark: form.remark.trim(),
      });
      showToast('防火墙端口已开放');
      setCreateOpen(false);
      load();
    } catch (e: any) {
      showToast(e?.message || '开放失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [canManage, form, load, showToast]);

  /**
   * 确认删除规则
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canManage) {
      showToast('仅管理员可关闭端口', 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/firewall/ports/${deleteTarget.id}`);
      showToast('防火墙端口已关闭');
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || '关闭失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canManage, deleteTarget, load, showToast]);

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">防火墙</h1>
        <p className="page__desc">管理 Windows 防火墙入站端口放行规则（基于系统 netsh）</p>
      </div>

      {!supported ? (
        <Card>
          <Empty title="该功能仅支持 Windows 平台" description="防火墙管理依赖 Windows 系统的 netsh advfirewall 命令。" />
        </Card>
      ) : (
        <>
          {!writable && (
            <Card>
              <Empty
                kind={loadError ? 'error' : 'empty'}
                title={loadError || '需要管理员权限'}
                description="修改 Windows 防火墙需要管理员权限，请以管理员身份运行面板服务后再执行增删操作。当前仅可查看已有规则。"
              />
            </Card>
          )}

          <div className="toolbar">
            <Button onClick={openCreate} disabled={!canManage}>+ 开放端口</Button>
            <Button variant="ghost" onClick={load}>刷新</Button>
          </div>

          <Card>
            {loading ? (
              <SkeletonRows rows={4} />
            ) : ports.length === 0 ? (
              <Empty title="暂无放行规则" description="点击「开放端口」放行一个入站 TCP/UDP 端口。" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: '20%' }}>端口</th>
                    <th style={{ width: '12%' }}>协议</th>
                    <th style={{ width: '12%' }}>规则名</th>
                    <th style={{ width: '26%' }}>备注</th>
                    <th style={{ width: '18%' }}>创建时间</th>
                    <th style={{ width: '12%' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {ports.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.port}</strong></td>
                      <td><span className="fw-proto">{p.proto.toUpperCase()}</span></td>
                      <td className="fw-name" title={p.name}>{p.name}</td>
                      <td className="fw-remark">{p.remark || '—'}</td>
                      <td className="fw-time">{formatTime(p.createdAt)}</td>
                      <td>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(p)} disabled={!canManage}>
                          关闭
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {/* 新增弹窗 */}
      <Modal
        open={createOpen}
        title="开放防火墙端口"
        onClose={() => setCreateOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button loading={saving} onClick={handleCreate} disabled={!canManage}>开放</Button>
          </div>
        }
      >
        <Field label="端口号" required>
          <Input
            value={form.port}
            placeholder="如 8080"
            onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
          />
          {errors.port && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 12, marginTop: 4 }}>{errors.port}</div>}
        </Field>
        <Field label="协议">
          <Select value={form.proto} onChange={(e) => setForm((f) => ({ ...f, proto: e.target.value }))}>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </Select>
        </Field>
        <Field label="备注（可选）">
          <Input
            value={form.remark}
            placeholder="如：Nginx 对外服务"
            onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))}
          />
        </Field>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="关闭防火墙端口"
        message={`确定关闭防火墙对端口 ${deleteTarget?.port}/${deleteTarget?.proto} 的入站放行吗？`}
        confirmText="关闭"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
