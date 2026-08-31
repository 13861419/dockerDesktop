/**
 * 操作审计日志页
 *
 * 展示用户手动执行的关键操作（启停容器、删镜像、建卷/网络、Compose/应用等），
 * 数据来自后端 /api/operation-logs（SQLite 持久化，刷新不丢）。
 * 支持目标类型筛选、分页、刷新与清空。
 */
import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, del, download } from '../api/client';
import { isAdmin } from '../api/auth';
import { translateNow as t } from '../i18n';
import './operationLogs.less';

/** 每页显示条数的可选值 */
const PAGE_SIZE_OPTIONS = [20, 50, 100];

/** 结果筛选选项 */
const RESULT_OPTIONS = [
  { value: '', label: '全部结果' },
  { value: 'true', label: '成功' },
  { value: 'false', label: '失败' },
];

/** 目标类型选项（value 为后端 target_type） */
const TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'container', label: '容器' },
  { value: 'image', label: '镜像' },
  { value: 'volume', label: '数据卷' },
  { value: 'network', label: '网络' },
  { value: 'compose', label: 'Compose' },
  { value: 'app', label: '应用' },
  { value: 'approval', label: '审批' },
  { value: 'ai', label: 'AI 操作' },
];

/** 目标类型徽标颜色 */
const TYPE_COLOR: Record<string, string> = {
  container: 'blue',
  image: 'purple',
  volume: 'cyan',
  network: 'green',
  compose: 'orange',
  app: 'pink',
  approval: 'red',
  ai: 'cyan',
};

/**
 * 生成分页页码序列（超出阈值时用 0 占位表示省略号）
 * 始终显示首页/末页，当前页前后各留 1 个页码。
 */
function getPageItems(current: number, total: number): number[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const items: number[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= total && (items.length === 0 || items[items.length - 1] !== n)) items.push(n);
  };
  const pushEllipsis = () => {
    if (items.length > 0 && items[items.length - 1] !== 0) items.push(0);
  };
  add(1);
  if (current > 3) pushEllipsis();
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) add(p);
  if (current < total - 2) pushEllipsis();
  add(total);
  return items;
}

interface LogItem {
  id: number;
  username: string;
  action: string;
  targetType: string;
  targetName: string | null;
  detail: string | null;
  success: boolean;
  createdAt: number;
}

interface LogPage {
  items: LogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  operators: string[];
}

/** 统计接口返回结构 */
interface StatsData {
  byType: Array<{ target_type: string; count: number }>;
  bySuccess: Array<{ success: number; count: number }>;
  byAction: Array<{ action: string; count: number }>;
  total: number;
}

/** 按操作者统计条目（/api/operation-logs/stats/by-user） */
interface ByUserStatsItem {
  username: string;
  count: number;
  success: number;
  fail: number;
}

/** 按天趋势条目（/api/operation-logs/stats/trend） */
interface TrendStatsItem {
  day: string;
  count: number;
  success: number;
  fail: number;
}

