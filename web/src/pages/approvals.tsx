/**
 * 审批中心页面（高危操作审批流）
 *
 * - 管理员：查看全部审批，批准（立即执行）/ 拒绝
 * - 其他用户：查看自己提交的审批，可撤销待审批记录
 * - 状态筛选 + 摘要统计 + 送达统计卡片
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del, download } from '../api/client';
import { translateNow as t } from '../i18n';
import './approvals.less';

/** 审批状态 */
type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** 审批记录（后端返回 snake_case） */
interface ApprovalItem {
  id: number;
  username: string;
  action_type: string;
  target: string;
  /** 展示用目标标签（容器名等人类可读标识，后端解析） */
  target_label?: string;
  payload: string;
  status: ApprovalStatus;
  reason: string;
  result: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

/** 审批统计（GET /api/approvals/stats 响应） */
interface ApprovalStats {
  totals: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
    executedOk: number;
    executedFail: number;
  };
  byAction: Array<{ actionType: string; label: string; total: number; approved: number; rejected: number; pending: number }>;
  byUser: Array<{ username: string; total: number; approved: number; rejected: number; pending: number }>;
}

/** 动作类型中文名 */
const ACTION_LABELS: Record<string, string> = {
  'container.delete': '删除容器',
  'image.delete': '删除镜像',
  'image.deleteBatch': '批量删除镜像',
  'image.prune': '清理悬空镜像',
  'volume.delete': '删除卷',
  'volume.prune': '清理未使用卷',
  'network.prune': '清理网络',
  'compose.down': '停止编排项目',
  'container.fix': '修复容器配置',
};

/** 状态中文名与样式 */
const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  cancelled: '已撤销',
};

const STATUS_FILTERS: Array<{ value: ApprovalStatus | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待审批' },
  { value: 'approved', label: '已批准' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'cancelled', label: '已撤销' },
];

/** 格式化时间 */
function formatTime(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}

