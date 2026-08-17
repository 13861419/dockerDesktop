/**
 * 容器启动编排页
 *
 * 用于为容器配置"启动依赖"（需先启动的其它容器）并对全部启用编排的容器执行
 * 一键启动 / 停止 / 重启。后端按依赖做拓扑排序并分轮执行：
 *  - 加载 /api/containers?all=true（容器列表）与 /api/orchestrate/dependencies（依赖配置）合并展示；
 *  - 启用开关 / 编辑依赖均通过 /api/orchestrate/dependencies 接口持久化；
 *  - 一键动作调用 /api/orchestrate/{start|stop|restart}，完成后以弹窗展示拓扑顺序、分轮结果与最终汇总，
 *    若检测到依赖环则显著警示。
 * 仅管理员可进入（路由级 RequireAdmin + 页面内 isAdmin 控制写操作）。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post, put, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { ContainerListItem } from '../types';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import StatusBadge from '../components/StatusBadge';
import './orchestrates.less';

/** 单容器依赖配置项（对齐 /api/orchestrate/dependencies 返回结构） */
interface DepEntry {
  containerId: string;
  name: string;
  deps: string[];
  depNames: string[];
  enabled: boolean;
}

/** 依赖配置接口返回结构 */
interface DepResponse {
  containers: Record<string, string>;
  dependencies: DepEntry[];
}

/** 编排操作单容器执行项 */
interface OrchestrateItem {
  id: string;
  name: string;
  action: string;
  ok: boolean;
  error?: string;
}

/** 编排操作单轮结果 */
interface OrchestrateRound {
  round: number;
  total: number;
  started: number;
  skipped: number;
  failed: number;
  items: OrchestrateItem[];
}

/** 单个执行阶段（启动 / 停止，或重启内的 stop / start 段）载荷 */
interface PhasePayload {
  ok: boolean;
  action: string;
  order: { id: string; name: string }[];
  rounds: OrchestrateRound[];
  success: number;
  fail: number;
  skipped: number;
  cycle?: string;
  error?: string;
}

/** 重启接口返回结构（嵌套 stop / start 两阶段） */
interface RestartResult {
  ok: boolean;
  stop?: PhasePayload;
  start?: PhasePayload;
  success: number;
  fail: number;
  skipped: number;
  error?: string;
}

/** 编排结果弹窗：统一规整后的阶段对象 */
interface OrchestratePhase {
  label: string;
  ok: boolean;
  error?: string;
  cycle?: string;
  order: { id: string; name: string }[];
  rounds: OrchestrateRound[];
  success: number;
  fail: number;
  skipped: number;
}

/** 编排结果（含最终汇总与阶段列表） */
interface OrchestrateResult {
  ok: boolean;
  error?: string;
  phases: OrchestratePhase[];
  summary: { success: number; fail: number; skipped: number };
}

/** 历史记录中单次执行对应的阶段定义（start/stop 单阶段或 restart 的 stop/start 段） */
interface HistoryPhase {
  label: string;
  ok: boolean;
  action: string;
  order: { id: string; name: string }[];
  rounds: OrchestrateRound[];
  success: number;
  fail: number;
  skipped: number;
  error?: string;
  cycle?: string;
}

/** 单条编排历史记录（对齐 /api/orchestrate/history 返回结构） */
interface HistoryItem {
  id: number;
  action: 'start' | 'stop' | 'restart';
  startedAt: number;
  durationMs: number;
  success: number;
  fail: number;
  skipped: number;
  error?: string | null;
  detail: any | null;
}

