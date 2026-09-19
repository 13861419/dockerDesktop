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
  /** CI 状态门禁（1.75.0） */
  ci_gate_enabled?: number;
  ci_provider?: string | null;
  ci_api_url?: string | null;
  ci_policy?: string | null;
  ci_token_set?: number;
  last_green_commit?: string | null;
  /** GitOps 定时同步（1.77.0） */
  gitops_enabled?: number;
  gitops_interval_min?: number | null;
  gitops_auto?: number;
  gitops_last_commit?: string | null;
  gitops_last_check?: number | null;
  /** 部署钩子（1.78.0） */
  pre_hook?: string | null;
  post_hook?: string | null;
  /** 镜像构建推送（1.80.0） */
  image_build_enabled?: number;
  image_name?: string | null;
  image_tag_template?: string | null;
  image_dockerfile?: string | null;
  registry_creds_set?: number;
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
  commit_sha?: string | null;
  ci_state?: string | null;
}

/** CI 运行记录（只读看板，1.79.0） */
interface CiRunItem {
  id: string;
  title: string;
  sha: string;
  status: 'success' | 'failure' | 'pending' | 'error';
  url: string;
  startedAt: string;
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
  ciGateEnabled: boolean;
  ciProvider: string;
  ciApiUrl: string;
  ciToken: string;
  ciTokenSet: boolean;
  ciPolicy: string;
  gitopsEnabled: boolean;
  gitopsAuto: boolean;
  gitopsIntervalMin: number;
  preHook: string;
  postHook: string;
  imageBuildEnabled: boolean;
  imageName: string;
  imageTagTemplate: string;
  imageDockerfile: string;
  imagePlatforms: string[];
  registryUser: string;
  registryPass: string;
  registryCredsSet: boolean;
}

