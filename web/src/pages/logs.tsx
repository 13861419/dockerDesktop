import { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import { Field, Input, Select } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, download } from '../api/client';
import type { LogSourceContainer, LogLine, LogsQueryResponse } from '../types';
import './logs.less';

/** 时间范围快捷选项 */
const RANGES = [
  { label: '最近 5 分钟', minutes: 5 },
  { label: '最近 1 小时', minutes: 60 },
  { label: '最近 24 小时', minutes: 1440 },
  { label: '最近 7 天', minutes: 10080 },
];

export default function LogsPage() {
  const { showToast } = useToast();

  const [containers, setContainers] = useState<LogSourceContainer[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [rangeMinutes, setRangeMinutes] = useState<number | 0>(5);
  const [streams, setStreams] = useState<'all' | 'stdout' | 'stderr'>('all');
  const [tailPer, setTailPer] = useState(500);

  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [total, setTotal] = useState(0);

  const loadContainers = useCallback(async () => {
    try {
      const data = await get<LogSourceContainer[]>('/api/logs/containers');
      setContainers(Array.isArray(data) ? data : []);
    } catch (e: any) {
      showToast(e?.message || '加载容器失败', 'error');
    }
  }, [showToast]);

  useEffect(() => {
    loadContainers();
  }, [loadContainers]);

  const query = useCallback(async () => {
    if (selected.length === 0) {
      showToast('请先选择容器', 'error');
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
      showToast(e?.message || '查询日志失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [selected, rangeMinutes, streams, tailPer, keyword, showToast]);

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
      <Card title="日志聚合中心" extra={<Button size="sm" onClick={loadContainers}>刷新容器</Button>}>
        <div className="logs-page__filters">
          <Field label="容器">
            <div className="logs-page__selects">
              <Select
                multiple
                value={selected}
                onChange={(e: any) =>
                  setSelected(Array.from(e.target.selectedOptions).map((o: any) => o.value))
                }
              >
                {containers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.image})
                  </option>
                ))}
              </Select>
            </div>
          </Field>
          <Field label="时间范围">
            <Select value={String(rangeMinutes)} onChange={(e: any) => setRangeMinutes(Number(e.target.value))}>
              {RANGES.map((r) => (
                <option key={r.minutes} value={r.minutes}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="流">
            <Select value={streams} onChange={(e: any) => setStreams(e.target.value as any)}>
              <option value="all">全部</option>
              <option value="stdout">stdout</option>
              <option value="stderr">stderr</option>
            </Select>
          </Field>
          <Field label="每容器行数">
            <Select value={String(tailPer)} onChange={(e: any) => setTailPer(Number(e.target.value))}>
              <option value="100">100</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
              <option value="2000">2000</option>
            </Select>
          </Field>
          <Field label="关键字">
            <Input
              placeholder="过滤关键字"
              value={keyword}
              onChange={(e: any) => setKeyword(e.target.value)}
              onKeyDown={(e: any) => e.key === 'Enter' && query()}
            />
          </Field>
          <div className="logs-page__actions">
            <Button variant="primary" loading={loading} disabled={selected.length === 0} onClick={query}>
              查询
            </Button>
            <Button variant="secondary" disabled={!loaded} onClick={exportLogs}>
              导出
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="日志结果"
        extra={loaded ? <span className="logs-page__count">共 {total} 行{keyword ? `，命中过滤` : ''}</span> : undefined}
      >
        {loading ? (
          <SkeletonRows rows={10} />
        ) : !loaded ? (
          <Empty title="尚未查询" description="选择容器与条件后点击查询。" />
        ) : lines.length === 0 ? (
          <Empty title="无日志" description="当前条件下没有日志，试试放宽范围或关键字。" />
        ) : (
          <div className="logs-page__view">
            {lines.map(renderLine)}
          </div>
        )}
      </Card>
    </div>
  );
}
