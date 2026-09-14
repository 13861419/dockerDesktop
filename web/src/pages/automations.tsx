/**
 * 事件自动化页（1.61.0）：Docker 事件 → 动作规则管理与触发历史
 */
import { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import { Field, Input, Select } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, put, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { translateNow as t } from '../i18n';
import './automations.less';

/** 常见事件类型预设 */
const EVENT_PRESETS = [
  { value: 'container.die', label: '容器退出 (container.die)' },
  { value: 'container.oom', label: '内存溢出 OOM (container.oom)' },
  { value: 'container.health_status', label: '健康检查异常 (health_status)' },
  { value: 'container.destroy', label: '容器被删除 (container.destroy)' },
  { value: 'image.pull', label: '镜像拉取完成 (image.pull)' },
];

interface AutomationRule {
  id: number;
  name: string;
  enabled: boolean;
  eventType: string;
  matchContainer: string;
  matchImage: string;
  action: string;
  actionParams: { url?: string; secret?: string };
  cooldownSec: number;
  lastTriggeredAt: number | null;
  triggerCount: number;
  createdAt: number;
}

interface AutomationEvent {
  rule_id: number;
  rule_name: string;
  event_type: string;
  container: string;
  image: string;
  action: string;
  detail: string;
  ok: number;
  created_at: number;
}

/** 空白表单 */
function emptyForm() {
  return { name: '', eventType: 'container.die', matchContainer: '', matchImage: '', action: 'restart', url: '', secret: '', cooldownSec: 300 };
}

export default function AutomationsPage() {
  const { showToast } = useToast();
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [events, setEvents] = useState<AutomationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        get<{ rules: AutomationRule[] }>('/api/automations'),
        get<{ events: AutomationEvent[] }>('/api/automations/events?limit=50'),
      ]);
      setRules(r1.rules || []);
      setEvents(r2.events || []);
    } catch (e: any) {
      showToast(e?.message || t('加载失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /** 打开新建弹窗 */
  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm(emptyForm());
    setModalOpen(true);
  }, []);

  /** 打开编辑弹窗 */
  const openEdit = useCallback((r: AutomationRule) => {
    setEditingId(r.id);
    setForm({
      name: r.name,
      eventType: r.eventType,
      matchContainer: r.matchContainer,
      matchImage: r.matchImage,
      action: r.action,
      url: r.actionParams?.url || '',
      secret: '',
      cooldownSec: r.cooldownSec,
    });
    setModalOpen(true);
  }, []);

  /** 保存（新建或更新） */
  const save = useCallback(async () => {
    if (!form.name.trim()) {
      showToast(t('请填写规则名称'), 'error');
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name,
        eventType: form.eventType,
        matchContainer: form.matchContainer,
        matchImage: form.matchImage,
        action: form.action,
        cooldownSec: Number(form.cooldownSec) || 300,
        actionParams: form.action === 'webhook' ? { url: form.url, secret: form.secret } : {},
      };
      if (editingId != null) {
        await put(`/api/automations/${editingId}`, body);
      } else {
        await post('/api/automations', body);
      }
      showToast(t('已保存'));
      setModalOpen(false);
      load();
    } catch (e: any) {
      showToast(e?.message || t('保存失败'), 'error');
    } finally {
      setSaving(false);
    }
  }, [form, editingId, showToast, load]);

  /** 启停切换 */
  const toggle = useCallback(
    async (r: AutomationRule) => {
      try {
        await put(`/api/automations/${r.id}/enabled`, { enabled: !r.enabled });
        load();
      } catch (e: any) {
        showToast(e?.message || t('操作失败'), 'error');
      }
    },
    [showToast, load],
  );

  /** 删除规则 */
  const remove = useCallback(
    async (r: AutomationRule) => {
      try {
        await del(`/api/automations/${r.id}`);
        showToast(t('已删除'));
        load();
      } catch (e: any) {
        showToast(e?.message || t('删除失败'), 'error');
      }
    },
    [showToast, load],
  );

  const canManage = isAdmin();
  const actionLabel: Record<string, string> = { restart: '重启', stop: '停止', start: '启动', webhook: 'Webhook' };
  const eventLabel = (v: string) => EVENT_PRESETS.find((p) => p.value === v)?.label || v;

  return (
    <div className="automations-page">
      <Card
        title={t('事件自动化')}
        extra={
          canManage && (
            <Button variant="primary" size="sm" onClick={openCreate}>
              {t('新建规则')}
            </Button>
          )
        }
      >
        {loading ? (
          <SkeletonRows rows={6} />
        ) : rules.length === 0 ? (
          <Empty title={t('暂无规则')} description="订阅 Docker 事件（容器退出 / OOM / 健康检查异常等）并自动执行动作。" />
        ) : (
          <div className="automations-table-wrap">
            <table className="automations-table">
              <thead>
                <tr>
                  <th>{t('名称')}</th>
                  <th>{t('事件')}</th>
                  <th>{t('匹配')}</th>
                  <th>{t('动作')}</th>
                  <th>{t('冷却')}</th>
                  <th>{t('触发次数')}</th>
                  <th>{t('最近触发')}</th>
                  {canManage && <th>{t('操作')}</th>}
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className={r.enabled ? '' : 'automations-row--disabled'}>
                    <td>{r.name}</td>
                    <td>{eventLabel(r.eventType)}</td>
                    <td>{[r.matchContainer && `容器≈${r.matchContainer}`, r.matchImage && `镜像≈${r.matchImage}`].filter(Boolean).join('，') || t('全部')}</td>
                    <td>{actionLabel[r.action] || r.action}</td>
                    <td>{r.cooldownSec}s</td>
                    <td>{r.triggerCount}</td>
                    <td>{r.lastTriggeredAt ? new Date(r.lastTriggeredAt).toLocaleString() : '—'}</td>
                    {canManage && (
                      <td>
                        <div className="automations-table__actions">
                          <label className="automations-switch" title={r.enabled ? t('点击禁用') : t('点击启用')}>
                            <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} />
                            <span />
                          </label>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>
                            {t('编辑')}
                          </Button>
                          <Button variant="danger" size="sm" onClick={() => remove(r)}>
                            {t('删除')}
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={t('触发历史')} extra={<Button variant="ghost" size="sm" onClick={load}>{t('刷新')}</Button>}>
        {events.length === 0 ? (
          <Empty title={t('暂无触发记录')} description="规则命中事件后，执行结果会记录在此。" />
        ) : (
          <div className="automations-table-wrap">
            <table className="automations-table">
              <thead>
                <tr>
                  <th>{t('时间')}</th>
                  <th>{t('规则')}</th>
                  <th>{t('事件')}</th>
                  <th>{t('容器')}</th>
                  <th>{t('动作')}</th>
                  <th>{t('结果')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i}>
                    <td>{new Date(e.created_at).toLocaleString()}</td>
                    <td>{e.rule_name}</td>
                    <td>{e.event_type}</td>
                    <td>{e.container}</td>
                    <td>{e.action}</td>
                    <td className={e.ok ? 'automations-ok' : 'automations-fail'}>{e.ok ? '✓' : '✕'} {e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 新建 / 编辑规则弹窗 */}
      <Modal
        open={modalOpen}
        title={editingId != null ? t('编辑规则') : t('新建规则')}
        onClose={() => setModalOpen(false)}
        width={520}
        footer={
          <div className="automations-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setModalOpen(false)}>
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" loading={saving} onClick={save}>
              {t('保存')}
            </Button>
          </div>
        }
      >
        <Field label={t('规则名称')}>
          <Input value={form.name} placeholder={t('例如：app 崩溃自动重启')} onChange={(e: any) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t('触发事件')} hint={t('匹配 Docker 事件类型与动作前缀')}>
          <Select value={form.eventType} onChange={(e: any) => setForm({ ...form, eventType: e.target.value })}>
            {EVENT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('容器名包含')} hint={t('留空匹配全部容器')}>
          <Input value={form.matchContainer} placeholder="web" onChange={(e: any) => setForm({ ...form, matchContainer: e.target.value })} />
        </Field>
        <Field label={t('镜像名包含')} hint={t('留空匹配全部镜像')}>
          <Input value={form.matchImage} placeholder="nginx" onChange={(e: any) => setForm({ ...form, matchImage: e.target.value })} />
        </Field>
        <Field label={t('执行动作')}>
          <Select value={form.action} onChange={(e: any) => setForm({ ...form, action: e.target.value })}>
            <option value="restart">重启容器</option>
            <option value="stop">停止容器</option>
            <option value="start">启动容器</option>
            <option value="webhook">Webhook 通知</option>
          </Select>
        </Field>
        {form.action === 'webhook' && (
          <>
            <Field label="Webhook URL">
              <Input value={form.url} placeholder="https://example.com/hook" onChange={(e: any) => setForm({ ...form, url: e.target.value })} />
            </Field>
            <Field label={t('校验头（可选）')} hint="X-Automation-Secret 请求头值">
              <Input value={form.secret} onChange={(e: any) => setForm({ ...form, secret: e.target.value })} />
            </Field>
          </>
        )}
        <Field label={t('冷却期（秒）')} hint={t('同一规则在冷却窗口内不重复触发，防止事件风暴')}>
          <Input type="number" value={form.cooldownSec} min={10} onChange={(e: any) => setForm({ ...form, cooldownSec: e.target.value })} />
        </Field>
      </Modal>
    </div>
  );
}
