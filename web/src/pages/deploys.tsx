/**
 * Git 部署工作台：仓库绑定 compose 项目，一键部署 + webhook 触发 + 部署历史
 */
import React, { useCallback, useEffect, useState } from 'react';
import './deploys.less';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import Empty from '../components/Empty';
import { Field, Input } from '../components/Form';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, put, del } from '../api/client';
import { useCanManage } from '../hooks/useCanManage';
import { translateNow as t } from '../i18n';

/** 本地状态徽标（部署状态色板） */
function DeployBadge({ label, tone }: { label: string; tone: 'green' | 'red' | 'blue' | 'slate' }) {
  const colorMap = { green: '#2da44e', red: '#cf222e', blue: '#0969da', slate: '#8b949e' };
  return (
    <span style={{ color: colorMap[tone], fontSize: 12, fontWeight: 500 }}>
      ● {label}
    </span>
  );
}

/** 部署应用（列表行） */
interface DeployApp {
  id: number;
  name: string;
  repo_url: string;
  branch: string;
  compose_path: string;
  also_build: number;
  webhook_token: string;
  /** 是否已配置 HMAC 签名密钥（1/0） */
  webhook_secret_set?: number;
  last_deploy_at: number | null;
  last_status: string | null;
  last_detail: string | null;
}

/** 部署历史行 */
interface DeployLogItem {
  id: number;
  run_at: number;
  status: number;
  source: string;
  detail: string | null;
}

/** 表单态 */
interface AppForm {
  id?: number;
  name: string;
  repoUrl: string;
  branch: string;
  composePath: string;
  credUser: string;
  credPass: string;
  alsoBuild: boolean;
}

const EMPTY_FORM: AppForm = { name: '', repoUrl: '', branch: '', composePath: '', credUser: '', credPass: '', alsoBuild: true };

