/**
 * Compose 项目日志弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：快照拉取 + SSE 跟随刷新双模式，
 * 工具栏含时间/条数档位、级别 chips、搜索、时间戳、自动换行、清空、下载。
 * 条件渲染，挂载时按默认档位拉取一次。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Input, Select } from './Form';
import LogViewer, { LOG_MAX_RENDER_LINES } from './LogViewer';
import LogLevelFilter, { countLogLevels, filterLogContent, LogLevelFilterValue } from './LogLevelFilter';
import { useLogStream } from '../hooks/useLogStream';
import { useToast } from './Toast';
import { translateNow as t } from '../i18n';

interface ComposeLogModalProps {
  /** 项目名 */
  name: string;
  /** 初始服务名（可空 = 全部服务） */
  service?: string;
  onClose: () => void;
}

export default function ComposeLogModal({ name, service, onClose }: ComposeLogModalProps) {
  const { showToast } = useToast();
  const [logService, setLogService] = useState(service || '');
  const [logFull, setLogFull] = useState(false);
  // 日志工具栏状态（与容器日志弹窗一致）：时间范围 / 行数 / 时间戳 / 跟随刷新 / 自动换行 / 搜索
  const [logSince, setLogSince] = useState(0);
  const [logLines, setLogLines] = useState(0);
  const [logTs, setLogTs] = useState(false);
  const [logFollow, setLogFollow] = useState(false);
  const [logWrap, setLogWrap] = useState(false);
  const [logSearch, setLogSearch] = useState('');
  const [logContent, setLogContent] = useState('');
  const [logLoading, setLogLoading] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevelFilterValue>('all');

  const logPreRef = useRef<HTMLPreElement>(null);

  // SSE 跟随流 URL：弹窗打开且跟随开启时携带尾部档位/时间范围/时间戳/服务过滤
  const streamUrl = useMemo(() => {
    if (!logFollow) return '';
    const params = new URLSearchParams();
    if (logLines > 0) params.set('tail', String(logLines));
    else params.set('tail', String(logFull ? 0 : 200));
    if (logSince > 0) params.set('since', String(Math.floor(Date.now() / 1000) - logSince));
    if (logTs) params.set('timestamps', 'true');
    if (logService) params.set('service', logService);
    return `/api/compose/${encodeURIComponent(name)}/logs/stream?${params.toString()}`;
  }, [logFollow, name, logLines, logFull, logSince, logTs, logService]);
  const stream = useLogStream(streamUrl, { maxLines: 5000 });
  const streamText = useMemo(
    () => stream.lines.map((l) => l.text.replace(/\n+$/, '')).join('\n'),
    [stream.lines],
  );
  const streamTextRef = useRef('');
  streamTextRef.current = streamText;

  /**
   * 拉取项目日志（tail/since/timestamps 可覆盖；quiet 用于跟随刷新不闪 loading）
   */
  const fetchLog = useCallback(
    async (o?: { tail?: number; since?: number; ts?: boolean; quiet?: boolean }) => {
      const tail = o?.tail ?? (logLines > 0 ? logLines : logFull ? 0 : 200);
      const since = o?.since ?? logSince;
      const ts = o?.ts ?? logTs;
      if (!o?.quiet) setLogLoading(true);
      try {
        const res = await post<unknown>(`/api/compose/${encodeURIComponent(name)}/logs`, {
          tail,
          ...(since > 0 ? { since: Math.floor(Date.now() / 1000) - since } : {}),
          timestamps: ts || undefined,
          service: logService || undefined,
        });
        setLogContent(
          typeof res === 'string' ? res : (res && (res as any).logs) || JSON.stringify(res)
        );
      } catch (e: any) {
        if (!o?.quiet) showToast(e?.message || t('获取日志失败'), 'error');
      } finally {
        if (!o?.quiet) setLogLoading(false);
      }
    },
    [name, logService, logFull, logSince, logLines, logTs, showToast]
  );

  // 挂载时拉取最近日志（tail 200，可按服务过滤）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLogLoading(true);
      try {
        const res = await post<unknown>(`/api/compose/${encodeURIComponent(name)}/logs`, {
          tail: 200,
          service: logService || undefined,
        });
        if (!cancelled) {
          setLogContent(
            typeof res === 'string' ? res : (res && (res as any).logs) || JSON.stringify(res)
          );
        }
      } catch (e: any) {
        if (!cancelled) {
          setLogContent('');
          showToast(e?.message || t('获取日志失败'), 'error');
        }
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 切换跟随刷新：开启时清空快照改由 SSE 重发尾部历史 + 增量；
   * 关闭时把当前流内容固化为快照，保持视图连续
   */
  function toggleFollow() {
    const next = !logFollow;
    if (next) {
      setLogContent('');
    } else {
      setLogContent(streamTextRef.current);
    }
    setLogFollow(next);
  }

  /** 滚轮向上滚动时暂停跟随（固化的内容保持不变） */
  function disableFollow() {
    if (!logFollow) return;
    setLogContent(streamTextRef.current);
    setLogFollow(false);
  }

  /** 新内容到达且跟随刷新开启时滚动到底部 */
  useEffect(() => {
    if (!logFollow) return;
    const el = logPreRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logFollow, streamText]);

  // 展示内容：跟随模式取流式内容，否则取快照；级别 chips 在前端过滤
  const displayContent = logFollow ? streamText : logContent;
  const levelCounts = useMemo(() => countLogLevels(displayContent), [displayContent]);
  const filteredContent = useMemo(
    () => (logLevelFilter === 'all' ? displayContent : filterLogContent(displayContent, logLevelFilter)),
    [displayContent, logLevelFilter],
  );

  const refreshLog = useCallback(() => fetchLog(), [fetchLog]);

  return (
    <Modal
      open
      title={logService ? t('{{logName}} - {{service}} 日志', { logName: name, service: logService }) : t('{{logName}} - 日志', { logName: name })}
      onClose={onClose}
      width={760}
      fullscreen={logFull}
      onToggleFullscreen={() => {
        const next = !logFull;
        setLogFull(next);
        // 放大后自动拉取全部日志，还原回当前档位（条数或最近 200 行）；跟随模式下经流式 URL 重建生效
        if (!logFollow) fetchLog({ tail: next ? 0 : logLines > 0 ? logLines : 200 });
      }}
      footer={
        <>
          <Button variant="secondary" onClick={refreshLog} loading={logLoading} disabled={logFollow}>
            {t('刷新')}
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(displayContent);
                showToast(t('已复制'), 'success');
              } catch {
                showToast(t('复制失败'), 'error');
              }
            }}
          >
            {t('复制')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const blob = new Blob([displayContent], { type: 'text/plain;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${name || 'compose'}.log`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            disabled={!displayContent}
          >
            {t('下载')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('关闭')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select
          value={logLines > 0 ? `l${logLines}` : String(logSince)}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('l')) {
              const n = Number(v.slice(1));
              setLogLines(n);
              setLogSince(0);
              if (!logFollow) fetchLog({ since: 0, tail: n });
            } else {
              setLogLines(0);
              setLogSince(Number(v));
              if (!logFollow) fetchLog({ since: Number(v), tail: 0 });
            }
          }}
          style={{ width: 136 }}
        >
          <option value="0">{t('所有')}</option>
          <option value="600">{t('最近 10 分钟')}</option>
          <option value="3600">{t('最近 1 小时')}</option>
          <option value="14400">{t('最近 4 小时')}</option>
          <option value="86400">{t('最近 1 天')}</option>
          <option value="l100">{t('最近 100 行')}</option>
          <option value="l200">{t('最近 200 行')}</option>
          <option value="l500">{t('最近 500 行')}</option>
          <option value="l1000">{t('最近 1000 行')}</option>
        </Select>
        <LogLevelFilter
          value={logLevelFilter}
          onChange={setLogLevelFilter}
          errorCount={levelCounts.error}
          warnCount={levelCounts.warn}
          labels={{ all: t('全部'), error: t('错误'), warn: t('警告') }}
        />
        <Input
          placeholder={t('在日志中搜索…')}
          value={logSearch}
          onChange={(e) => setLogSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <Button variant={logFollow ? 'primary' : 'secondary'} size="sm" onClick={toggleFollow} style={{ minWidth: 88 }}>
          {logFollow ? t('跟随中') : t('跟随刷新')}
        </Button>
        <Button
          variant={logTs ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => {
            const nv = !logTs;
            setLogTs(nv);
            if (!logFollow) fetchLog({ ts: nv });
          }}
        >
          {t('时间戳')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setLogContent('');
            stream.clear();
          }}
        >
          {t('清空')}
        </Button>
        <span style={{ fontSize: 12, opacity: 0.7, whiteSpace: 'nowrap', minWidth: 72, textAlign: 'right' }}>
          {logSearch
            ? `${displayContent.split('\n').filter((l) => l.toLowerCase().includes(logSearch.toLowerCase())).length} ${t('条命中')}`
            : `${displayContent.split('\n').length - 1} ${t('行')}`}
        </span>
        <Button variant={logWrap ? 'primary' : 'secondary'} size="sm" onClick={() => setLogWrap((v) => !v)}>
          {t('自动换行')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const el = logPreRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          {t('到底部')}
        </Button>
        {logFollow && stream.error && <span style={{ fontSize: 12, color: '#e5484d' }}>{stream.error}</span>}
      </div>
      {logLoading && !displayContent ? (
        <div className="log-empty">{t('正在拉取日志…')}</div>
      ) : (
        <LogViewer
          content={filteredContent}
          emptyText={t('（暂无日志）')}
          truncatedText={t('（日志较长，仅显示最近 {{count}} 行）', { count: LOG_MAX_RENDER_LINES })}
          showLineNumbers
          search={logSearch}
          wrap={logWrap}
          preRef={logPreRef}
          onWheel={disableFollow}
        />
      )}
    </Modal>
  );
}
