/**
 * 告警中心页面
 *
 * 集中管理资源告警：
 *  - 告警规则：CPU / 内存 / 磁盘 的开关与警告/危险阈值
 *  - 通知渠道：Webhook / 邮件 / 钉钉 / 飞书 的增删改、启停与测试推送
 *  - 告警记录：历史触发事件与推送结果、立即检测、清空
 *
 * 写操作（增删改渠道、改规则、清空、测试、立即检测）需管理员权限。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, put, del } from '../api/client';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { Field, Input, Select } from '../components/Form';
import './notifications.less';

/** 告警规则 */
interface AlertRule {
  type: 'cpu' | 'mem' | 'disk';
  name: string;
  enabled: boolean;
  warnThreshold: number;
  dangerThreshold: number;
}

/** 渠道可见配置（敏感字段脱敏） */
interface ChannelInfo {
  id: string;
  name: string;
  type: 'webhook' | 'email' | 'dingtalk' | 'feishu';
  enabled: boolean;
  config: Record<string, any>;
  secretsSet: Record<string, boolean>;
  createdAt: number;
  updatedAt: number;
}

/** 告警记录 */
interface AlertRecord {
  id: number;
  type: string;
  level: string;
  message: string;
  value: number | null;
  channelId: string | null;
  pushStatus: string;
  pushDetail: string | null;
  createdAt: number;
}

const PAGE_SIZE = 20;

/** 渠道类型中文名 */
const CHANNEL_LABELS: Record<string, string> = {
  webhook: 'Webhook',
  email: '邮件',
  dingtalk: '钉钉',
  feishu: '飞书',
};

/** 告警记录类型中文名（含任务失败 type=task） */
const TYPE_LABELS: Record<string, string> = {
  cpu: 'CPU',
  mem: '内存',
  disk: '磁盘',
  task: '任务',
};

/** 告警记录级别中文名（含恢复 recovery） */
const LEVEL_LABELS: Record<string, string> = {
  warn: '警告',
  danger: '危险',
  recovery: '已恢复',
};

/** 初始渠道表单结构（按类型动态渲染字段） */
interface ChannelForm {
  name: string;
  type: ChannelInfo['type'];
  url: string;        // webhook url
  secret: string;     // webhook secret / dingtalk 加签
  host: string;       // email host
  port: string;       // email port
  username: string;   // email username
  password: string;   // email password
  from: string;       // email from
  to: string;         // email to
  useTls: boolean;    // email tls
  accessToken: string; // dingtalk access_token
  webhookUrl: string; // feishu webhook url
}

const EMPTY_FORM: ChannelForm = {
  name: '',
  type: 'webhook',
  url: '',
  secret: '',
  host: '',
  port: '465',
  username: '',
  password: '',
  from: '',
  to: '',
  useTls: true,
  accessToken: '',
  webhookUrl: '',
};

/** 规则初始值 */
const RULE_NAMES: Record<string, string> = { cpu: 'CPU', mem: '内存', disk: '磁盘' };

/**
 * 格式化时间
 * @param ms 毫秒时间戳
 */
function formatTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 告警中心页面组件
 */