/** 将毫秒时间戳格式化为可读时间 */
function formatTime(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 构建与列表一致的过滤查询参数（供列表 / 统计 / 导出复用）
 * @param typeFilter 目标类型筛选值
 * @param usernameFilter 操作人筛选值
 * @param resultFilter 结果筛选值（'true' / 'false' / ''）
 * @param startTime 起始时间（datetime-local 字符串）
 * @param endTime 结束时间（datetime-local 字符串）
 * @returns 过滤参数对象
 */
function buildFilterParams(
  typeFilter: string,
  usernameFilter: string,
  resultFilter: string,
  startTime: string,
  endTime: string,
): Record<string, any> {
  return {
    ...(typeFilter ? { targetType: typeFilter } : {}),
    ...(usernameFilter ? { username: usernameFilter } : {}),
    ...(resultFilter ? { success: resultFilter } : {}),
    ...(startTime ? { startTime: new Date(startTime).getTime() } : {}),
    // endTime 取当天 23:59:59.999，确保包含结束日当天全部记录
    ...(endTime ? { endTime: new Date(endTime).getTime() + 86399999 } : {}),
  };
}

export default function OperationLogsPage() {
  const { showToast } = useToast();
  const canClear = isAdmin();

  const [logs, setLogs] = useState<LogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [operators, setOperators] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [usernameFilter, setUsernameFilter] = useState('');
  const [resultFilter, setResultFilter] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // 分页跳转：输入的目标页码
  const [pageJump, setPageJump] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 统计卡片数据（随筛选条件变化）
  const [stats, setStats] = useState<StatsData | null>(null);
  // 审计报表：按操作者排行
  const [byUserStats, setByUserStats] = useState<ByUserStatsItem[]>([]);
  // 审计报表：按天趋势
  const [trendStats, setTrendStats] = useState<TrendStatsItem[]>([]);
  // 报表导出维度（user 按操作者 / day 按天）
  const [statsGroupBy, setStatsGroupBy] = useState<'user' | 'day'>('user');
  // 报表导出进行中
  const [exportStatsLoading, setExportStatsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = {
        page,
        pageSize,
        ...buildFilterParams(typeFilter, usernameFilter, resultFilter, startTime, endTime),
      };
      const data = await get<LogPage>('/api/operation-logs', params);
      setLogs(data.items || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
      setOperators(data.operators || []);
    } catch (e: any) {
      showToast(e?.message || t('加载操作日志失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, typeFilter, usernameFilter, resultFilter, startTime, endTime, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // 加载统计卡片：随筛选条件变化，与列表并行请求
  useEffect(() => {
    if (!isAdmin()) return;
    const params = buildFilterParams(typeFilter, usernameFilter, resultFilter, startTime, endTime);
    get<StatsData>('/api/operation-logs/stats', params)
      .then((data) => setStats(data || null))
      .catch(() => setStats(null));
    // 审计报表：操作者排行 + 按天趋势（与主统计并行）
    get<ByUserStatsItem[]>('/api/operation-logs/stats/by-user', params)
      .then((data) => setByUserStats(data || []))
      .catch(() => setByUserStats([]));
    get<TrendStatsItem[]>('/api/operation-logs/stats/trend', params)
      .then((data) => setTrendStats(data || []))
      .catch(() => setTrendStats([]));
  }, [typeFilter, usernameFilter, resultFilter, startTime, endTime]);

  const changePageSize = (n: number) => {
    setPageSize(n);
    setPage(1);
  };

  const handleJump = () => {
    const n = parseInt(pageJump, 10);
    if (isNaN(n)) {
      setPageJump('');
      return;
    }
    const target = Math.min(Math.max(1, n), totalPages);
    setPage(target);
    setPageJump('');
  };

  const changeType = (v: string) => {
    setTypeFilter(v);
    setPage(1);
  };

  const changeUsername = (v: string) => {
    setUsernameFilter(v);
    setPage(1);
  };

  const changeResult = (v: string) => {
    setResultFilter(v);
    setPage(1);
  };

  const handleClear = async () => {
    if (!canClear) {
      showToast(t('仅管理员可清空操作日志'), 'error');
      setConfirmClear(false);
      return;
    }
    setClearing(true);
    try {
      await del('/api/operation-logs');
      showToast(t('操作日志已清空'), 'success');
      setPage(1);
      load();
    } catch (e: any) {
      showToast(e?.message || t('清空操作日志失败'), 'error');
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  /**
   * 导出工具：按当前筛选条件触发指定格式的文件下载
   * @param format 导出格式（csv / json）
   */
  const handleExport = async (format: 'csv' | 'json') => {
    if (total === 0) {
      showToast(t('当前无日志可导出'), 'info');
      return;
    }
    setExporting(true);
    try {
      const params = buildFilterParams(typeFilter, usernameFilter, resultFilter, startTime, endTime);
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      const suffix = qs ? '&' + qs : '';
      await download(`/api/operation-logs/export?format=${format}${suffix}`);
      showToast(format === 'json' ? t('日志已导出为 JSON') : t('日志已导出'), 'success');
    } catch (e: any) {
      showToast(e?.message || t('导出失败'), 'error');
    } finally {
      setExporting(false);
    }
  };

  /**
   * 导出审计统计报表（按操作者 / 按天）为 CSV
   * @param groupBy 统计维度：user（操作者） / day（按天）
   */
  const handleExportStats = async (groupBy: 'user' | 'day') => {
    if (statsTotal === 0) {
      showToast(t('当前无数据可导出报表'), 'info');
      return;
    }
    setExportStatsLoading(true);
    try {
      const params = buildFilterParams(typeFilter, usernameFilter, resultFilter, startTime, endTime);
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      const suffix = qs ? '&' + qs : '';
      await download(`/api/operation-logs/export/stats?groupBy=${groupBy}${suffix}`);
      showToast(t('统计报表已导出'), 'success');
    } catch (e: any) {
      showToast(e?.message || t('导出报表失败'), 'error');
    } finally {
      setExportStatsLoading(false);
    }
  };

  const safePage = Math.min(page, totalPages);
  const pageStart = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const pageEnd = Math.min(safePage * pageSize, total);

  // 从 bySuccess 中提取成功 / 失败计数（缺省按 0 处理）
  const successCount = stats?.bySuccess.find((s) => s.success === 1)?.count || 0;
  const failCount = stats?.bySuccess.find((s) => s.success === 0)?.count || 0;
  const statsTotal = stats?.total || 0;
  // 结果占比（%）与最大目标类型计数（用于横向条形图宽度基准）
  const successPct = statsTotal ? Math.round((successCount / statsTotal) * 100) : 0;
  const failPct = statsTotal ? Math.round((failCount / statsTotal) * 100) : 0;
  const maxTypeCount = Math.max(1, ...(stats?.byType.map((t) => t.count) || []));
  // 审计报表条形图宽度基准（操作者排行 / 按天趋势）
  const maxUserCount = Math.max(1, ...byUserStats.map((u) => u.count));
  const maxTrendCount = Math.max(1, ...trendStats.map((t) => t.count));

  return (
    <div className="logs-page">
      <h1 className="logs-page__title">{t('操作日志')}</h1>

      <Card>
        <div className="logs__toolbar">
          <div className="logs__filters">
            <select
              className="logs__type-select"
              value={typeFilter}
              onChange={(e) => changeType(e.target.value)}
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <select
              className="logs__type-select"
              value={usernameFilter}
              onChange={(e) => changeUsername(e.target.value)}
            >
              <option value="">{t('全部操作人')}</option>
              {operators.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <select
              className="logs__type-select"
              value={resultFilter}
              onChange={(e) => changeResult(e.target.value)}
            >
              {RESULT_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <label className="logs__time-filter">
              <span>{t('时间')}</span>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  setPage(1);
                }}
              />
              <span className="logs__time-sep">{t('至')}</span>
              <input
                type="datetime-local"
                value={endTime}
                onChange={(e) => {
                  setEndTime(e.target.value);
                  setPage(1);
                }}
              />
            </label>
          </div>
          <div className="logs__controls">
            <span className="logs__total">共 {total} 条</span>
            <Button variant="secondary" size="sm" onClick={load}>
              {t('刷新')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => handleExport('csv')} disabled={total === 0 || exporting}>
              {exporting ? t('导出中...') : t('导出 CSV')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => handleExport('json')} disabled={total === 0 || exporting}>
              {exporting ? t('导出中...') : t('导出 JSON')}
            </Button>
            <select
              className="logs__type-select"
              value={statsGroupBy}
              onChange={(e) => setStatsGroupBy(e.target.value as 'user' | 'day')}
              disabled={exportStatsLoading}
              style={{ width: 120 }}
            >
              <option value="user">{t('操作者报表')}</option>
              <option value="day">{t('按天报表')}</option>
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleExportStats(statsGroupBy)}
              disabled={total === 0 || !canClear || exportStatsLoading}
            >
              {exportStatsLoading ? t('导出中...') : t('导出报表')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmClear(true)} disabled={total === 0 || !canClear}>
              {t('清空')}
            </Button>
          </div>
        </div>

        {/* 统计卡片区（仅管理员展示，随筛选条件变化） */}
        {canClear && stats && statsTotal > 0 && (
          <div className="oplog-stats">
            <div className="oplog-stats__total">
              <span className="oplog-stats__total-num">{statsTotal}</span>
              <span className="oplog-stats__total-label">{t('匹配操作数')}</span>
            </div>

            <div className="oplog-stats__block">
              <h4 className="oplog-stats__title">{t('按目标类型')}</h4>
              {stats.byType.length === 0 ? (
                <div className="oplog-stats__empty">{t('无数据')}</div>
              ) : (
                stats.byType.map((t) => (
                  <div className="oplog-stats__row" key={t.target_type || '-'}>
                    <span className="oplog-stats__row-label">
                      {TYPE_OPTIONS.find((o) => o.value === t.target_type)?.label || t.target_type || '-'}
                    </span>
                    <div className="oplog-stats__bar-track">
                      <div
                        className="oplog-stats__bar"
                        style={{ width: `${Math.round((t.count / maxTypeCount) * 100)}%` }}
                      />
                    </div>
                    <span className="oplog-stats__row-count">{t.count}</span>
                  </div>
                ))
              )}
            </div>

            <div className="oplog-stats__block">
              <h4 className="oplog-stats__title">{t('按结果')}</h4>
              <div className="oplog-stats__result">
                <div className="oplog-stats__result-item oplog-stats__result-item--ok">
                  <span className="oplog-stats__result-num">{successCount}</span>
                  <span className="oplog-stats__result-label">成功 ({successPct}%)</span>
                  <div className="oplog-stats__bar-track">
                    <div
                      className="oplog-stats__bar oplog-stats__bar--ok"
                      style={{ width: `${successPct}%` }}
                    />
                  </div>
                </div>
                <div className="oplog-stats__result-item oplog-stats__result-item--fail">
                  <span className="oplog-stats__result-num">{failCount}</span>
                  <span className="oplog-stats__result-label">失败 ({failPct}%)</span>
                  <div className="oplog-stats__bar-track">
                    <div
                      className="oplog-stats__bar oplog-stats__bar--fail"
                      style={{ width: `${failPct}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="oplog-stats__block">
              <h4 className="oplog-stats__title">{t('操作动作 TOP 10')}</h4>
              {stats.byAction.length === 0 ? (
                <div className="oplog-stats__empty">{t('无数据')}</div>
              ) : (
                <ol className="oplog-stats__action-list">
                  {stats.byAction.map((a, idx) => (
                    <li className="oplog-stats__action-item" key={`${a.action}-${idx}`}>
                      <span className="oplog-stats__action-name" title={a.action}>
                        {a.action}
                      </span>
                      <span className="oplog-stats__action-count">{a.count}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="oplog-stats__block">
              <h4 className="oplog-stats__title">{t('操作者 TOP 10')}</h4>
              {byUserStats.length === 0 ? (
                <div className="oplog-stats__empty">{t('无数据')}</div>
              ) : (
                byUserStats.slice(0, 10).map((u) => (
                  <div className="oplog-stats__row" key={u.username || '-'}>
                    <span
                      className="oplog-stats__row-label"
                      title={t('{{v1}}：成功 {{v2}}，失败 {{v3}}', { v1: u.username || 'system', v2: u.success, v3: u.fail })}
                    >
                      {u.username || 'system'}
                    </span>
                    <div className="oplog-stats__bar-track">
                      <div
                        className="oplog-stats__bar"
                        style={{ width: `${Math.round((u.count / maxUserCount) * 100)}%` }}
                      />
                    </div>
                    <span className="oplog-stats__row-count" title={t('成功 {{v1}}，失败 {{v2}}', { v1: u.success, v2: u.fail })}>
                      {u.count}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="oplog-stats__block">
              <h4 className="oplog-stats__title">{t('按天趋势')}</h4>
              {trendStats.length === 0 ? (
                <div className="oplog-stats__empty">{t('无数据')}</div>
              ) : (
                <ol className="oplog-stats__action-list">
                  {trendStats.map((t) => (
                    <li className="oplog-stats__action-item" key={t.day}>
                      <span className="oplog-stats__action-name" title={t.day}>
                        {t.day}
                      </span>
                      <span className="oplog-stats__action-count">{t.count}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}

        {loading ? (
          <SkeletonRows rows={8} />
        ) : logs.length === 0 ? (
          <Empty title={t('暂无操作日志')} description="执行容器启停、删除镜像等操作后将在这里记录" />
        ) : (
          <>
            <table className="data-table logs__table">
              <thead>
                <tr>
                  <th>{t('操作时间')}</th>
                  <th>{t('操作人')}</th>
                  <th>{t('操作')}</th>
                  <th>{t('类型')}</th>
                  <th>{t('目标')}</th>
                  <th>{t('详情')}</th>
                  <th>{t('结果')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="logs__time">{formatTime(log.createdAt)}</td>
                    <td>{log.username || '-'}</td>
                    <td>{log.action}</td>
                    <td>
                      <span
                        className={`logs__type-badge logs__type-badge--${TYPE_COLOR[log.targetType] || 'grey'}`}
                      >
                        {TYPE_OPTIONS.find((t) => t.value === log.targetType)?.label || log.targetType || '-'}
                      </span>
                    </td>
                    <td className="logs__target" title={log.targetName || ''}>
                      {log.targetName || '-'}
                    </td>
                    <td className="logs__detail" title={log.detail || ''}>
                      {log.detail || '-'}
                    </td>
                    <td>
                      {log.success ? (
                        <span className="logs__result logs__result--ok">{t('成功')}</span>
                      ) : (
                        <span className="logs__result logs__result--fail">{t('失败')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="logs__pagination">
              <span className="logs__pagination-info">
                {t('共')} {total} 条，当前第 {pageStart}-{pageEnd} 条
              </span>
              <div className="logs__pagination-controls">
                <label className="logs__page-size">
                  {t('每页')}
                  <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  {t('条')}
                </label>
                <button className="logs__page-btn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                  {t('上一页')}
                </button>
                {getPageItems(safePage, totalPages).map((p) =>
                  p === 0 ? (
                    <span key={`e${p}`} className="logs__page-ellipsis">
                      …
                    </span>
                  ) : (
                    <button
                      key={p}
                      className={`logs__page-btn ${p === safePage ? 'logs__page-btn--active' : ''}`}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </button>
                  ),
                )}
                <button
                  className="logs__page-btn"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                >
                  {t('下一页')}
                </button>
                <span className="logs__page-jump">
                  <input
                    className="logs__page-jump-input"
                    type="number"
                    min={1}
                    max={totalPages}
                    placeholder={t('页码')}
                    value={pageJump}
                    onChange={(e) => setPageJump(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleJump();
                    }}
                  />
                  <Button variant="ghost" size="sm" onClick={handleJump}>
                    {t('跳转')}
                  </Button>
                </span>
              </div>
            </div>
          </>
        )}
      </Card>

      <ConfirmDialog
        open={confirmClear}
        title={t('清空操作日志')}
        message="确定要清空全部操作日志吗？此操作不可恢复。"
        danger
        confirmText={t('清空')}
        loading={clearing}
        onConfirm={handleClear}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
