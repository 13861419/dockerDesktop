import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import { Field, Input, Select } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, download } from '../api/client';
import type { LogSourceContainer, LogLine, LogsQueryResponse } from '../types';
import { translateNow as t } from '../i18n';
import './logs.less';

/** 时间范围快捷选项 */
const RANGES = [
  { label: '最近 5 分钟', minutes: 5 },
  { label: '最近 1 小时', minutes: 60 },
  { label: '最近 24 小时', minutes: 1440 },
  { label: '最近 7 天', minutes: 10080 },
];

/** 日志索引状态 */
interface LogIndexStatus {
  enabled: boolean;
  rows: number;
  containers: number;
  oldestTs: number | null;
  newestTs: number | null;
}

export default function LogsPage() {
  const { showToast } = useToast();

  const [mode, setMode] = useState<'live' | 'history'>('live');
  const [indexStatus, setIndexStatus] = useState<LogIndexStatus | null>(null);
  const [limit, setLimit] = useState(500);

  const [containers, setContainers] = useState<LogSourceContainer[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [rangeMinutes, setRangeMinutes] = useState<number | 0>(5);
  const [streams, setStreams] = useState<'all' | 'stdout' | 'stderr'>('all');
  const [tailPer, setTailPer] = useState(500);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [total, setTotal] = useState(0);

  const loadContainers = useCallback(async () => {
    try {
      const data = await get<LogSourceContainer[]>('/api/logs/containers');
      setContainers(Array.isArray(data) ? data : []);
    } catch (e: any) {
      showToast(e?.message || t('加载容器失败'), 'error');
    }
  }, [showToast]);

  const loadStatus = useCallback(async () => {
    try {
      setIndexStatus(await get<LogIndexStatus>('/api/logs/history/status'));
    } catch {
      setIndexStatus(null);
    }
  }, []);

  useEffect(() => {
    loadContainers();
    loadStatus();
  }, [loadContainers, loadStatus]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleContainer = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const selectAll = useCallback(() => {
    setSelected(containers.map((c) => c.id));
  }, [containers]);

  const clearAll = useCallback(() => {
    setSelected([]);
  }, []);

  const query = useCallback(async () => {
    if (selected.length === 0) {
      showToast(t('请先选择容器'), 'error');
      return;
    }
    setLoading(true);
    try {
      const since = rangeMinutes ? Math.floor(Date.now() / 1000) - rangeMinutes * 60 : 0;
      const streamsParam = streams === 'all' ? 'stdout,stderr' : streams;
      const data = await get<LogsQueryResponse>('/api/logs/query', {
        containerIds: selected.join(','),
        since: since || undefined,
        tailPer,
        keyword: keyword || undefined,
        streams: streamsParam,
      });
      setLines(data.lines || []);
      setTotal(data.total || 0);
      setLoaded(true);
    } catch (e: any) {
      showToast(e?.message || t('查询日志失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [selected, rangeMinutes, streams, tailPer, keyword, showToast]);

  const queryHistory = useCallback(async () => {
    setLoading(true);
    try {
      const since = rangeMinutes ? Math.floor(Date.now() / 1000) - rangeMinutes * 60 : 0;
      const data = await get<{ lines: Array<{ ts: number; container: string; stream: string; text: string }>; total: number; truncated: boolean }>(
        '/api/logs/history',
        {
          containerIds: selected.join(','),
          keyword: keyword || undefined,
          since: since || undefined,
          limit,
        },
      );
      setLines((data.lines || []) as LogLine[]);
      setTotal(data.total || 0);
      setLoaded(true);
      if (data.truncated) showToast(t('结果超出单页上限，已展示最早的 {{n}} 行', { n: limit }), undefined);
    } catch (e: any) {
      showToast(e?.message || t('查询日志失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [selected, rangeMinutes, keyword, limit, showToast, loadStatus]);

  const pruneIndex = useCallback(async () => {
    try {
      const r = await post('/api/logs/history/prune', {});
      showToast(t('已清理过期 {{n}} 行', { n: (r as any).expired || 0 }));
      loadStatus();
    } catch (e: any) {
      showToast(e?.message || t('操作失败'), 'error');
    }
  }, [showToast, loadStatus]);

  const exportLogs = useCallback(async () => {
    if (selected.length === 0) return;
    const since = rangeMinutes ? Math.floor(Date.now() / 1000) - rangeMinutes * 60 : 0;
    const streamsParam = streams === 'all' ? 'stdout,stderr' : streams;
    await download(
      `/api/logs/query/download?containerIds=${selected.join(',')}&since=${since || ''}&tailPer=${tailPer}&keyword=${encodeURIComponent(keyword || '')}&streams=${streamsParam}`,
      'logs-aggregated.txt',
    );
  }, [selected, rangeMinutes, streams, tailPer, keyword]);

  const renderLine = useCallback((l: LogLine, i: number) => {
    const ts = l.ts ? new Date(l.ts).toLocaleTimeString() : '';
    const text = l.text;
    let rendered: React.ReactNode = text;
    if (keyword) {
      const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
      if (idx >= 0) {
        rendered = (
          <>
            {text.slice(0, idx)}
            <mark className="logs__mark">{text.slice(idx, idx + keyword.length)}</mark>
            {text.slice(idx + keyword.length)}
          </>
        );
      }
    }
    return (
      <div className={`logs__line logs__line--${l.stream}`} key={i}>
        <span className="logs__ts">{ts}</span>
        <span className="logs__container">{l.container}</span>
        <span className="logs__body">{rendered}</span>
      </div>
    );
  }, [keyword]);

  const filteredCount = useMemo(() => lines.length, [lines]);

  return (
    <div className="logs-page">
      <Card
        title={t('日志聚合中心')}
        extra={
          <div className="toolbar">
            <Button size="sm" variant={mode === 'live' ? 'primary' : 'secondary'} onClick={() => setMode('live')}>
              {t('实时聚合')}
            </Button>
            <Button size="sm" variant={mode === 'history' ? 'primary' : 'secondary'} onClick={() => setMode('history')}>
              {t('历史检索')}
            </Button>
            <Button size="sm" onClick={loadContainers}>
              {t('刷新容器')}
            </Button>
          </div>
        }
      >
        {mode === 'history' && (
          <div className="logs-page__index-status">
            {indexStatus?.enabled ? (
              <span>
                {t('索引中：{{rows}} 行 / {{containers}} 个容器', { rows: indexStatus.rows, containers: indexStatus.containers })}
                {indexStatus.oldestTs ? ` · ${t('最早')}: ${new Date(indexStatus.oldestTs).toLocaleString()}` : ''}
              </span>
            ) : (
              <span>{t('日志索引未开启：到「设置 → 系统参数」开启「容器日志持久化索引」后，可跨容器检索历史日志')}</span>
            )}
            <span className="logs-page__index-prune" onClick={pruneIndex}>{t('手动清理过期行')}</span>
          </div>
        )}
        <div className="logs-page__filters">
          <Field label={t('容器')}>
            <div className="logs-page__selects" ref={dropdownRef}>
              <div className="logs-page__dropdown" onClick={() => setDropdownOpen(!dropdownOpen)}>
                <span className="logs-page__dropdown-text">
                  {selected.length === 0
                    ? t('选择容器…')
                    : t('已选 {{v1}} 个容器', { v1: selected.length })}
                </span>
                <span className="logs-page__dropdown-arrow">▾</span>
              </div>
              {dropdownOpen && (
                <div className="logs-page__dropdown-menu">
                  <div className="logs-page__dropdown-actions">
                    <span className="logs-page__dropdown-action" onClick={selectAll}>{t('全选')}</span>
                    <span className="logs-page__dropdown-action" onClick={clearAll}>{t('清空')}</span>
                  </div>
                  {containers.map((c) => (
                    <label className="logs-page__dropdown-item" key={c.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(c.id)}
                        onChange={() => toggleContainer(c.id)}
                      />
                      <span>{c.name}</span>
                      <span className="logs-page__dropdown-image">{c.image}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </Field>
          <Field label={t('时间范围')}>
            <Select value={String(rangeMinutes)} onChange={(e: any) => setRangeMinutes(Number(e.target.value))}>
              {RANGES.map((r) => (
                <option key={r.minutes} value={r.minutes}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('流')}>
            <Select value={streams} onChange={(e: any) => setStreams(e.target.value as any)}>
              <option value="all">{t('全部')}</option>
              <option value="stdout">stdout</option>
              <option value="stderr">stderr</option>
            </Select>
          </Field>
          <Field label={mode === 'live' ? t('每容器行数') : t('返回行数上限')}>
            {mode === 'live' ? (
              <Select value={String(tailPer)} onChange={(e: any) => setTailPer(Number(e.target.value))}>
                <option value="100">100</option>
                <option value="500">500</option>
                <option value="1000">1000</option>
                <option value="2000">2000</option>
              </Select>
            ) : (
              <Select value={String(limit)} onChange={(e: any) => setLimit(Number(e.target.value))}>
                <option value="500">500</option>
                <option value="1000">1000</option>
                <option value="2000">2000</option>
                <option value="5000">5000</option>
              </Select>
            )}
          </Field>
          <Field label={t('关键字')}>
            <Input
              placeholder={t('过滤关键字')}
              value={keyword}
              onChange={(e: any) => setKeyword(e.target.value)}
              onKeyDown={(e: any) => e.key === 'Enter' && (mode === 'live' ? query() : queryHistory())}
            />
          </Field>
          <div className="logs-page__actions">
            <Button
              variant="primary"
              loading={loading}
              disabled={mode === 'live' && selected.length === 0}
              onClick={() => (mode === 'live' ? query() : queryHistory())}
            >
              {t('查询')}
            </Button>
            <Button variant="secondary" disabled={mode !== 'live' || !loaded} onClick={exportLogs}>
              {t('导出')}
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title={t('日志结果')}
        extra={loaded ? <span className="logs-page__count">共 {total} 行{keyword ? t('，命中过滤') : ''}</span> : undefined}
      >
        {loading ? (
          <SkeletonRows rows={10} />
        ) : !loaded ? (
          <Empty title={t('尚未查询')} description="选择容器与条件后点击查询。" />
        ) : lines.length === 0 ? (
          <Empty title={t('无日志')} description="当前条件下没有日志，试试放宽范围或关键字。" />
        ) : (
          <div className="logs-page__view">
            {lines.map(renderLine)}
          </div>
        )}
      </Card>
    </div>
  );
}