/** 解析 payload JSON */
function parsePayload(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/** 审批中心页面入口 */
export default function Approvals() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [admin, setAdmin] = useState(false);
  const [status, setStatus] = useState<ApprovalStatus | ''>('');
  const [me, setMe] = useState('');
  /** 批量选择（仅 pending 可选） */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  /** 拒绝理由弹窗：单条或批量 */
  const [rejectInput, setRejectInput] = useState<{ ids: number[]; label: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  /** 审批统计（近 30 天） */
  const [stats, setStats] = useState<ApprovalStats | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await get<{ items: ApprovalItem[]; isAdmin: boolean }>(
        '/api/approvals',
        status ? { status } : undefined,
      );
      setItems(resp.items || []);
      setAdmin(resp.isAdmin);
      // 从自身提交记录推断当前用户名（列表已按角色过滤）
      const meResp = await get<{ username: string }>('/api/auth/me').catch(() => null);
      if (meResp?.username) setMe(meResp.username);
    } catch (e: any) {
      showToast(e?.message || t('加载审批列表失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [status, showToast]);

  /** 加载审批统计（仅管理员；统计口径为全部审批） */
  const loadStats = useCallback(async () => {
    try {
      const res = await get<ApprovalStats>('/api/approvals/stats?days=30');
      setStats(res);
    } catch {
      // 统计失败不影响主界面
    }
  }, []);

  useEffect(() => {
    load();
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  /** 按当前状态过滤导出审批记录 CSV */
  const exportCsv = useCallback(async () => {
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      await download(`/api/approvals/export${qs}`, 'approvals.csv');
      showToast(t('审批记录已导出'));
    } catch (e: any) {
      showToast(e?.message || t('导出失败：{{v1}}', { v1: e?.message || '' }), 'error');
    }
  }, [status, showToast]);

  /** 摘要统计（基于当前列表） */
  const counts = useMemo(() => {
    const c: Record<ApprovalStatus, number> = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const it of items) c[it.status] += 1;
    return c;
  }, [items]);

  /** 批准（管理员） */
  async function approve(item: ApprovalItem) {
    try {
      const r = await post<{ ok: boolean; executed: boolean; error?: string }>(`/api/approvals/${item.id}/approve`);
      if (r.executed) showToast(t('已批准并执行成功'), 'success');
      else showToast(t('已批准，但执行失败：{{v1}}', { v1: r.error || t('未知错误') }), 'error');
      load();
    } catch (e: any) {
      showToast(e?.message || t('批准失败'), 'error');
    }
  }

  /** 批量批准/拒绝（管理员） */
  async function batchDecide(decision: 'approved' | 'rejected') {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      const r = await post<{ ok: number; fail: number }>('/api/approvals/batch', { ids, decision });
      showToast(
        t('批量处理完成：成功 {{ok}} 条{{failPart}}', {
          ok: r.ok,
          failPart: r.fail ? t('，失败 {{n}} 条', { n: r.fail }) : '',
        }),
        r.fail ? 'info' : 'success',
      );
      setSelected(new Set());
      load();
      loadStats();
    } catch (e: any) {
      showToast(e?.message || t('批量处理失败'), 'error');
    } finally {
      setBatchBusy(false);
    }
  }

  /** 勾选/取消单个待审批记录 */
  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 全选/清空当前列表中的待审批项 */
  const pendingIds = items.filter((it) => it.status === 'pending').map((it) => it.id);
  const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));
  function toggleAll() {
    setSelected((prev) => (allSelected ? new Set() : new Set(pendingIds)));
  }

  /** 状态筛选变化时清空选择 */
  useEffect(() => {
    setSelected(new Set());
  }, [status]);

  /** 提交拒绝理由弹窗（单条或批量共用） */
  function submitReject() {
    if (!rejectInput) return;
    const reason = rejectReason.trim();
    if (!reason) {
      showToast(t('请填写拒绝理由'), 'error');
      return;
    }
    setBatchBusy(true);
    post<{ ok: number; fail: number }>('/api/approvals/batch', { ids: rejectInput.ids, decision: 'rejected', reason })
      .then((r) => {
        showToast(
          t('已拒绝 {{ok}} 条审批{{failPart}}', {
            ok: r.ok,
            failPart: r.fail ? t('，失败 {{n}} 条', { n: r.fail }) : '',
          }),
          r.fail ? 'info' : 'success',
        );
        setSelected(new Set());
        setRejectInput(null);
        setRejectReason('');
        load();
        loadStats();
      })
      .catch((e: any) => showToast(e?.message || t('拒绝失败'), 'error'))
      .finally(() => setBatchBusy(false));
  }

  /** 撤销（提交人或管理员） */
  async function cancel(item: ApprovalItem) {
    try {
      await del(`/api/approvals/${item.id}`);
      showToast(t('已撤销'), 'info');
      load();
      loadStats();
    } catch (e: any) {
      showToast(e?.message || t('撤销失败'), 'error');
    }
  }

  return (
    <div className="approvals-page">
      <div className="approvals-page__toolbar">
        {STATUS_FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={status === f.value ? 'primary' : 'ghost'}
            onClick={() => setStatus(f.value)}
          >
            {t(f.label)}
            {f.value && items.length > 0 ? '' : ''}
          </Button>
        ))}
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          {t('刷新')}
        </Button>
        <Button variant="ghost" size="sm" onClick={exportCsv}>
          {t('导出CSV')}
        </Button>
        {admin && pendingIds.length > 0 && (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={selected.size === 0 || batchBusy}
              loading={batchBusy}
              onClick={() => batchDecide('approved')}
            >
              {t('批量批准')}{selected.size ? t('（{{n}}）', { n: selected.size }) : ''}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={selected.size === 0}
              onClick={() => {
                setRejectReason('');
                setRejectInput({ ids: [...selected], label: t('选中的 {{n}} 条待审批记录', { n: selected.size }) });
              }}
            >
              {t('批量拒绝')}{selected.size ? t('（{{n}}）', { n: selected.size }) : ''}
            </Button>
          </>
        )}
        <span className="approvals-page__hint">
          {t('开启设置中心「高危操作审批流」后，非管理员的容器删除将自动转入此处待审批')}
        </span>
      </div>

      {/* 摘要 */}
      <div className="approvals-page__summary">
        {STATUS_FILTERS.filter((f) => f.value).map((f) => (
          <div key={f.value} className={`approvals-stat approvals-stat--${f.value}`}>
            <div className="approvals-stat__value">{counts[f.value as ApprovalStatus]}</div>
            <div className="approvals-stat__label">{t(f.label)}</div>
          </div>
        ))}
      </div>

      {/* 审批统计（仅管理员） */}
      {admin && stats && (
        <Card title={t('审批统计（近 {{days}} 天）', { days: 30 })}>
          <div className="approvals-page__summary" style={{ marginBottom: 12 }}>
            <div className="approvals-stat approvals-stat--approved">
              <div className="approvals-stat__value">{stats.totals.executedOk}</div>
              <div className="approvals-stat__label">{t('执行成功')}</div>
            </div>
            <div className="approvals-stat approvals-stat--rejected">
              <div className="approvals-stat__value">{stats.totals.executedFail}</div>
              <div className="approvals-stat__label">{t('执行失败')}</div>
            </div>
          </div>
          {stats.byAction.length === 0 ? (
            <Empty kind="empty" title={t('暂无审批记录')} />
          ) : (
            <>
              <table className="approvals-table">
                <thead>
                  <tr>
                    <th style={{ width: '34%' }}>{t('动作')}</th>
                    <th style={{ width: '14%' }}>{t('总数')}</th>
                    <th style={{ width: '14%' }}>{t('已批准')}</th>
                    <th style={{ width: '14%' }}>{t('已拒绝')}</th>
                    <th>{t('待审批')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byAction.map((a) => (
                    <tr key={a.actionType}>
                      <td><strong>{t(a.label)}</strong></td>
                      <td>{a.total}</td>
                      <td>{a.approved}</td>
                      <td>{a.rejected}</td>
                      <td>{a.pending}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {stats.byUser.length > 0 && (
                <div style={{ marginTop: 10 }} className="notify-dim">
                  {t('提交人 Top：{{list}}', {
                    list: stats.byUser
                      .slice(0, 5)
                      .map((u) => `${u.username}(${u.total})`)
                      .join('、'),
                  })}
                </div>
              )}
            </>
          )}
        </Card>
      )}

      <Card title={t('审批记录（{{n}}）', { n: items.length })}>
        {loading && items.length === 0 ? (
          <SkeletonRows rows={4} />
        ) : items.length === 0 ? (
          <Empty kind="empty" title={t('暂无审批记录')} />
        ) : (
          <table className="approvals-table">
            <thead>
              <tr>
                {admin && pendingIds.length > 0 && (
                  <th style={{ width: '4%' }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} title={t('全选待审批')} />
                  </th>
                )}
                <th style={{ width: '5%' }}>#</th>
                <th style={{ width: '10%' }}>{t('提交人')}</th>
                <th style={{ width: '12%' }}>{t('动作')}</th>
                <th style={{ width: '20%' }}>{t('目标')}</th>
                <th style={{ width: '10%' }}>{t('状态')}</th>
                <th>{t('结果 / 说明')}</th>
                <th style={{ width: '14%' }}>{t('提交时间')}</th>
                <th style={{ width: '16%' }}>{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const own = it.username === me;
                return (
                  <tr key={it.id}>
                    {admin && pendingIds.length > 0 && (
                      <td>
                        <input
                          type="checkbox"
                          disabled={it.status !== 'pending'}
                          checked={it.status === 'pending' && selected.has(it.id)}
                          onChange={() => toggle(it.id)}
                        />
                      </td>
                    )}
                    <td>{it.id}</td>
                    <td>{it.username}</td>
                    <td>{t(ACTION_LABELS[it.action_type] || it.action_type)}</td>
                    <td className="approvals-table__target" title={it.target}>
                      <div className="approvals-table__target-main">{it.target_label || it.target}</div>
                      {/* 目标为 ID（与展示名不同）时，附加短 ID 便于核对 */}
                      {it.target_label && it.target_label !== it.target && (
                        <div className="approvals-table__target-sub">{it.target.slice(0, 12)}</div>
                      )}
                      {/* 待审批时展示执行参数，便于审批人判断 */}
                      {it.status === 'pending' &&
                        (() => {
                          const p = parsePayload(it.payload);
                          const flags: string[] = [];
                          if (p.force) flags.push(t('强制删除'));
                          if (p.v) flags.push(t('同时删除卷'));
                          return flags.length > 0 ? (
                            <div className="approvals-table__payload">{flags.join(' / ')}</div>
                          ) : null;
                        })()}
                    </td>
                    <td>
                      <span className={`approvals-badge approvals-badge--${it.status}`}>
                        {t(STATUS_LABEL[it.status])}
                      </span>
                    </td>
                    <td className="approvals-table__result">
                      {it.status === 'pending'
                        ? it.reason
                        : it.result || it.reason || '-'}
                      {it.decided_by ? ` — ${it.decided_by}` : ''}
                    </td>
                    <td>{formatTime(it.created_at)}</td>
                    <td>
                      <div className="approvals-table__ops">
                        {admin && it.status === 'pending' && (
                          <>
                            <Button variant="primary" size="sm" onClick={() => approve(it)}>
                              {t('批准')}
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => {
                                setRejectReason('');
                                setRejectInput({
                                  ids: [it.id],
                                  label: t('「{{action}} {{target}}」的申请', {
                                    action: t(ACTION_LABELS[it.action_type] || it.action_type),
                                    target: it.target_label || it.target,
                                  }),
                                });
                              }}
                            >
                              {t('拒绝')}
                            </Button>
                          </>
                        )}
                        {it.status === 'pending' && (own || admin) && (
                          <Button variant="ghost" size="sm" onClick={() => cancel(it)}>
                            {t('撤销')}
                          </Button>
                        )}
                        {it.status !== 'pending' && <span className="approvals-table__done">—</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* 拒绝理由弹窗（单条与批量共用，理由必填） */}
      {rejectInput && (
        <div className="approvals-page__overlay" onClick={() => setRejectInput(null)}>
          <div className="approvals-page__dialog" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <div className="approvals-page__dialog-title">{t('拒绝审批')}</div>
            <div className="approvals-page__dialog-text">{t('确定拒绝 {{v1}} 吗？', { v1: rejectInput.label })}</div>
            <textarea
              className="approvals-page__textarea"
              placeholder={t('请填写拒绝理由（必填，将随审批留痕并通知提交人）')}
              value={rejectReason}
              rows={3}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRejectReason(e.target.value)}
              autoFocus
            />
            <div className="approvals-page__dialog-ops">
              <Button variant="ghost" size="sm" onClick={() => setRejectInput(null)}>
                {t('取消')}
              </Button>
              <Button variant="danger" size="sm" loading={batchBusy} onClick={submitReject}>
                {t('确认拒绝')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