const EMPTY_FORM: AppForm = {
  name: '',
  repoUrl: '',
  branch: '',
  composePath: '',
  credUser: '',
  credPass: '',
  alsoBuild: true,
  ciGateEnabled: false,
  ciProvider: '',
  ciApiUrl: '',
  ciToken: '',
  ciTokenSet: false,
  ciPolicy: 'fail-open',
  gitopsEnabled: false,
  gitopsAuto: false,
  gitopsIntervalMin: 5,
  preHook: '',
  postHook: '',
  imageBuildEnabled: false,
  imageName: '',
  imageTagTemplate: '{branch}-{sha7}',
  imageDockerfile: '',
  imagePlatforms: [] as string[],
  registryUser: '',
  registryPass: '',
  registryCredsSet: false,
};

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

  // CI 运行记录看板弹窗（1.79.0，只读）
  const [ciRunsApp, setCiRunsApp] = useState<DeployApp | null>(null);
  const [ciRuns, setCiRuns] = useState<CiRunItem[]>([]);
  const [ciRunsLoading, setCiRunsLoading] = useState(false);
  const [ciRunsError, setCiRunsError] = useState('');

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
      ciGateEnabled: app.ci_gate_enabled === 1,
      ciProvider: app.ci_provider || '',
      ciApiUrl: app.ci_api_url || '',
      ciToken: '',
      ciTokenSet: app.ci_token_set === 1,
      ciPolicy: app.ci_policy || 'fail-open',
      gitopsEnabled: app.gitops_enabled === 1,
      gitopsAuto: app.gitops_auto === 1,
      gitopsIntervalMin: app.gitops_interval_min || 5,
      preHook: app.pre_hook || '',
      postHook: app.post_hook || '',
      imageBuildEnabled: app.image_build_enabled === 1,
      imageName: app.image_name || '',
      imageTagTemplate: app.image_tag_template || '{branch}-{sha7}',
      imageDockerfile: app.image_dockerfile || '',
      imagePlatforms: (() => { try { return JSON.parse((app as any).image_platforms || '[]'); } catch { return []; } })(),
      registryUser: '',
      registryPass: '',
      registryCredsSet: app.registry_creds_set === 1,
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
          ciGateEnabled: form.ciGateEnabled,
          ciProvider: form.ciProvider,
          ciApiUrl: form.ciApiUrl,
          ciPolicy: form.ciPolicy,
          gitopsEnabled: form.gitopsEnabled,
          gitopsAuto: form.gitopsAuto,
          gitopsIntervalMin: form.gitopsIntervalMin,
          preHook: form.preHook,
          postHook: form.postHook,
          imageBuildEnabled: form.imageBuildEnabled,
          imagePlatforms: form.imagePlatforms,
          imageName: form.imageName,
          imageTagTemplate: form.imageTagTemplate,
          imageDockerfile: form.imageDockerfile,
          ...(form.registryUser.trim() || form.registryPass.trim()
            ? { registryUser: form.registryUser.trim(), ...(form.registryPass.trim() ? { registryPass: form.registryPass.trim() } : {}) }
            : {}),
          ...(form.ciToken.trim() ? { ciToken: form.ciToken.trim() } : {}),
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
        if (fresh && fresh.last_status !== 'deploying' && fresh.last_status !== 'ci-checking') {
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

  /** 部署最后一次绿构建（绿快照回滚） */
  async function handleDeployGreen(app: DeployApp) {
    setBusy(true);
    try {
      await post(`/api/deploys/${app.id}/deploy-green`, {});
      showToast(t('绿快照部署已开始'));
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('部署触发失败'), 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 打开 CI 运行记录看板（1.79.0，只读） */
  async function openCiRuns(app: DeployApp) {
    setCiRunsApp(app);
    setCiRunsLoading(true);
    setCiRunsError('');
    setCiRuns([]);
    try {
      const res = await get<{ items: CiRunItem[] }>(`/api/deploys/${app.id}/ci-runs`);
      setCiRuns(res.items || []);
    } catch (e: any) {
      setCiRunsError(e?.message || t('加载失败'));
    } finally {
      setCiRunsLoading(false);
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
    if (app.last_status === 'ci-checking') return <DeployBadge label={t('CI 检查中')} tone="blue" />;
    if (app.last_status === 'ci-blocked') return <DeployBadge label={t('CI 拦截')} tone="red" />;
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
                  {app.ci_gate_enabled === 1 && (
                    <span style={{ marginLeft: 8 }} title={t('Webhook 部署前先检查 commit 的 CI 状态，绿了才上线')}>
                      🔒 CI
                    </span>
                  )}
                </div>
                {app.ci_gate_enabled === 1 && app.last_green_commit && (
                  <div className="deploy-card__row deploy-card__row--muted">
                    {t('最后绿构建')} <code>{app.last_green_commit.slice(0, 7)}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canManage || busy}
                      onClick={() => handleDeployGreen(app)}
                      title={t('回滚到最后一次 CI 通过并部署成功的版本')}
                    >
                      {t('部署此版本')}
                    </Button>
                  </div>
                )}
                {app.gitops_enabled === 1 && (
                  <div className="deploy-card__row deploy-card__row--muted" title={t('GitOps 定时同步')}>
                    🔄 GitOps · {app.gitops_interval_min || 5} min
                    {app.gitops_last_commit && <> · <code>{app.gitops_last_commit.slice(0, 7)}</code></>}
                    {app.gitops_last_check ? ` · ${new Date(app.gitops_last_check).toLocaleTimeString()}` : ''}
                    {app.gitops_auto === 1 ? ` · ${t('自动')}` : ''}
                  </div>
                )}
                {app.image_build_enabled === 1 && app.image_name && (
                  <div className="deploy-card__row deploy-card__row--muted" title={t('部署时构建镜像并推送（Dockerfile 在仓库中，构建后 compose up 重建）')}>
                    ⚙ 🔨 {app.image_name}
                  </div>
                )}
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
                  <Button variant="ghost" size="sm" onClick={() => openCiRuns(app)} title={t('查看最近的工作流执行结果（只读）')}>
                    {t('CI 运行')}
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

        {form.id && (
          <>
            <div style={{ fontWeight: 600, margin: '16px 0 4px' }}>{t('CI 状态门禁')}</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.ciGateEnabled} onChange={(e) => setForm({ ...form, ciGateEnabled: e.target.checked })} />
              {t('Webhook 部署前先检查 commit 的 CI 状态，绿了才上线（手动部署不受限）')}
            </label>
            {form.ciGateEnabled && (
              <>
                <Field label={t('CI 平台')} hint={t('自动识别按仓库地址判断（github.com → GitHub，含 gitlab → GitLab，其余按 Gitea）')}>
                  <select value={form.ciProvider} onChange={(e) => setForm({ ...form, ciProvider: e.target.value })} style={{ width: '100%' }}>
                    <option value="">{t('自动识别')}</option>
                    <option value="github">GitHub Actions</option>
                    <option value="gitea">Gitea</option>
                    <option value="gitlab">GitLab</option>
                  </select>
                </Field>
                <Field label={t('API 根地址（可选）')} hint={t('自建 Gitea/GitLab 填写，如 https://git.example.com；留空用官方云')}>
                  <Input value={form.ciApiUrl} onChange={(e) => setForm({ ...form, ciApiUrl: e.target.value })} placeholder="https://git.example.com" />
                </Field>
                <Field
                  label={t('CI API Token（可选）')}
                  hint={t('私有仓库需要；建议最小只读权限（GitHub fine-grained PAT 勾选 Commit statuses / Check runs 读）')}
                >
                  <Input
                    type="password"
                    value={form.ciToken}
                    onChange={(e) => setForm({ ...form, ciToken: e.target.value })}
                    placeholder={form.ciTokenSet ? t('已配置（输入新值可覆盖）') : t('留空保持不变')}
                  />
                </Field>
                <Field label={t('查询失败策略')} hint={t('CI 不可达或超时（约 10 分钟）时的处置：放行并告警，或拦截部署')}>
                  <select value={form.ciPolicy} onChange={(e) => setForm({ ...form, ciPolicy: e.target.value })} style={{ width: '100%' }}>
                    <option value="fail-open">{t('fail-open：放行部署并推送告警')}</option>
                    <option value="fail-closed">{t('fail-closed：拦截部署并告警')}</option>
                  </select>
                </Field>
              </>
            )}
          </>
        )}

        {form.id && (
          <>
            <div style={{ fontWeight: 600, margin: '16px 0 4px' }}>{t('GitOps 定时同步')}</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.gitopsEnabled} onChange={(e) => setForm({ ...form, gitopsEnabled: e.target.checked })} />
              {t('定时轮询分支最新提交（只读 Git API，无需 Webhook）')}
            </label>
            {form.gitopsEnabled && (
              <>
                <Field label={t('轮询间隔（分钟）')} hint={t('每次轮询会向 Git 平台 API 发起一次只读查询')}>
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    value={form.gitopsIntervalMin}
                    onChange={(e) => setForm({ ...form, gitopsIntervalMin: Math.max(1, Math.min(1440, Number(e.target.value) || 5)) })}
                  />
                </Field>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={form.gitopsAuto} onChange={(e) => setForm({ ...form, gitopsAuto: e.target.checked })} />
                  {t('发现新提交即自动部署（关闭时仅记录提醒）')}
                </label>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{t('自动部署同样经过 CI 状态门禁（若启用）；首次启用仅记录当前 commit 作为基线，不会触发部署')}</div>
              </>
            )}
          </>
        )}

        {form.id && (
          <>
            <div style={{ fontWeight: 600, margin: '16px 0 4px' }}>{t('部署钩子')}</div>
            <Field
              label={t('部署前钩子（可选）')}
              hint={t('compose up 之前在仓库目录逐行执行；任一命令失败即中止本次部署，# 开头为注释')}
            >
              <textarea
                value={form.preHook}
                onChange={(e) => setForm({ ...form, preHook: e.target.value })}
                rows={3}
                spellCheck={false}
                placeholder={t('例如：./scripts/backup.sh 或 docker exec db pg_dump ...')}
                style={{ width: '100%', minHeight: 64, fontFamily: 'monospace', fontSize: 12, padding: '6px 8px', border: '1px solid var(--border, #ddd)', borderRadius: 6, background: 'transparent', color: 'inherit', boxSizing: 'border-box' }}
              />
            </Field>
            <Field
              label={t('后置钩子（可选）')}
              hint={t('compose up 成功后逐行执行；失败不影响已上线容器，仅在部署历史中记录警告')}
            >
              <textarea
                value={form.postHook}
                onChange={(e) => setForm({ ...form, postHook: e.target.value })}
                rows={3}
                spellCheck={false}
                placeholder={t('例如：./scripts/migrate.sh 或 curl -fsSL https://hooks.example.com/notify')}
                style={{ width: '100%', minHeight: 64, fontFamily: 'monospace', fontSize: 12, padding: '6px 8px', border: '1px solid var(--border, #ddd)', borderRadius: 6, background: 'transparent', color: 'inherit', boxSizing: 'border-box' }}
              />
            </Field>
          </>
        )}

        {form.id && (
          <>
            <div style={{ fontWeight: 600, margin: '16px 0 4px' }}>{t('镜像构建推送')}</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.imageBuildEnabled} onChange={(e) => setForm({ ...form, imageBuildEnabled: e.target.checked })} />
              {t('部署时构建镜像并推送（Dockerfile 在仓库中，构建后 compose up 重建）')}
            </label>
            {form.imageBuildEnabled && (
              <>
                <Field label={t('镜像名（含 Registry 前缀）')} required hint={t('如 harbor.example.com/team/myapp 或 user/myapp；将同时推送 latest tag')}>
                  <Input value={form.imageName} onChange={(e) => setForm({ ...form, imageName: e.target.value })} placeholder="harbor.example.com/team/myapp" />
                </Field>
                <Field label={t('Tag 模板')} hint={t('可用变量 {branch} {sha7} {ts}；非法字符自动转为 -')}>
                  <Input value={form.imageTagTemplate} onChange={(e) => setForm({ ...form, imageTagTemplate: e.target.value })} placeholder="{branch}-{sha7}" />
                </Field>
                <Field label={t('Dockerfile 路径（可选）')} hint={t('相对仓库根目录，留空使用 Dockerfile')}>
                  <Input value={form.imageDockerfile} onChange={(e) => setForm({ ...form, imageDockerfile: e.target.value })} placeholder="docker/Dockerfile" />
                </Field>
                <Field label={t('目标平台（多架构）')} hint={t('勾选两个平台即 buildx 多架构构建（首次自动安装 QEMU 模拟器并拉取构建镜像，耗时较长）；不勾选 = 单架构 docker build')}>
                  <div style={{ display: 'flex', gap: 16 }}>
                    {['linux/amd64', 'linux/arm64'].map((p) => (
                      <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={form.imagePlatforms.includes(p)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              imagePlatforms: e.target.checked
                                ? [...form.imagePlatforms, p]
                                : form.imagePlatforms.filter((x: string) => x !== p),
                            })
                          }
                        />
                        {p}
                      </label>
                    ))}
                  </div>
                </Field>
                <Field label={t('Registry 凭据（可选）')} hint={t('私有仓库填写，AES 加密存储；留空保持原有凭据不变，清空用户名即清除凭据')}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Input value={form.registryUser} onChange={(e) => setForm({ ...form, registryUser: e.target.value })} placeholder={form.registryCredsSet ? t('已配置（输入新值可覆盖）') : t('用户名')} />
                    <Input type="password" value={form.registryPass} onChange={(e) => setForm({ ...form, registryPass: e.target.value })} placeholder={t('密码')} />
                  </div>
                </Field>
              </>
            )}
          </>
        )}
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
                        <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>{h.source === 'webhook' ? 'Webhook' : h.source === 'gitops' ? 'GitOps' : h.source === 'ci-gate' ? t('CI 门禁') : t('手动')}</span>
                        {h.commit_sha && (
                          <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>
                            {h.commit_sha.slice(0, 7)}
                            {h.ci_state === 'success' ? ' · CI ✓' : h.ci_state === 'blocked' ? ' · CI 拦截' : ''}
                          </span>
                        )}
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

      {/* CI 运行记录看板（1.79.0，只读） */}
      <Modal open={!!ciRunsApp} title={`${t('CI 运行记录')} · ${ciRunsApp?.name || ''}`} onClose={() => setCiRunsApp(null)} width={640}>
        {ciRunsLoading ? (
          <SkeletonRows rows={5} />
        ) : ciRunsError ? (
          <Empty kind="error" title={t('拉取 CI 运行记录失败')} description={ciRunsError} />
        ) : ciRuns.length === 0 ? (
          <Empty title={t('暂无运行记录')} />
        ) : (
          <div className="kv-scroll" style={{ maxHeight: 420 }}>
            <table className="kv-table">
              <tbody>
                {ciRuns.map((r) => (
                  <tr key={r.id}>
                    <td className="kv-key" style={{ whiteSpace: 'nowrap' }}>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '-'}</td>
                    <td className="kv-val">
                      <div>
                        <DeployBadge
                          label={r.status === 'success' ? '✓' : r.status === 'failure' ? '✗' : '●'}
                          tone={r.status === 'success' ? 'green' : r.status === 'failure' ? 'red' : 'blue'}
                        />
                        <span style={{ marginLeft: 8 }}>{r.title}</span>
                        {r.sha && <code style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>{r.sha.slice(0, 7)}</code>}
                        {r.url && (
                          <a href={r.url} target="_blank" rel="noreferrer" style={{ marginLeft: 8, fontSize: 12 }}>
                            {t('打开')}
                          </a>
                        )}
                      </div>
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