/** 历史记录分页响应结构 */
interface HistoryResponse {
  items: HistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 重试接口（POST /api/orchestrate/retry）返回结构 */
interface RetryResponse {
  ok: boolean;
  action: string;
  total: number;
  success: number;
  fail: number;
  items: OrchestrateItem[];
}

/** 重试项：单个失败容器的动作与 id */
interface RetryEntry {
  id: string;
  name: string;
  action: 'start' | 'stop';
}

/**
 * 从容器 Names 中提取显示名（去前导斜杠）
 * @param c 容器项
 * @returns 容器显示名
 */
function displayName(c: ContainerListItem): string {
  return (c.Names && c.Names[0]?.replace(/^\//, '')) || c.Id;
}

/**
 * 容器启动编排页组件
 */
export default function OrchestratePage() {
  const { showToast } = useToast();
  // 仅管理员可修改依赖配置与执行编排（页面外层已用 RequireAdmin 包裹）
  const canManage = isAdmin();

  // 容器列表与依赖配置
  const [list, setList] = useState<ContainerListItem[]>([]);
  // 依赖配置：containerId -> 配置项
  const [depMap, setDepMap] = useState<Record<string, DepEntry>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // 启用开关切换中对应的容器 id（用于按钮 loading）
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // 编辑依赖弹窗状态
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: string; name: string; deps: string[] } | null>(null);
  const [editDeps, setEditDeps] = useState<string[]>([]);
  const [editSaving, setEditSaving] = useState(false);

  // 一键编排执行状态与结果
  const [runningAction, setRunningAction] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [result, setResult] = useState<OrchestrateResult | null>(null);

  // 编排历史弹窗状态
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<HistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  // 展开的历史记录 id 集合
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  // 当前正在重试的历史记录 id 与对应重试确认弹窗数据
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [retryConfirm, setRetryConfirm] = useState<{ item: HistoryItem; entries: RetryEntry[] } | null>(null);
  const [retrySaving, setRetrySaving] = useState(false);

  /** 历史分页每页条数 */
  const HISTORY_PAGE_SIZE = 20;

  /**
   * 拉取依赖配置并合并到状态
   */
  const loadDeps = useCallback(async () => {
    try {
      const res = await get<DepResponse>('/api/orchestrate/dependencies');
      const map: Record<string, DepEntry> = {};
      (res?.dependencies || []).forEach((d) => {
        map[d.containerId] = d;
      });
      setDepMap(map);
    } catch {
      // 依赖配置拉取失败不阻塞容器列表展示
      setDepMap({});
    }
  }, []);

  /**
   * 拉取容器列表与依赖配置
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<ContainerListItem[]>('/api/containers', { all: true });
      setList(res || []);
      setLoadError('');
      await loadDeps();
    } catch (e: any) {
      setLoadError(e?.message || '获取容器列表失败');
      showToast(e?.message || '获取容器列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [loadDeps, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 刷新列表并提示
   */
  const handleRefresh = async () => {
    await load();
    showToast('已刷新');
  };

  /**
   * 切换容器"启用编排"开关
   * @param id 容器 id
   * @param name 容器名
   * @param enabled 目标启用状态
   */
  const toggleEnabled = async (id: string, name: string, enabled: boolean) => {
    if (!canManage) {
      showToast('仅管理员可修改编排配置', 'error');
      return;
    }
    // 未配置过的容器首次开启时 deps 为空数组
    const current = depMap[id];
    const deps = current?.deps || [];
    setTogglingId(id);
    try {
      await put(`/api/orchestrate/dependencies/${id}`, { deps, enabled });
      showToast(`已${enabled ? '启用' : '停用'}「${name}」的启动编排`);
      await loadDeps();
    } catch (e: any) {
      showToast(e?.message || '更新编排配置失败', 'error');
      await loadDeps();
    } finally {
      setTogglingId(null);
    }
  };

  /**
   * 打开"编辑依赖"弹窗，回填当前依赖
   * @param id 容器 id
   * @param name 容器名
   */
  const openEdit = (id: string, name: string) => {
    if (!canManage) {
      showToast('仅管理员可编辑依赖配置', 'error');
      return;
    }
    const current = depMap[id];
    const deps = (current?.deps || []).slice();
    setEditTarget({ id, name, deps });
    setEditDeps(deps);
    setEditOpen(true);
  };

  /**
   * 保存编辑的依赖列表；未配置过时保存同时启用该容器
   */
  const confirmEdit = async () => {
    if (!editTarget) return;
    if (!canManage) {
      showToast('仅管理员可编辑依赖配置', 'error');
      setEditOpen(false);
      return;
    }
    // 已配置过则保持原启用状态，否则首次保存视为启用
    const current = depMap[editTarget.id];
    const enabled = current ? current.enabled : true;
    setEditSaving(true);
    try {
      await put(`/api/orchestrate/dependencies/${editTarget.id}`, { deps: editDeps, enabled });
      showToast(`已保存「${editTarget.name}」的依赖配置`);
      setEditOpen(false);
      await loadDeps();
    } catch (e: any) {
      showToast(e?.message || '保存依赖配置失败', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  /**
   * 清除（删除）指定容器的依赖配置
   */
  const clearEdit = async () => {
    if (!editTarget) return;
    if (!canManage) {
      showToast('仅管理员可清除依赖配置', 'error');
      setEditOpen(false);
      return;
    }
    setEditSaving(true);
    try {
      await del(`/api/orchestrate/dependencies/${editTarget.id}`);
      showToast(`已清除「${editTarget.name}」的依赖配置`);
      setEditOpen(false);
      await loadDeps();
    } catch (e: any) {
      showToast(e?.message || '清除依赖配置失败', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  /**
   * 将通用阶段载荷（start/stop 或 restart 的 stop/start 段）规整为展示用的阶段对象
   * @param payload 后端阶段载荷
   * @param label 阶段展示标签
   * @returns 编排阶段对象
   */
  const toPhase = (payload: PhasePayload | undefined, label: string): OrchestratePhase | null => {
    if (!payload) return null;
    return {
      label,
      ok: !!payload.ok,
      error: payload.error,
      cycle: payload.cycle,
      order: payload.order || [],
      rounds: payload.rounds || [],
      success: payload.success ?? 0,
      fail: payload.fail ?? 0,
      skipped: payload.skipped ?? 0,
    };
  };

  /**
   * 执行一键编排动作（启动 / 停止 / 重启）
   * @param action 动作类型
   */
  const runAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!canManage) {
      showToast('仅管理员可执行一键编排', 'error');
      return;
    }
    setRunningAction(action);
    try {
      if (action === 'restart') {
        // 重启返回嵌套的 stop / start 两阶段结果
        const res = await post<RestartResult>('/api/orchestrate/restart');
        const phases: OrchestratePhase[] = [];
        const stopPhase = toPhase(res?.stop, '停止阶段');
        const startPhase = toPhase(res?.start, '启动阶段');
        if (stopPhase) phases.push(stopPhase);
        if (startPhase) phases.push(startPhase);
        setResult({
          ok: !!res?.ok,
          error: res?.error,
          phases,
          summary: { success: res?.success ?? 0, fail: res?.fail ?? 0, skipped: res?.skipped ?? 0 },
        });
      } else {
        const res = await post<PhasePayload>(`/api/orchestrate/${action}`);
        const label = action === 'start' ? '一键启动' : '一键停止';
        const phase = toPhase(res, label);
        setResult({
          ok: !!res?.ok,
          error: res?.error,
          phases: phase ? [phase] : [],
          summary: { success: res?.success ?? 0, fail: res?.fail ?? 0, skipped: res?.skipped ?? 0 },
        });
      }
    } catch (e: any) {
      showToast(`编排${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setRunningAction(null);
    }
  };

  /** 判断任一编排动作是否在执行中（用于整体禁用写操作） */
  const busy = runningAction !== null;

  /**
   * 拉取指定偏移的编排历史（分页）
   * @param offset 起始偏移量
   */
  const loadHistory = useCallback(async (offset: number) => {
    setHistoryLoading(true);
    try {
      const res = await get<HistoryResponse>('/api/orchestrate/history', {
        limit: HISTORY_PAGE_SIZE,
        offset,
      });
      setHistoryList(res?.items || []);
      setHistoryTotal(res?.total ?? 0);
      setHistoryOffset(offset);
    } catch (e: any) {
      showToast(e?.message || '加载编排历史失败', 'error');
    } finally {
      setHistoryLoading(false);
    }
  }, [showToast]);

  /** 打开历史弹窗并加载第一页 */
  const openHistory = () => {
    setHistoryOpen(true);
    setExpandedIds(new Set());
    loadHistory(0);
  };

  /**
   * 切换单条历史记录的展开 / 折叠
   * @param id 历史记录 id
   */
  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /**
   * 收集一次历史执行中全部失败容器（ok=false 且带 error）
   * restart 时遍历 stop/start 两阶段，动作取所在阶段 label 映射
   * @param item 历史记录
   * @returns 失败容器重试项列表
   */
  const collectFailed = (item: HistoryItem): RetryEntry[] => {
    const entries: RetryEntry[] = [];
    if (item.action === 'restart') {
      const d = item.detail;
      (d?.phases || []).forEach((p: any) => {
        // 阶段 label 通常是 'stop' / 'start'，取其动作
        const action = (p?.label || p?.action || '') as 'start' | 'stop';
        p?.rounds?.forEach((r: any) => {
          (r.items || []).forEach((it: any) => {
            if (!it.ok && !!it.error) {
              entries.push({ id: it.id, name: it.name, action });
            }
          });
        });
      });
    } else {
      const d = item.detail;
      // 非 restart 分支已在上方排除，此处 action 仅可能为 start / stop
      const action = item.action as 'start' | 'stop';
      d?.rounds?.forEach((r: any) => {
        (r.items || []).forEach((it: any) => {
          if (!it.ok && !!it.error) {
            entries.push({ id: it.id, name: it.name, action });
          }
        });
      });
    }
    return entries;
  };

  /**
   * 点击"重试失败项"：收集失败容器并弹出确认
   * @param item 历史记录
   */
  const handleRetryClick = (item: HistoryItem) => {
    if (!canManage) {
      showToast('仅管理员可重试失败项', 'error');
      return;
    }
    const entries = collectFailed(item);
    if (entries.length === 0) {
      showToast('该次执行没有可重试的失败项', 'error');
      return;
    }
    setRetryConfirm({ item, entries });
  };

  /**
   * 执行重试：按动作分组合并容器 id，逐组调用 retry 接口
   */
  const confirmRetry = async () => {
    if (!retryConfirm) return;
    if (!canManage) {
      showToast('仅管理员可重试失败项', 'error');
      return;
    }
    const { item, entries } = retryConfirm;
    setRetrySaving(true);
    setRetryingId(item.id);
    try {
      // 按动作分组（同动作合并为一次调用）
      const groups = new Map<'start' | 'stop', string[]>();
      entries.forEach((e) => {
        const arr = groups.get(e.action) || [];
        arr.push(e.id);
        groups.set(e.action, arr);
      });
      let total = 0;
      let success = 0;
      let fail = 0;
      for (const [action, ids] of groups) {
        const res = await post<RetryResponse>('/api/orchestrate/retry', { action, containerIds: ids });
        total += res?.total ?? 0;
        success += res?.success ?? 0;
        fail += res?.fail ?? 0;
      }
      showToast(`重试完成：成功 ${success}，失败 ${fail}`, fail > 0 ? 'error' : 'success');
      // 刷新容器列表与历史，保持最新状态
      await load();
      await loadHistory(historyOffset);
      setRetryConfirm(null);
    } catch (e: any) {
      showToast(e?.message || '重试失败项失败', 'error');
    } finally {
      setRetrySaving(false);
      setRetryingId(null);
    }
  };

  return (
    <div className="orchestrates-page">
      <Card
        title="容器启动编排"
        extra={
          <div className="orchestrates-page__toolbar">
            <span className="orchestrates-page__total">共 {list.length} 个容器</span>
            <Button variant="secondary" size="sm" onClick={handleRefresh}>
              刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={openHistory}>
              历史
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={runningAction === 'start'}
              disabled={!canManage || busy}
              onClick={() => runAction('start')}
            >
              一键启动
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={runningAction === 'stop'}
              disabled={!canManage || busy}
              onClick={() => runAction('stop')}
            >
              一键停止
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={runningAction === 'restart'}
              disabled={!canManage || busy}
              onClick={() => runAction('restart')}
            >
              一键重启
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="加载容器列表失败"
            description={loadError || '请检查后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={load}>
                重试
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <Empty kind="empty" title="暂无容器" description="容器未创建或已被删除" />
        ) : (
          <div className="orchestrates__table">
            <table>
              <thead>
                <tr>
                  <th className="col-enabled">启用</th>
                  <th>容器名</th>
                  <th>依赖（需先启动）</th>
                  <th className="col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const name = displayName(c);
                  const dep = depMap[c.Id];
                  const enabled = !!dep?.enabled;
                  const depNames = dep?.depNames || [];
                  const otherContainers = list.filter((x) => x.Id !== c.Id);
                  return (
                    <tr key={c.Id}>
                      <td className="col-enabled">
                        <label className="orchestrates__switch">
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={!canManage || busy || togglingId !== null}
                            onChange={(e) => toggleEnabled(c.Id, name, e.target.checked)}
                          />
                          <span />
                        </label>
                      </td>
                      <td className="orchestrates-cell__name" title={c.Id}>
                        {name}
                        <div className="orchestrates-cell__meta">
                          <span className="orchestrates-cell__image">{c.Image || '-'}</span>
                          <span className="orchestrates__status">
                            <StatusBadge status={c.State} />
                          </span>
                        </div>
                      </td>
                      <td>
                        {!enabled ? (
                          <div className="orchestrates__deps">
                            <span className="orchestrates__deps__disabled">未启用编排</span>
                          </div>
                        ) : depNames.length === 0 ? (
                          <div className="orchestrates__deps">
                            <span className="orchestrates__deps__disabled">无依赖（最先启动）</span>
                          </div>
                        ) : (
                          <div className="orchestrates__deps">
                            {depNames.map((dn, i) => (
                              <span key={i} className="dep-badge" title={dn}>
                                {dn}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="col-actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!canManage || busy}
                          onClick={() => openEdit(c.Id, name)}
                        >
                          编辑依赖
                        </Button>
                        <span className="orchestrates__edit-hint">
                          {otherContainers.length} 个可依赖容器
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 依赖结果弹窗：多选其它容器作为依赖 */}
      <Modal
        open={editOpen}
        title={editTarget ? `编辑「${editTarget.name}」的启动依赖` : '编辑依赖'}
        onClose={() => !editSaving && setEditOpen(false)}
        width={560}
        footer={
          <div className="orchestrates__modal-footer">
            <Button
              variant="danger"
              size="md"
              loading={editSaving}
              disabled={!canManage}
              onClick={clearEdit}
            >
              清除配置
            </Button>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" size="md" onClick={() => setEditOpen(false)} disabled={editSaving}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={editSaving} onClick={confirmEdit}>
              保存
            </Button>
          </div>
        }
      >
        <div className="orchestrates__dep-tip">
          选择需要在「{editTarget?.name}」之前启动的其它容器（即其启动依赖）。依赖容器需先就绪，当前容器才会启动。
        </div>
        <div className="orchestrates__dep-pick">
          {(() => {
            const others = list.filter((x) => x.Id !== editTarget?.id);
            if (others.length === 0) {
              return <div className="orchestrates__dep-pick__empty">当前没有可选的其它容器</div>;
            }
            return others.map((x) => {
              const id = x.Id;
              const checked = editDeps.includes(id);
              return (
                <label
                  key={id}
                  className={`orchestrates__dep-pick__item ${checked ? 'orchestrates__dep-pick__item--checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={editSaving}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...editDeps, id]
                        : editDeps.filter((d) => d !== id);
                      setEditDeps(next);
                    }}
                  />
                  <span>
                    <div className="orchestrates__dep-pick__item__name">{displayName(x)}</div>
                    <div className="orchestrates__dep-pick__item__meta">
                      {x.Image || '-'} · {x.State}
                    </div>
                  </span>
                </label>
              );
            });
          })()}
        </div>
      </Modal>

      {/* 编排结果弹窗 */}
      <ResultModal
        open={!!result}
        result={result}
        onClose={() => setResult(null)}
      />

      {/* 编排历史弹窗 */}
      <HistoryModal
        open={historyOpen}
        loading={historyLoading}
        list={historyList}
        total={historyTotal}
        offset={historyOffset}
        pageSize={HISTORY_PAGE_SIZE}
        expandedIds={expandedIds}
        retryingId={retryingId}
        canManage={canManage}
        onClose={() => setHistoryOpen(false)}
        onPrev={() => loadHistory(Math.max(0, historyOffset - HISTORY_PAGE_SIZE))}
        onNext={() => loadHistory(historyOffset + HISTORY_PAGE_SIZE)}
        onToggle={toggleExpand}
        onRetryClick={handleRetryClick}
      />

      {/* 重试失败项确认弹窗 */}
      <Modal
        open={!!retryConfirm}
        title="重试失败项"
        onClose={() => !retrySaving && setRetryConfirm(null)}
        width={520}
        footer={
          <div className="orchestrates__modal-footer">
            <span style={{ flex: 1 }} />
            <Button variant="ghost" size="md" onClick={() => setRetryConfirm(null)} disabled={retrySaving}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={retrySaving} onClick={confirmRetry}>
              确认重试
            </Button>
          </div>
        }
      >
        {retryConfirm && (
          <div className="orchestrates__result">
            <div>将以下 {retryConfirm.entries.length} 个失败容器按动作分组重试：</div>
            <div className="orchestrates__result__rounds">
              {(() => {
                // 按（动作）分组展示将重试的容器
                const groups = new Map<'start' | 'stop', RetryEntry[]>();
                retryConfirm.entries.forEach((e) => {
                  const arr = groups.get(e.action) || [];
                  arr.push(e);
                  groups.set(e.action, arr);
                });
                return Array.from(groups.entries()).map(([action, arr]) => (
                  <div key={action} className="orchestrates__result__round">
                    <div className="orchestrates__result__round__head">
                      <span>{action === 'start' ? '启动' : '停止'}</span>
                      <span className="round-stats">
                        <span className="rs--fail">共 {arr.length} 个</span>
                      </span>
                    </div>
                    <div className="orchestrates__result__round__items">
                      {arr.map((entry) => (
                        <div key={entry.id} className="orchestrates__result__round__item">
                          <span className="orchestrates__result__round__item__name">{entry.name}</span>
                          <span
                            className="orchestrates__result__round__item__badge orchestrates__result__round__item__badge--fail"
                          >
                            失败
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/**
 * 编排结果弹窗内容：展示拓扑顺序、分轮结果与最终汇总；检测到依赖环 / 出错时显著警示
 * @param param0 属性
 */
function ResultModal({ open, result, onClose }: { open: boolean; result: OrchestrateResult | null; onClose: () => void }) {
  return (
    <Modal open={open} title="编排结果" onClose={onClose} width={720}>
      {result && (
        <div className="orchestrates__result">
          <div className="orchestrates__result__summary">
            <div className="sum-item sum-item--success">
              <div className="sum-item__num">{result.summary.success}</div>
              <div className="sum-item__label">成功</div>
            </div>
            <div className="sum-item sum-item--skip">
              <div className="sum-item__num">{result.summary.skipped}</div>
              <div className="sum-item__label">跳过</div>
            </div>
            <div className="sum-item sum-item--fail">
              <div className="sum-item__num">{result.summary.fail}</div>
              <div className="sum-item__label">失败</div>
            </div>
          </div>

          {/* 依赖环显著警告 */}
          {phasesWithCycle(result).map((phase) => (
            <div key={phase.label} className="orchestrates__result__warn orchestrates__result__warn--cycle">
              <span>
                检测到依赖环：{phase.label} 的依赖关系中存在循环依赖（{phase.cycle}），无法进行拓扑排序，已中止执行。
              </span>
            </div>
          ))}

          {/* 顶层错误提示 */}
          {result.error && (
            <div className="orchestrates__result__warn orchestrates__result__warn--error">
              <span>编排失败：{result.error}</span>
            </div>
          )}

          {result.phases.map((phase) => (
            <div key={phase.label} className="orchestrates__result__phase">
              <div className="orchestrates__result__phase__head">
                <span>{phase.label}</span>
                {phase.error && <span style={{ color: 'var(--color-error, #ef4444)' }}>{phase.error}</span>}
                <span className="orchestrates__result__phase__tail">
                  <span className="tail-item tail-item--success">成功 {phase.success}</span>
                  <span className="tail-item tail-item--skip">跳过 {phase.skipped}</span>
                  <span className="tail-item tail-item--fail">失败 {phase.fail}</span>
                </span>
              </div>
              <div className="orchestrates__result__phase__body">
                {phase.order.length > 0 && (
                  <div className="orchestrates__result__order">
                    <div className="orchestrates__result__order__label">启动顺序（拓扑序）：</div>
                    <div>
                      {phase.order.map((o, i) => (
                        <span key={o.id} className="order-item">
                          <span className="order-item__idx">{i + 1}</span>
                          {o.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {phase.rounds.length > 0 && (
                  <div className="orchestrates__result__rounds">
                    {phase.rounds.map((r) => (
                      <RoundBlock key={r.round} round={r} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/**
 * 提取所有包含依赖环的阶段（用于顶部显著告警）
 * @param result 编排结果
 * @returns 含依赖环的阶段列表
 */
function phasesWithCycle(result: OrchestrateResult): OrchestratePhase[] {
  return result.phases.filter((p) => !!p.cycle);
}

/**
 * 单轮结果块：展示轮次名称与逐容器 成功 / 失败 / 跳过 明细
 * 判定：ok=true 为成功；ok=false 且带 error 为失败；ok=false 且无 error 为跳过。
 * @param param0 属性
 */
function RoundBlock({ round }: { round: OrchestrateRound }) {
  return (
    <div className="orchestrates__result__round">
      <div className="orchestrates__result__round__head">
        <span>第 {round.round} 轮</span>
        <span className="round-stats">
          <span className="rs--ok">成功 {round.started}</span>
          <span className="rs--skip">跳过 {round.skipped}</span>
          <span className="rs--fail">失败 {round.failed}</span>
        </span>
      </div>
      {round.items.length === 0 ? (
        <div className="orchestrates__result__round__items">
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>本轮无容器执行</span>
        </div>
      ) : (
        <div className="orchestrates__result__round__items">
          {round.items.map((item: OrchestrateItem) => {
            // 失败：ok 为 false 且带错误信息；跳过：ok 为 false 且无错误
            const isFail = !item.ok && !!item.error;
            const status = item.ok ? 'ok' : isFail ? 'fail' : 'skip';
            const statusText = item.ok ? '成功' : isFail ? '失败' : '跳过';
            return (
              <div key={item.id} className="orchestrates__result__round__item">
                <span className="orchestrates__result__round__item__name">{item.name}</span>
                {item.action && (
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{item.action}</span>
                )}
                <span
                  className={`orchestrates__result__round__item__badge orchestrates__result__round__item__badge--${status}`}
                >
                  {statusText}
                </span>
                {item.error && (
                  <span className="orchestrates__result__round__item__err" title={item.error}>
                    {item.error}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 格式化时间戳为本地 YYYY-MM-DD HH:mm:ss
 * @param ms 毫秒时间戳
 * @returns 格式化后的时间字符串
 */
function formatTime(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 将毫秒耗时格式化为秒（保留 1 位小数），如 1234 => "1.2s"
 * @param ms 毫秒值
 * @returns 格式化后的耗时字符串
 */
function formatDuration(ms: number): string {
  if (ms === undefined || ms === null) return '-';
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 动作徽标文案映射
 * @param action 动作类型
 * @returns 中文文案
 */
function actionLabel(action: string): string {
  if (action === 'start') return '启动';
  if (action === 'stop') return '停止';
  if (action === 'restart') return '重启';
  return action;
}

/**
 * 单条历史记录行：摘要（可点击展开）+ 展开后的详情
 * @param param0 属性
 */
function HistoryRow({
  item,
  expanded,
  retrying,
  canManage,
  phases,
  onToggle,
  onRetryClick,
}: {
  item: HistoryItem;
  expanded: boolean;
  retrying: boolean;
  canManage: boolean;
  phases: HistoryPhase[];
  onToggle: () => void;
  onRetryClick: () => void;
}) {
  const totalFail = phases.reduce((sum, p) => sum + (p.fail || 0), 0);
  return (
    <div className="orchestrates__history-row">
      {/* 摘要头：点击展开 / 折叠 */}
      <div className="orchestrates__history-row__head" onClick={onToggle}>
        <span className={`orchestrates__history-row__arrow ${expanded ? 'orchestrates__history-row__arrow--open' : ''}`}>
          ▶
        </span>
        <span className={`orchestrates__action-badge orchestrates__action-badge--${item.action}`}>
          {actionLabel(item.action)}
        </span>
        <div className="orchestrates__history-row__meta">
          <span className="orchestrates__history-row__time">{formatTime(item.startedAt)}</span>
          <span className="orchestrates__history-row__sub">
            <span>耗时 {formatDuration(item.durationMs)}</span>
            <span className="orchestrates__count-badge orchestrates__count-badge--success">成功 {item.success}</span>
            <span className="orchestrates__count-badge orchestrates__count-badge--skip">跳过 {item.skipped}</span>
            <span className="orchestrates__count-badge orchestrates__count-badge--fail">失败 {item.fail}</span>
            {item.error && <span className="orchestrates__history-row__err" title={item.error}>{item.error}</span>}
          </span>
        </div>
      </div>

      {/* 展开后的详情 */}
      {expanded && (
        <div className="orchestrates__history-row__body">
          {phases.map((phase) => (
            <HistoryPhaseBlock key={phase.label} phase={phase} />
          ))}

          {/* 存在失败项时提供重试入口 */}
          {totalFail > 0 && (
            <div className="orchestrates__history-row__retry">
              <span className="orchestrates__history-row__retry__text">
                {totalFail} 个容器执行失败，可重试其中的失败项。
              </span>
              <Button
                variant="primary"
                size="sm"
                loading={retrying}
                disabled={!canManage}
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryClick();
                }}
              >
                重试失败项
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 阶段详情块：展示拓扑顺序与分轮结果（复用 RoundBlock 的逐容器 成功/失败/跳过 风格）
 * @param param0 属性
 */
function HistoryPhaseBlock({ phase }: { phase: HistoryPhase }) {
  return (
    <div className="orchestrates__result__phase">
      <div className="orchestrates__result__phase__head">
        <span>{phase.label}</span>
        {phase.error && <span style={{ color: 'var(--color-error, #ef4444)' }}>{phase.error}</span>}
        <span className="orchestrates__result__phase__tail">
          <span className="tail-item tail-item--success">成功 {phase.success}</span>
          <span className="tail-item tail-item--skip">跳过 {phase.skipped}</span>
          <span className="tail-item tail-item--fail">失败 {phase.fail}</span>
        </span>
      </div>
      <div className="orchestrates__result__phase__body">
        {phase.cycle && (
          <div className="orchestrates__result__warn orchestrates__result__warn--cycle">
            <span>
              检测到依赖环：{phase.label} 的依赖关系中存在循环依赖（{phase.cycle}），无法进行拓扑排序，已中止执行。
            </span>
          </div>
        )}
        {phase.order.length > 0 && (
          <div className="orchestrates__result__order">
            <div className="orchestrates__result__order__label">
              {phase.action === 'stop' ? '停止顺序：' : '启动顺序（拓扑序）：'}
            </div>
            <div>
              {phase.order.map((o, i) => (
                <span key={o.id} className="order-item">
                  <span className="order-item__idx">{i + 1}</span>
                  {o.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {phase.rounds.length > 0 && (
          <div className="orchestrates__result__rounds">
            {phase.rounds.map((r) => (
              <RoundBlock key={r.round} round={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 编排历史弹窗：分页加载历史记录，行可展开查看详情并支持失败项重试
 * @param param0 属性
 */
function HistoryModal({
  open,
  loading,
  list,
  total,
  offset,
  pageSize,
  expandedIds,
  retryingId,
  canManage,
  onClose,
  onPrev,
  onNext,
  onToggle,
  onRetryClick,
}: {
  open: boolean;
  loading: boolean;
  list: HistoryItem[];
  total: number;
  offset: number;
  pageSize: number;
  expandedIds: Set<number>;
  retryingId: number | null;
  canManage: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggle: (id: number) => void;
  onRetryClick: (item: HistoryItem) => void;
}) {
  const pageNum = total === 0 ? 0 : Math.floor(offset / pageSize) + 1;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const hasPrev = pageNum > 1;
  const hasNext = offset + list.length < total;
  return (
    <Modal open={open} title="编排历史" onClose={onClose} width={760}>
      <div className="orchestrates__history">
        <div className="orchestrates__history__pager">
          <span className="orchestrates__history__pager__info">
            共 {total} 条 · 第 {pageNum}/{totalPages || 1} 页
          </span>
          <span className="orchestrates__history__pager__btns">
            <Button variant="secondary" size="sm" disabled={!hasPrev || loading} onClick={onPrev}>
              上一页
            </Button>
            <Button variant="secondary" size="sm" disabled={!hasNext || loading} onClick={onNext}>
              下一页
            </Button>
          </span>
        </div>

        {loading ? (
          <SkeletonRows rows={5} />
        ) : list.length === 0 ? (
          <div className="orchestrates__history-empty">暂无编排历史记录</div>
        ) : (
          <div className="orchestrates__history__list">
            {list.map((item) => (
              <HistoryRow
                key={item.id}
                item={item}
                expanded={expandedIds.has(item.id)}
                retrying={retryingId === item.id}
                canManage={canManage}
                phases={historyPhasesOf(item)}
                onToggle={() => onToggle(item.id)}
                onRetryClick={() => onRetryClick(item)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * 从历史记录的 detail 规整出阶段列表（start/stop 单阶段，restart 含 stop/start 两阶段）
 * @param item 历史记录
 * @returns 展示用阶段列表
 */
function historyPhasesOf(item: HistoryItem): HistoryPhase[] {
  const d = item.detail;
  if (!d) return [];
  if (item.action === 'restart') {
    const phases = d.phases || [];
    return phases
      .map((p: any) => toHistoryPhaseFromDetail(p, p?.label || p?.action || ''))
      .filter((p: HistoryPhase | null): p is HistoryPhase => !!p);
  }
  const phase = toHistoryPhaseFromDetail(d, item.action === 'start' ? '启动' : '停止');
  return phase ? [phase] : [];
}

/**
 * 将历史阶段载荷规整为展示对象（order 为空时按各轮 items 兜底补全顺序）
 * @param p 阶段载荷
 * @param label 阶段标签
 * @returns 展示用阶段对象
 */
function toHistoryPhaseFromDetail(p: any, label: string): HistoryPhase | null {
  if (!p) return null;
  let order = p.order || [];
  if (order.length === 0 && Array.isArray(p.rounds)) {
    const seen = new Set<string>();
    p.rounds.forEach((r: any) => {
      (r.items || []).forEach((it: any) => {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          order = [...order, { id: it.id, name: it.name }];
        }
      });
    });
  }
  return {
    label,
    ok: !!p.ok,
    action: p.action || '',
    order,
    rounds: p.rounds || [],
    success: p.success ?? 0,
    fail: p.fail ?? 0,
    skipped: p.skipped ?? 0,
    error: p.error,
    cycle: p.cycle,
  };
}