export default function NotificationsPage() {
  const { showToast } = useToast();

  // 规则
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [ruleLoading, setRuleLoading] = useState(true);
  // 渠道
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [channelLoading, setChannelLoading] = useState(true);
  // 记录
  const [records, setRecords] = useState<AlertRecord[]>([]);
  const [recordLoading, setRecordLoading] = useState(true);
  const [recordTotal, setRecordTotal] = useState(0);
  const [recordPage, setRecordPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [pushFilter, setPushFilter] = useState('');

  // 渠道新增/编辑弹窗
  const [channelModal, setChannelModal] = useState<{ editing: ChannelInfo | null; open: boolean }>({ editing: null, open: false });
  const [form, setForm] = useState<ChannelForm>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // 测试推送
  const [testingId, setTestingId] = useState<string | null>(null);

  // 删除渠道确认
  const [deleteTarget, setDeleteTarget] = useState<ChannelInfo | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 规则编辑
  const [ruleModal, setRuleModal] = useState<AlertRule | null>(null);
  const [ruleForm, setRuleForm] = useState<{ enabled: boolean; warnThreshold: string; dangerThreshold: string }>({
    enabled: true,
    warnThreshold: '75',
    dangerThreshold: '90',
  });
  const [savingRule, setSavingRule] = useState(false);

  /**
   * 加载告警记录（分页 + 过滤）
   */
  const loadRecords = useCallback(
    async (page = recordPage, type = typeFilter, level = levelFilter, push = pushFilter) => {
      setRecordLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('pageSize', String(PAGE_SIZE));
        if (type) params.set('type', type);
        if (level) params.set('level', level);
        if (push) params.set('pushStatus', push);
        const rec = await get<{ records: AlertRecord[]; total: number }>(`/api/notifications/records?${params.toString()}`);
        setRecords(rec?.records || []);
        setRecordTotal(rec?.total || 0);
      } catch (e: any) {
        showToast(e?.message || '加载记录失败', 'error');
      } finally {
        setRecordLoading(false);
      }
    },
    [recordPage, typeFilter, levelFilter, pushFilter, showToast],
  );

  /**
   * 加载规则与渠道
   */
  const load = useCallback(async () => {
    setRuleLoading(true);
    setChannelLoading(true);
    try {
      const [r, c] = await Promise.all([
        get<{ rules: AlertRule[] }>('/api/notifications/rules'),
        get<{ channels: ChannelInfo[] }>('/api/notifications/channels'),
      ]);
      setRules(r?.rules || []);
      setChannels(c?.channels || []);
    } catch (e: any) {
      showToast(e?.message || '加载失败', 'error');
    } finally {
      setRuleLoading(false);
      setChannelLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadRecords(1);
    // 仅当过滤条件变化时重置到第一页
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, levelFilter, pushFilter]);

  useEffect(() => {
    loadRecords(recordPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordPage]);

  /**
   * 打开新增渠道弹窗
   */
  const openCreateChannel = useCallback(() => {
    setForm({ ...EMPTY_FORM });
    setFormError('');
    setChannelModal({ editing: null, open: true });
  }, []);

  /**
   * 打开编辑渠道弹窗（预填非敏感配置）
   * @param ch 渠道
   */
  const openEditChannel = useCallback((ch: ChannelInfo) => {
    const c = ch.config || {};
    setForm({
      name: ch.name,
      type: ch.type,
      url: c.url || '',
      secret: '',
      host: c.host || '',
      port: String(c.port ?? '465'),
      username: c.username || '',
      password: '',
      from: c.from || '',
      to: c.to || '',
      useTls: c.useTls !== false,
      accessToken: '',
      webhookUrl: c.webhookUrl || '',
    });
    setFormError('');
    setChannelModal({ editing: ch, open: true });
  }, []);

  /**
   * 从当前表单组装渠道配置（仅提交该类型相关的字段）
   */
  function buildChannelConfig(): Record<string, any> {
    const base: Record<string, any> = {};
    switch (form.type) {
      case 'webhook':
        base.url = form.url.trim();
        if (form.secret.trim()) base.secret = form.secret.trim();
        break;
      case 'email':
        base.host = form.host.trim();
        base.port = form.port.trim();
        if (form.username.trim()) base.username = form.username.trim();
        if (form.password.trim()) base.password = form.password.trim();
        base.from = form.from.trim();
        base.to = form.to.trim();
        base.useTls = form.useTls;
        break;
      case 'dingtalk':
        base.accessToken = form.accessToken.trim();
        if (form.secret.trim()) base.secret = form.secret.trim();
        break;
      case 'feishu':
        base.webhookUrl = form.webhookUrl.trim();
        break;
    }
    return base;
  }

  /**
   * 提交新增 / 编辑渠道
   */
  const handleSaveChannel = useCallback(async () => {
    if (!form.name.trim()) {
      setFormError('请输入渠道名称');
      return;
    }
    if (channelModal.editing) {
      // 校验：非敏感必填字段由后端兜底；编辑时清空 represents 不覆盖
      setFormError('');
    }
    setSaving(true);
    try {
      if (channelModal.editing) {
        await put(`/api/notifications/channels/${channelModal.editing.id}`, {
          name: form.name.trim(),
          config: buildChannelConfig(),
        });
        showToast('渠道已更新');
      } else {
        await post('/api/notifications/channels', {
          name: form.name.trim(),
          type: form.type,
          config: buildChannelConfig(),
        });
        showToast('渠道已创建');
      }
      setChannelModal({ editing: null, open: false });
      load();
    } catch (e: any) {
      setFormError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }, [form, channelModal.editing, load, showToast]);

  /**
   * 切换渠道启停状态
   * @param ch 渠道
   */
  const toggleChannel = useCallback(
    async (ch: ChannelInfo) => {
      try {
        await put(`/api/notifications/channels/${ch.id}`, { enabled: !ch.enabled });
        load();
      } catch (e: any) {
        showToast(e?.message || '操作失败', 'error');
      }
    },
    [load, showToast],
  );

  /**
   * 测试推送
   * @param ch 渠道
   */
  const testChannel = useCallback(
    async (ch: ChannelInfo) => {
      setTestingId(ch.id);
      try {
        await post(`/api/notifications/channels/${ch.id}/test`);
        showToast('测试消息已发送');
      } catch (e: any) {
        showToast(e?.message || '测试推送失败', 'error');
      } finally {
        setTestingId(null);
      }
    },
    [showToast],
  );

  /**
   * 确认删除渠道
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await del(`/api/notifications/channels/${deleteTarget.id}`);
      showToast('渠道已删除');
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load, showToast]);

  /**
   * 打开规则编辑弹窗
   * @param rule 规则
   */
  const openEditRule = useCallback((rule: AlertRule) => {
    setRuleModal(rule);
    setRuleForm({
      enabled: rule.enabled,
      warnThreshold: String(rule.warnThreshold),
      dangerThreshold: String(rule.dangerThreshold),
    });
  }, []);

  /**
   * 提交规则编辑
   */
  const handleSaveRule = useCallback(async () => {
    if (!ruleModal) return;
    const warn = Number(ruleForm.warnThreshold);
    const danger = Number(ruleForm.dangerThreshold);
    if (Number.isNaN(warn) || Number.isNaN(danger) || warn < 0 || warn > 100 || danger < 0 || danger > 100) {
      showToast('阈值需为 0-100 的数字', 'error');
      return;
    }
    if (warn > danger) {
      showToast('警告阈值不能高于危险阈值', 'error');
      return;
    }
    setSavingRule(true);
    try {
      await put(`/api/notifications/rules/${ruleModal.type}`, {
        enabled: ruleForm.enabled,
        warnThreshold: warn,
        dangerThreshold: danger,
      });
      showToast('规则已更新');
      setRuleModal(null);
      load();
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    } finally {
      setSavingRule(false);
    }
  }, [ruleModal, ruleForm, load, showToast]);

  /**
   * 立即触发一次告警检测
   */
  const runCheck = useCallback(async () => {
    try {
      await post('/api/notifications/check');
      showToast('已触发检测');
      load();
      loadRecords(recordPage);
    } catch (e: any) {
      showToast(e?.message || '检测失败', 'error');
    }
  }, [load, loadRecords, recordPage, showToast]);

  /**
   * 清空告警记录
   */
  const clearRecords = useCallback(async () => {
    try {
      await del('/api/notifications/records');
      showToast('告警记录已清空');
      setRecordPage(1);
      setRecords([]);
      setRecordTotal(0);
    } catch (e: any) {
      showToast(e?.message || '清空失败', 'error');
    }
  }, [showToast]);

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">告警中心</h1>
        <p className="page__desc">配置资源告警规则与通知渠道，合理设置阈值以便及时感知资源异常</p>
      </div>

      {/* 告警规则 */}
      <Card title="告警规则" extra={<Button variant="ghost" size="sm" onClick={load}>刷新</Button>}>
        {ruleLoading ? (
          <SkeletonRows rows={3} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '15%' }}>资源</th>
                <th style={{ width: '15%' }}>状态</th>
                <th style={{ width: '20%' }}>警告阈值</th>
                <th style={{ width: '20%' }}>危险阈值</th>
                <th style={{ width: '15%' }}>当前使用率</th>
                <th style={{ width: '15%' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.type}>
                  <td><strong>{RULE_NAMES[r.type] || r.type}</strong></td>
                  <td>
                    <span className={r.enabled ? 'notify-state notify-state--on' : 'notify-state'}>{r.enabled ? '启用' : '停用'}</span>
                  </td>
                  <td>≥ {r.warnThreshold}%</td>
                  <td>≥ {r.dangerThreshold}%</td>
                  <td className="notify-dim">—</td>
                  <td>
                    <Button variant="ghost" size="sm" onClick={() => openEditRule(r)}>编辑</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 通知渠道 */}
      <Card
        className="notify-card"
        title="通知渠道"
        extra={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={load}>刷新</Button>
            <Button size="sm" onClick={openCreateChannel}>+ 新增渠道</Button>
          </div>
        }
      >
        {channelLoading ? (
          <SkeletonRows rows={3} />
        ) : channels.length === 0 ? (
          <Empty title="暂无通知渠道" description="新增一个渠道（Webhook / 邮件 / 钉钉 / 飞书）接收资源告警。" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '20%' }}>名称</th>
                <th style={{ width: '16%' }}>类型</th>
                <th style={{ width: '12%' }}>状态</th>
                <th style={{ width: '16%' }}>创建时间</th>
                <th style={{ width: '36%' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch) => (
                <tr key={ch.id}>
                  <td><strong>{ch.name}</strong></td>
                  <td>{CHANNEL_LABELS[ch.type] || ch.type}</td>
                  <td>
                    <span className={ch.enabled ? 'notify-state notify-state--on' : 'notify-state'}>
                      {ch.enabled ? '启用' : '停用'}
                    </span>
                  </td>
                  <td className="notify-dim">{formatTime(ch.createdAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Button variant="ghost" size="sm" loading={testingId === ch.id} onClick={() => testChannel(ch)}>
                        测试
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEditChannel(ch)}>编辑</Button>
                      <Button variant="ghost" size="sm" onClick={() => toggleChannel(ch)}>
                        {ch.enabled ? '停用' : '启用'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(ch)}>删除</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 告警记录 */}
      <Card
        className="notify-card"
        title={`告警记录 (${recordTotal})`}
        extra={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setRecordPage(1);
              }}
              style={{ width: 110 }}
            >
              <option value="">全部类型</option>
              <option value="cpu">CPU</option>
              <option value="mem">内存</option>
              <option value="disk">磁盘</option>
              <option value="task">任务</option>
            </Select>
            <Select
              value={levelFilter}
              onChange={(e) => {
                setLevelFilter(e.target.value);
                setRecordPage(1);
              }}
              style={{ width: 110 }}
            >
              <option value="">全部级别</option>
              <option value="warn">警告</option>
              <option value="danger">危险</option>
              <option value="recovery">已恢复</option>
            </Select>
            <Select
              value={pushFilter}
              onChange={(e) => {
                setPushFilter(e.target.value);
                setRecordPage(1);
              }}
              style={{ width: 110 }}
            >
              <option value="">全部推送</option>
              <option value="ok">已推送</option>
              <option value="failed">失败</option>
              <option value="none">未推送</option>
            </Select>
            <Button variant="ghost" size="sm" onClick={runCheck}>立即检测</Button>
            <Button variant="ghost" size="sm" onClick={() => loadRecords(recordPage)}>刷新</Button>
            {records.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearRecords}>清空</Button>
            )}
          </div>
        }
      >
        {recordLoading ? (
          <SkeletonRows rows={4} />
        ) : records.length === 0 ? (
          <Empty title="暂无告警记录" description="资源使用率未超过阈值，或告警服务尚未触发任何事件。" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '12%' }}>时间</th>
                <th style={{ width: '11%' }}>类型</th>
                <th style={{ width: '10%' }}>级别</th>
                <th style={{ width: '33%' }}>消息</th>
                <th style={{ width: '10%' }}>使用率</th>
                <th style={{ width: '11%' }}>推送</th>
                <th style={{ width: '13%' }}>详情</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td className="notify-dim">{formatTime(r.createdAt)}</td>
                  <td>{TYPE_LABELS[r.type] || r.type}</td>
                  <td>
                    <span className={`notify-level notify-level--${r.level}`}>
                      {LEVEL_LABELS[r.level] || r.level}
                    </span>
                  </td>
                  <td>{r.message}</td>
                  <td>{r.value != null ? `${r.value.toFixed(1)}%` : '—'}</td>
                  <td>
                    <span className={`notify-push notify-push--${r.pushStatus}`}>
                      {r.pushStatus === 'ok' ? '已推送' : r.pushStatus === 'failed' ? '失败' : '未推送'}
                    </span>
                  </td>
                  <td className="notify-dim" title={r.pushDetail || ''}>
                    {r.pushDetail || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {recordTotal > PAGE_SIZE && (
          <div className="notify-pager">
            <Button
              variant="ghost"
              size="sm"
              disabled={recordPage <= 1}
              onClick={() => setRecordPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="notify-pager__info">
              {recordPage} / {Math.max(1, Math.ceil(recordTotal / PAGE_SIZE))}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={recordPage >= Math.ceil(recordTotal / PAGE_SIZE)}
              onClick={() => setRecordPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </Card>

      {/* 渠道新增/编辑弹窗 */}
      <Modal
        open={channelModal.open}
        title={channelModal.editing ? '编辑通知渠道' : '新增通知渠道'}
        onClose={() => setChannelModal({ editing: null, open: false })}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setChannelModal({ editing: null, open: false })}>取消</Button>
            <Button loading={saving} onClick={handleSaveChannel}>{channelModal.editing ? '保存' : '创建'}</Button>
          </div>
        }
      >
        <Field label="渠道名称" required>
          <Input
            value={form.name}
            placeholder="如：团队告警群"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>
        <Field label="渠道类型">
          <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as ChannelForm['type'] }))}>
            <option value="webhook">Webhook</option>
            <option value="email">邮件 (SMTP)</option>
            <option value="dingtalk">钉钉机器人</option>
            <option value="feishu">飞书机器人</option>
          </Select>
        </Field>

        {form.type === 'webhook' && (
          <>
            <Field label="Webhook 地址" required>
              <Input
                value={form.url}
                placeholder="https://example.com/hook"
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              />
            </Field>
            <Field label="Secret（可选）" hint={channelModal.editing?.secretsSet.secret ? '已配置，留空则不修改' : '鉴权密钥，随请求以 Bearer 头携带'}>
              <Input
                type="password"
                value={form.secret}
                placeholder={channelModal.editing?.secretsSet.secret ? '••••••' : ''}
                onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
              />
            </Field>
          </>
        )}

        {form.type === 'email' && (
          <>
            <Field label="SMTP 主机" required>
              <Input
                value={form.host}
                placeholder="smtp.qq.com"
                onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
              />
            </Field>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <Field label="端口" required>
                  <Input
                    value={form.port}
                    placeholder="465"
                    onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                  />
                </Field>
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', paddingBottom: 8 }}>
                <label className="notify-checkbox">
                  <input type="checkbox" checked={form.useTls} onChange={(e) => setForm((f) => ({ ...f, useTls: e.target.checked }))} />
                  使用 SSL
                </label>
              </div>
            </div>
            <Field label="账号（可选）">
              <Input
                value={form.username}
                placeholder="账户名/邮箱"
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              />
            </Field>
            <Field label="密码 / 授权码" hint={channelModal.editing?.secretsSet.password ? '已配置，留空则不修改' : 'SMTP 密码或授权码'}>
              <Input
                type="password"
                value={form.password}
                placeholder={channelModal.editing?.secretsSet.password ? '••••••' : ''}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />
            </Field>
            <Field label="发件人地址" required>
              <Input
                value={form.from}
                placeholder="alarm@example.com"
                onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
              />
            </Field>
            <Field label="收件人（逗号分隔）" required>
              <Input
                value={form.to}
                placeholder="a@example.com, b@example.com"
                onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
              />
            </Field>
          </>
        )}

        {form.type === 'dingtalk' && (
          <>
            <Field label="access_token" required>
              <Input
                value={form.accessToken}
                placeholder="机器人 access_token"
                onChange={(e) => setForm((f) => ({ ...f, accessToken: e.target.value }))}
              />
            </Field>
            <Field label="加签密钥 Secret（可选）" hint={channelModal.editing?.secretsSet.secret ? '已配置，留空则不修改' : '开启加签时填写'}>
              <Input
                type="password"
                value={form.secret}
                placeholder={channelModal.editing?.secretsSet.secret ? '••••••' : ''}
                onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
              />
            </Field>
          </>
        )}

        {form.type === 'feishu' && (
          <Field label="Webhook 地址" required>
            <Input
              value={form.webhookUrl}
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"
              onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
            />
          </Field>
        )}

        {formError && <div className="notify-form-error">{formError}</div>}
      </Modal>

      {/* 规则编辑弹窗 */}
      <Modal
        open={!!ruleModal}
        title="编辑告警规则"
        onClose={() => setRuleModal(null)}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setRuleModal(null)}>取消</Button>
            <Button loading={savingRule} onClick={handleSaveRule}>保存</Button>
          </div>
        }
      >
        <Field label="资源类型">
          <Input value={ruleModal ? RULE_NAMES[ruleModal.type] : ''} disabled />
        </Field>
        <Field label="启用规则">
          <label className="notify-checkbox">
            <input
              type="checkbox"
              checked={ruleForm.enabled}
              onChange={(e) => setRuleForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            启用该项资源告警
          </label>
        </Field>
        <Field label="警告阈值（%）" required>
          <Input
            value={ruleForm.warnThreshold}
            onChange={(e) => setRuleForm((f) => ({ ...f, warnThreshold: e.target.value }))}
          />
        </Field>
        <Field label="危险阈值（%）" required>
          <Input
            value={ruleForm.dangerThreshold}
            onChange={(e) => setRuleForm((f) => ({ ...f, dangerThreshold: e.target.value }))}
          />
        </Field>
      </Modal>

      {/* 删除渠道确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除通知渠道"
        message={`确定删除通知渠道「${deleteTarget?.name ?? ''}」吗？删除后该渠道将不再接收告警。`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
