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
];

/** 目标类型徽标颜色 */
const TYPE_COLOR: Record<string, string> = {
  container: 'blue',
  image: 'purple',
  volume: 'cyan',
  network: 'green',
  compose: 'orange',
  app: 'pink',
};

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

/** 将毫秒时间戳格式化为可读时间 */
function formatTime(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function OperationLogsPage() {
  const { showToast } = useToast();

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = {
        page,
        pageSize,
        ...(typeFilter ? { targetType: typeFilter } : {}),
        ...(usernameFilter ? { username: usernameFilter } : {}),
        ...(resultFilter ? { success: resultFilter } : {}),
        ...(startTime ? { startTime: new Date(startTime).getTime() } : {}),
        ...(endTime ? { endTime: new Date(endTime).getTime() + 86399999 } : {}),
      };
      const data = await get<LogPage>('/api/operation-logs', params);
      setLogs(data.items || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
      setOperators(data.operators || []);
    } catch (e: any) {
      showToast(e?.message || '加载操作日志失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, typeFilter, usernameFilter, resultFilter, startTime, endTime, showToast]);

  useEffect(() => {
    load();
  }, [load]);

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
    setClearing(true);
    try {
      await del('/api/operation-logs');
      showToast('操作日志已清空', 'success');
      setPage(1);
      load();
    } catch (e: any) {
      showToast(e?.message || '清空操作日志失败', 'error');
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  // 按当前筛选条件导出 CSV（携带与列表一致的过滤参数）
  const handleExport = async () => {
    if (total === 0) {
      showToast('当前无日志可导出', 'info');
      return;
    }
    setExporting(true);
    try {
      const params: Record<string, any> = {
        ...(typeFilter ? { targetType: typeFilter } : {}),
        ...(usernameFilter ? { username: usernameFilter } : {}),
        ...(resultFilter ? { success: resultFilter } : {}),
        ...(startTime ? { startTime: new Date(startTime).getTime() } : {}),
        ...(endTime ? { endTime: new Date(endTime).getTime() + 86399999 } : {}),
      };
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      await download(`/api/operation-logs/export${qs ? '?' + qs : ''}`);
      showToast('日志已导出', 'success');
    } catch (e: any) {
      showToast(e?.message || '导出失败', 'error');
    } finally {
      setExporting(false);
    }
  };

  const safePage = Math.min(page, totalPages);
  const pageStart = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const pageEnd = Math.min(safePage * pageSize, total);

  return (
    <div className="logs-page">
      <h1 className="logs-page__title">操作日志</h1>

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
              <option value="">全部操作人</option>
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
              <span>时间</span>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  setPage(1);
                }}
              />
              <span className="logs__time-sep">至</span>
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
              刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={handleExport} disabled={total === 0 || exporting}>
              {exporting ? '导出中...' : '导出 CSV'}
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmClear(true)} disabled={total === 0}>
              清空
            </Button>
          </div>
        </div>

        {loading ? (
          <SkeletonRows rows={8} />
        ) : logs.length === 0 ? (
          <Empty title="暂无操作日志" description="执行容器启停、删除镜像等操作后将在这里记录" />
        ) : (
          <>
            <table className="data-table logs__table">
              <thead>
                <tr>
                  <th>操作时间</th>
                  <th>操作人</th>
                  <th>操作</th>
                  <th>类型</th>
                  <th>目标</th>
                  <th>详情</th>
                  <th>结果</th>
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
                        <span className="logs__result logs__result--ok">成功</span>
                      ) : (
                        <span className="logs__result logs__result--fail">失败</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="logs__pagination">
              <span className="logs__pagination-info">
                共 {total} 条，当前第 {pageStart}-{pageEnd} 条
              </span>
              <div className="logs__pagination-controls">
                <label className="logs__page-size">
                  每页
                  <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  条
                </label>
                <button className="logs__page-btn" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                  上一页
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    className={`logs__page-btn ${p === safePage ? 'logs__page-btn--active' : ''}`}
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </button>
                ))}
                <button
                  className="logs__page-btn"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                >
                  下一页
                </button>
                <span className="logs__page-jump">
                  <input
                    className="logs__page-jump-input"
                    type="number"
                    min={1}
                    max={totalPages}
                    placeholder="页码"
                    value={pageJump}
                    onChange={(e) => setPageJump(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleJump();
                    }}
                  />
                  <Button variant="ghost" size="sm" onClick={handleJump}>
                    跳转
                  </Button>
                </span>
              </div>
            </div>
          </>
        )}
      </Card>

      <ConfirmDialog
        open={confirmClear}
        title="清空操作日志"
        message="确定要清空全部操作日志吗？此操作不可恢复。"
        danger
        confirmText="清空"
        loading={clearing}
        onConfirm={handleClear}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
