/**
 * 审批中心页面（高危操作审批流）
 *
 * - 管理员：查看全部审批，批准（立即执行）/ 拒绝
 * - 其他用户：查看自己提交的审批，可撤销待审批记录
 * - 状态筛选 + 摘要统计
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Empty from '../components/Empty';
import ConfirmDialog from '../components/ConfirmDialog';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import './approvals.less';

/** 审批状态 */
type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** 审批记录（后端返回 snake_case） */
interface ApprovalItem {
  id: number;
  username: string;
  action_type: string;
  target: string;
  payload: string;
  status: ApprovalStatus;
  reason: string;
  result: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

/** 动作类型中文名 */
const ACTION_LABELS: Record<string, string> = {
  'container.delete': '删除容器',
  'image.delete': '删除镜像',
  'volume.delete': '删除卷',
  'network.prune': '清理网络',
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

/** 审批中心页面入口 */
export default function Approvals() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [admin, setAdmin] = useState(false);
  const [status, setStatus] = useState<ApprovalStatus | ''>('');
  const [me, setMe] = useState('');
  const [rejectTarget, setRejectTarget] = useState<ApprovalItem | null>(null);

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
      showToast(e?.message || '加载审批列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [status, showToast]);

  useEffect(() => {
    load();
  }, [load]);

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
      if (r.executed) showToast(`已批准并执行成功`, 'success');
      else showToast(`已批准，但执行失败：${r.error || '未知错误'}`, 'error');
      load();
    } catch (e: any) {
      showToast(e?.message || '批准失败', 'error');
    }
  }

  /** 拒绝（管理员） */
  async function reject() {
    if (!rejectTarget) return;
    try {
      await post(`/api/approvals/${rejectTarget.id}/reject`, { reason: '管理员拒绝' });
      showToast('已拒绝该审批', 'info');
      setRejectTarget(null);
      load();
    } catch (e: any) {
      showToast(e?.message || '拒绝失败', 'error');
    }
  }

  /** 撤销（提交人或管理员） */
  async function cancel(item: ApprovalItem) {
    try {
      await del(`/api/approvals/${item.id}`);
      showToast('已撤销', 'info');
      load();
    } catch (e: any) {
      showToast(e?.message || '撤销失败', 'error');
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
            {f.label}
            {f.value && items.length > 0 ? '' : ''}
          </Button>
        ))}
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          刷新
        </Button>
        <span className="approvals-page__hint">
          开启设置中心「高危操作审批流」后，非管理员的容器删除将自动转入此处待审批
        </span>
      </div>

      {/* 摘要 */}
      <div className="approvals-page__summary">
        {STATUS_FILTERS.filter((f) => f.value).map((f) => (
          <div key={f.value} className={`approvals-stat approvals-stat--${f.value}`}>
            <div className="approvals-stat__value">{counts[f.value as ApprovalStatus]}</div>
            <div className="approvals-stat__label">{f.label}</div>
          </div>
        ))}
      </div>

      <Card title={`审批记录（${items.length}）`}>
        {loading && items.length === 0 ? (
          <SkeletonRows rows={4} />
        ) : items.length === 0 ? (
          <Empty kind="empty" title="暂无审批记录" />
        ) : (
          <table className="approvals-table">
            <thead>
              <tr>
                <th style={{ width: '5%' }}>#</th>
                <th style={{ width: '10%' }}>提交人</th>
                <th style={{ width: '12%' }}>动作</th>
                <th style={{ width: '20%' }}>目标</th>
                <th style={{ width: '10%' }}>状态</th>
                <th>结果 / 说明</th>
                <th style={{ width: '14%' }}>提交时间</th>
                <th style={{ width: '16%' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const own = it.username === me;
                return (
                  <tr key={it.id}>
                    <td>{it.id}</td>
                    <td>{it.username}</td>
                    <td>{ACTION_LABELS[it.action_type] || it.action_type}</td>
                    <td className="approvals-table__target" title={it.target}>
                      {it.target}
                    </td>
                    <td>
                      <span className={`approvals-badge approvals-badge--${it.status}`}>
                        {STATUS_LABEL[it.status]}
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
                              批准
                            </Button>
                            <Button variant="danger" size="sm" onClick={() => setRejectTarget(it)}>
                              拒绝
                            </Button>
                          </>
                        )}
                        {it.status === 'pending' && (own || admin) && (
                          <Button variant="ghost" size="sm" onClick={() => cancel(it)}>
                            撤销
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

      <ConfirmDialog
        open={!!rejectTarget}
        title="拒绝审批"
        message={`确定拒绝「${rejectTarget ? ACTION_LABELS[rejectTarget.action_type] || rejectTarget.action_type : ''} ${rejectTarget?.target || ''}」的申请吗？`}
        confirmText="拒绝"
        danger
        onConfirm={reject}
        onCancel={() => setRejectTarget(null)}
      />
    </div>
  );
}