function App() {
  const { showToast } = useToast();
  const canManage = useCanManage();
  const [items, setItems] = useState<DeployApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);

  // 新建/编辑弹窗
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<AppForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // 部署历史弹窗
  const [historyApp, setHistoryApp] = useState<DeployApp | null>(null);
  const [historyItems, setHistoryItems] = useState<DeployLogItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // 签名密钥弹窗
  const [secretTarget, setSecretTarget] = useState<DeployApp | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [secretSaving, setSecretSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await get<{ items: DeployApp[] }>('/api/deploys');
      setItems(res.items || []);
    } catch (e: any) {
      setLoadError(e?.message || '');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  /** 打开新建弹窗 */
  function openCreate() {
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  /** 打开编辑弹窗 */
  function openEdit(app: DeployApp) {
    setForm({
      id: app.id,
      name: app.name,
      repoUrl: app.repo_url,
      branch: app.branch,
      composePath: app.compose_path,
      credUser: '',
      credPass: '',
      alsoBuild: app.also_build === 1,
    });
    setFormOpen(true);
  }

  /** 保存（新建或更新） */
  async function handleSave() {
    if (!form.name.trim() || !form.repoUrl.trim()) {
      showToast(t('请填写应用名与仓库地址'), 'error');
      return;
    }
    setSaving(true);
    try {
      const cred =
        form.credUser || form.credPass ? { username: form.credUser, password: form.credPass } : undefined;
      if (form.id) {
        await put(`/api/deploys/${form.id}`, {
          repoUrl: form.repoUrl,
          branch: form.branch,
          composePath: form.composePath,
          cred,
          alsoBuild: form.alsoBuild,
        });
        showToast(t('应用已更新'));
      } else {
        await post('/api/deploys', {
          name: form.name,
          repoUrl: form.repoUrl,
          branch: form.branch,
          composePath: form.composePath,
          cred,
          alsoBuild: form.alsoBuild,
        });
        showToast(t('应用已创建'));
      }
      setFormOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('保存失败'), 'error');
    } finally {
      setSaving(false);
    }
  }

  /** 立即部署（异步执行，轮询刷新状态） */
  async function handleDeploy(app: DeployApp) {
    setBusy(true);
    try {
      await post(`/api/deploys/${app.id}/deploy`, { source: 'manual' });
      showToast(t('部署已开始'));
      // 轮询 90 秒等部署结束（git clone + compose up 可能较慢）
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await get<{ items: DeployApp[] }>('/api/deploys');
        const fresh = res.items?.find((it) => it.id === app.id);
        if (fresh && fresh.last_status !== 'deploying') {
          showToast(
            fresh.last_status === 'ok' ? t('部署成功') : `${t('部署失败')}：${fresh.last_detail || ''}`.slice(0, 200),
            fresh.last_status === 'ok' ? undefined : 'error',
          );
          break;
        }
        if (i === 44) showToast(t('部署仍在进行中，可稍后刷新查看'), undefined);
      }
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('部署触发失败'), 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 删除应用 */
  async function handleDelete(app: DeployApp) {
    if (!window.confirm(t('确认删除部署应用「{{name}}」？（不影响已部署的 compose 项目）', { name: app.name }))) return;
    try {
      await del(`/api/deploys/${app.id}`);
      showToast(t('已删除'));
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('删除失败'), 'error');
    }
  }

  /** 打开部署历史 */
  async function openHistory(app: DeployApp) {
    setHistoryApp(app);
    setHistoryLoading(true);
    try {
      const res = await get<{ items: DeployLogItem[] }>(`/api/deploys/${app.id}/logs`);
      setHistoryItems(res.items || []);
    } catch {
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  /** 重置 webhook token */
  async function handleResetToken(app: DeployApp) {
    try {
      await post(`/api/deploys/${app.id}/webhook-token`, {});
      showToast(t('Webhook Token 已重置'));
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('删除失败'), 'error');
    }
  }

  /** 保存/清除 HMAC 签名密钥 */
  async function handleSaveSecret(clear: boolean) {
    if (!secretTarget) return;
    const secret = clear ? '' : secretValue.trim();
    setSecretSaving(true);
    try {
      await post(`/api/deploys/${secretTarget.id}/webhook-secret`, { secret });
      showToast(clear ? t('签名密钥已清除') : t('签名密钥已保存'));
      setSecretTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('保存失败'), 'error');
    } finally {
      setSecretSaving(false);
    }
  }

  function statusBadge(app: DeployApp) {
    if (app.last_status === 'deploying') return <DeployBadge label={t('部署中')} tone="blue" />;
    if (app.last_status === 'ok') return <DeployBadge label={t('部署成功')} tone="green" />;
    if (app.last_status === 'fail') return <DeployBadge label={t('部署失败')} tone="red" />;
    return <DeployBadge label={t('未部署')} tone="slate" />;
  }

  return (
    <div className="page">
      <Card
        title={t('Git 部署')}
        extra={
          <div className="toolbar">
            <Button variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
              {t('刷新')}
            </Button>
            <Button variant="primary" size="sm" disabled={!canManage} onClick={openCreate}>
              {t('新建部署应用')}
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={4} />
        ) : loadError ? (
          <Empty kind="error" title={t('拉取部署应用失败')} description={loadError} />
        ) : items.length === 0 ? (
          <Empty
            title={t('暂无部署应用')}
            description={t('点击右上角「新建部署应用」，绑定 Git 仓库与 compose 项目，实现一键部署与 Webhook 自动触发')}
          />
        ) : (
          <div className="deploy-grid">
            {items.map((app) => (
              <div className="deploy-card" key={app.id}>
                <div className="deploy-card__head">
                  <span className="deploy-card__name">{app.name}</span>
                  {statusBadge(app)}
                </div>
                <div className="deploy-card__row" title={app.repo_url}>
                  {app.repo_url}
                </div>
                <div className="deploy-card__row deploy-card__row--muted">
                  {app.branch || t('默认分支')} · {app.also_build ? 'up -d --build' : 'up -d'}
                </div>
                <div className="deploy-card__row deploy-card__row--muted">
                  {app.last_deploy_at ? new Date(app.last_deploy_at).toLocaleString() : t('尚未部署')}
                </div>
                <div className="deploy-card__actions">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!canManage || app.last_status === 'deploying' || busy}
                    loading={busy}
                    onClick={() => handleDeploy(app)}
                  >
                    {t('立即部署')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openHistory(app)}>
                    {t('历史')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => openEdit(app)}>
                    {t('编辑')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => handleResetToken(app)}>
                    {t('重置 Token')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canManage}
                    onClick={() => {
                      setSecretTarget(app);
                      setSecretValue('');
                    }}
                    title={t('配置后，Webhook 请求必须携带正确的 X-Hub-Signature-256 签名（GitHub/Gitea 兼容）')}
                  >
                    {app.webhook_secret_set ? t('签名密钥 ✓') : t('签名密钥')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => handleDelete(app)}>
                    {t('删除')}
                  </Button>
                </div>
                <input
                  className="deploy-card__webhook"
                  readOnly
                  value={`${window.location.origin}/api/webhook/${app.webhook_token}`}
                  onFocus={(e) => e.target.select()}
                  title={t('Webhook 地址（点击全选复制），Git 仓库 push 事件触发自动部署')}
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 新建 / 编辑弹窗 */}
      <Modal
        open={formOpen}
        title={form.id ? t('编辑部署应用') : t('新建部署应用')}
        onClose={() => setFormOpen(false)}
        width={560}
        footer={
          <>
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              {t('取消')}
            </Button>
            <Button variant="primary" loading={saving} onClick={handleSave}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <Field label={t('应用名')} required hint={t('同时作为 compose 项目名，仅允许字母数字与 . _ -')}>
          <Input value={form.name} disabled={!!form.id} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('例如：myapp')} />
        </Field>
        <Field label={t('Git 仓库地址')} required hint={t('支持 https / ssh；私有仓库可填写凭据')}>
          <Input value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} placeholder="https://github.com/user/repo.git" />
        </Field>
        <Field label={t('分支（可选）')}>
          <Input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} placeholder={t('留空使用默认分支')} />
        </Field>
        <Field label={t('compose 文件相对路径（可选）')} hint={t('留空自动探测 compose.yaml / docker-compose.yml 等')}>
          <Input value={form.composePath} onChange={(e) => setForm({ ...form, composePath: e.target.value })} placeholder="deploy/compose.yaml" />
        </Field>
        <Field label={t('Git 凭据（可选）')} hint={t('私有仓库填写；留空保持原有凭据不变')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input value={form.credUser} onChange={(e) => setForm({ ...form, credUser: e.target.value })} placeholder={t('用户名 / token')} />
            <Input type="password" value={form.credPass} onChange={(e) => setForm({ ...form, credPass: e.target.value })} placeholder={t('密码')} />
          </div>
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <input type="checkbox" checked={form.alsoBuild} onChange={(e) => setForm({ ...form, alsoBuild: e.target.checked })} />
          {t('部署时执行 docker compose up -d --build（需要构建时勾选）')}
        </label>
      </Modal>

      {/* 部署历史弹窗 */}
      <Modal open={!!historyApp} title={`${t('部署历史')} · ${historyApp?.name || ''}`} onClose={() => setHistoryApp(null)} width={720}>
        {historyLoading ? (
          <SkeletonRows rows={5} />
        ) : historyItems.length === 0 ? (
          <Empty title={t('暂无部署记录')} />
        ) : (
          <div className="kv-scroll" style={{ maxHeight: 420 }}>
            <table className="kv-table">
              <tbody>
                {historyItems.map((h) => (
                  <tr key={h.id}>
                    <td className="kv-key" style={{ whiteSpace: 'nowrap' }}>{new Date(h.run_at).toLocaleString()}</td>
                    <td className="kv-val">
                      <div>
                        <DeployBadge label={h.status === 0 ? t('成功') : t('失败')} tone={h.status === 0 ? 'green' : 'red'} />
                        <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>{h.source === 'webhook' ? 'Webhook' : t('手动')}</span>
                      </div>
                      <pre style={{ marginTop: 4, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }}>
                        {h.detail || '-'}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      {/* 签名密钥弹窗 */}
      <Modal
        open={!!secretTarget}
        title={`${t('Webhook 签名密钥')} · ${secretTarget?.name || ''}`}
        onClose={() => setSecretTarget(null)}
        width={480}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSecretTarget(null)}>
              {t('取消')}
            </Button>
            <Button variant="ghost" disabled={secretSaving} onClick={() => handleSaveSecret(true)}>
              {t('清除密钥')}
            </Button>
            <Button variant="primary" loading={secretSaving} onClick={() => handleSaveSecret(false)}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <Field
          label={t('HMAC 签名密钥')}
          required
          hint={t('与 Git 仓库 Webhook 设置中的 Secret 保持一致；保存后 push 事件必须携带有效签名才会触发部署')}
        >
          <Input
            type="password"
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            placeholder={secretTarget?.webhook_secret_set ? t('已配置（输入新值可覆盖）') : t('例如：my-webhook-secret')}
          />
        </Field>
      </Modal>
    </div>
  );
}

export default App;
