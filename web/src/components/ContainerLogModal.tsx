/**
 * 容器日志查看弹窗
 *
 * 从容器列表页抽出（1.92.0 重构）：SSE 跟随流 + 快照双模式、级别筛选 chips、
 * 时间范围 / 条数 / 时间戳 / 搜索高亮 / 复制 / 下载，行为与拆分前保持一致。
 * 挂载即打开、卸载即关闭——由调用方条件渲染控制生命周期，内部状态随挂载重置。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Input, Select } from './Form';
import { useToast } from './Toast';
import { detectLogLevel } from '../utils/logLevel';
import LogLevelFilter, { LogLevelFilterValue } from './LogLevelFilter';
import { useLogStream } from '../hooks/useLogStream';
import { useLang } from '../i18n';

/** 目标容器（由调用方在打开时提供） */
interface ContainerLogModalProps {
  target: { id: string; name: string };
  onClose: () => void;
}

/** 单条日志行 */
interface LogLine {
  text: string;
  level: 'error' | 'warn' | null;
}

export default function ContainerLogModal({ target, onClose }: ContainerLogModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  // 日志弹窗中的实时日志内容（每行一个对象，区分 stdout/stderr）
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  // 日志是否加载中
  const [logLoading, setLogLoading] = useState(false);
  // 日志行数上限（tail 参数）
  const [logTail, setLogTail] = useState(300);
  // 跟随刷新 / 自动换行 / 内联搜索（放大/还原由 Modal 统一提供）
  const [logFollow, setLogFollow] = useState(false);
  const [logWrap, setLogWrap] = useState(true);
  const [logSearch, setLogSearch] = useState('');
  // 时间范围过滤（秒，0 = 所有）与时间戳显示开关
  const [logSince, setLogSince] = useState(0);
  const [logTs, setLogTs] = useState(false);
  const logScrollRef = useRef<HTMLDivElement>(null);

  // 跟随模式（1.92.0）：SSE 增量推送替代 3 秒轮询；条数/时间范围/时间戳变化经流式 URL 重建自动重连
  const streamUrl = useMemo(() => {
    if (!logFollow) return null;
    const params = new URLSearchParams();
    params.set('tail', String(logTail));
    if (logSince > 0) params.set('since', String(Math.floor(Date.now() / 1000) - logSince));
    if (logTs) params.set('timestamps', 'true');
    return `/api/containers/${encodeURIComponent(target.id)}/logs/stream?${params.toString()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id, logFollow, logTail, logSince, logTs]);
  const stream = useLogStream(streamUrl, { maxLines: 5000 });
  const streamLines = useMemo(
    () => stream.lines.map((l) => ({ text: l.text.replace(/\n+$/, ''), level: detectLogLevel(l.text) })),
    [stream.lines],
  );
  const streamTextRef = useRef('');
  streamTextRef.current = streamLines.map((l) => l.text).join('\n');

  /**
   * 拉取容器尾部日志（GET /api/containers/:id/logs），按行拆分为日志行列表
   * @param id 容器 ID
   * @param tail 尾部行数
   */
  async function loadLogs(id: string, tail: number, since = logSince, ts = logTs) {
    setLogLoading(true);
    try {
      const res = await get<{ logs: string }>('/api/containers/' + id + '/logs', {
        tail,
        ...(since > 0 ? { since: Math.floor(Date.now() / 1000) - since } : {}),
        ...(ts ? { timestamps: 'true' } : {}),
      });
      const text = res?.logs || '';
      const lines = text
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map((l) => ({ text: l, level: detectLogLevel(l) }));
      setLogLines(lines);
      setLogTail(tail);
    } catch (e: any) {
      setLogLines([{ text: t('（拉取日志失败：{{msg}}）', { msg: e?.message || t('未知错误') }), level: 'error' as const }]);
    } finally {
      setLogLoading(false);
    }
  }

  // 挂载即按默认条数拉取尾部日志（对齐拆分前 openLogs 的首拉行为）
  useEffect(() => {
    loadLogs(target.id, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  /** 切换跟随：开启走 SSE 增量流；关闭时把当前流内容固化为快照，保持视图连续 */
  function toggleFollow() {
    const next = !logFollow;
    if (next) {
      setLogLines([]);
    } else {
      setLogLines(streamTextRef.current.split('\n').map((t) => ({ text: t, level: detectLogLevel(t) })));
    }
    setLogFollow(next);
  }

  /** 滚轮向上滚动时退出跟随（固化当前流内容） */
  function disableFollow() {
    if (!logFollow) return;
    setLogLines(streamTextRef.current.split('\n').map((t) => ({ text: t, level: detectLogLevel(t) })));
    setLogFollow(false);
  }

  /** 跟随模式开启时自动滚动到底部（流式批量更新触发） */
  useEffect(() => {
    if (!logFollow) return;
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logFollow, streamLines]);

  /** 复制全部日志到剪贴板 */
  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logLines.map((l) => l.text).join('\n'));
      showToast(t('已复制到剪贴板'));
    } catch {
      showToast(t('复制失败'), 'error');
    }
  }

  /**
   * 重新按当前行数设置拉取日志（供"刷新"按钮使用）
   */
  async function reloadLogs() {
    await loadLogs(target.id, logTail);
  }

  /** 打开日志弹窗后按当前 tail 重新拉取 */
  async function handleLogTailChange(tail: number) {
    setLogTail(tail);
    if (!logFollow) await loadLogs(target.id, tail);
  }

  /** 切换时间范围过滤（秒，0 = 所有）后重新拉取 */
  async function handleLogSinceChange(since: number) {
    setLogSince(since);
    if (!logFollow) await loadLogs(target.id, logTail, since, logTs);
  }

  /** 切换时间戳显示后重新拉取 */
  async function handleLogTsToggle() {
    const next = !logTs;
    setLogTs(next);
    if (!logFollow) await loadLogs(target.id, logTail, logSince, next);
  }

  /** 清空当前显示的日志（仅清视图；跟随模式下 SSE 尾部历史会在重连后重发） */
  function clearLogs() {
    setLogLines([]);
    stream.clear();
  }

  // 级别筛选 chips（1.92.0）：派生计数与过滤后的行（levels 已在 loadLogs / 流式映射时算好）
  const [logLevelFilter, setLogLevelFilter] = useState<LogLevelFilterValue>('all');
  const baseLines = logFollow ? streamLines : logLines;
  const logLevelCounts = useMemo(
    () => ({
      error: baseLines.filter((l) => l.level === 'error').length,
      warn: baseLines.filter((l) => l.level === 'warn').length,
    }),
    [baseLines],
  );
  const shownLogLines = logLevelFilter === 'all' ? baseLines : baseLines.filter((l) => l.level === logLevelFilter);

  /**
   * 下载容器日志为文本文件（GET /api/containers/:id/logs/download）
   */
  function downloadLogs() {
    const token = localStorage.getItem('token');
    const url = '/api/containers/' + encodeURIComponent(target.id) + '/logs/download';
    // 自带鉴权：必须用 fetch 携带 Authorization 头
    fetch(url, {
      headers: token ? { Authorization: 'Bearer ' + token } : undefined,
    })
      .then((res) => {
        if (!res.ok) throw new Error(t('下载失败 ({{code}})', { code: res.status }));
        return res.blob();
      })
      .then((blob) => {
        const a = document.createElement('a');
        const objectUrl = URL.createObjectURL(blob);
        a.href = objectUrl;
        a.download = (target.name || 'container') + '.log';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      })
      .catch((e) => showToast(e?.message || t('下载日志失败'), 'error'));
  }

  return (
    <Modal
      open={true}
      title={t('容器日志 - {{v1}}', { v1: target.name })}
      width={860}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={reloadLogs} loading={logLoading} disabled={logFollow}>
            {t('刷新')}
          </Button>
          <Button variant="secondary" onClick={copyLogs}>
            {t('复制')}
          </Button>
          <Button variant="secondary" onClick={downloadLogs}>
            {t('下载')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('关闭')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select value={String(logSince)} onChange={(e) => handleLogSinceChange(Number(e.target.value))} style={{ width: 136 }}>
          <option value="0">{t('所有')}</option>
          <option value="600">{t('最近 10 分钟')}</option>
          <option value="3600">{t('最近 1 小时')}</option>
          <option value="14400">{t('最近 4 小时')}</option>
          <option value="86400">{t('最近 1 天')}</option>
        </Select>
        <Select value={String(logTail)} onChange={(e) => handleLogTailChange(Number(e.target.value))} style={{ width: 136 }}>
          <option value="100">{t('最近 100 行')}</option>
          <option value="200">{t('最近 200 行')}</option>
          <option value="500">{t('最近 500 行')}</option>
          <option value="1000">{t('最近 1000 行')}</option>
          <option value="0">{t('全部')}</option>
        </Select>
        <LogLevelFilter
          value={logLevelFilter}
          onChange={setLogLevelFilter}
          errorCount={logLevelCounts.error}
          warnCount={logLevelCounts.warn}
          labels={{ all: t('全部'), error: t('错误'), warn: t('警告') }}
        />
        <Button variant={logFollow ? 'primary' : 'secondary'} size="sm" onClick={toggleFollow}>
          {logFollow ? t('跟随中') : t('跟随刷新')}
        </Button>
        <Button variant={logTs ? 'primary' : 'secondary'} size="sm" onClick={handleLogTsToggle}>
          {t('时间戳')}
        </Button>
        <Button variant="secondary" size="sm" onClick={clearLogs}>
          {t('清空')}
        </Button>
        {logFollow && stream.error && <span style={{ fontSize: 12, color: '#e5484d' }}>{stream.error}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input
          placeholder={t('在日志中搜索…')}
          value={logSearch}
          onChange={(e) => setLogSearch(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <span style={{ fontSize: 12, opacity: 0.7, whiteSpace: 'nowrap' }}>
          {logSearch
            ? `${shownLogLines.filter((l) => l.text.toLowerCase().includes(logSearch.toLowerCase())).length} ${t('条命中')}`
            : `${shownLogLines.length} ${t('行')}`}
        </span>
        <Button variant={logWrap ? 'primary' : 'secondary'} size="sm" onClick={() => setLogWrap((v) => !v)}>
          {t('自动换行')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const el = logScrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          {t('到底部')}
        </Button>
      </div>
      <div
        ref={logScrollRef}
        className="containers__log-scroll"
        onWheel={disableFollow}
        style={{
          background: 'var(--bg-code, #1e1e1e)',
          color: 'var(--text-code, #d4d4d4)',
          borderRadius: 8,
          padding: 12,
          overflow: 'auto',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: logWrap ? 'pre-wrap' : 'pre',
          wordBreak: logWrap ? 'break-all' : 'normal',
        }}
      >
        {logLoading && shownLogLines.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>{t('加载日志中…')}</span>
        ) : shownLogLines.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>{t('暂无日志输出')}</span>
        ) : (
          shownLogLines.map((l, i) => {
            const hit = logSearch && l.text.toLowerCase().includes(logSearch.toLowerCase());
            let rendered: React.ReactNode = l.text;
            if (logSearch) {
              const idx = l.text.toLowerCase().indexOf(logSearch.toLowerCase());
              if (idx >= 0) {
                rendered = (
                  <>
                    {l.text.slice(0, idx)}
                    <mark style={{ background: '#ffd54f', color: '#000' }}>{l.text.slice(idx, idx + logSearch.length)}</mark>
                    {l.text.slice(idx + logSearch.length)}
                  </>
                );
              }
            }
            return (
              <div
                key={i}
                style={{
                  color: l.level === 'error' ? 'var(--danger, #ff6b6b)' : l.level === 'warn' ? 'var(--warning, #e6b450)' : undefined,
                  whiteSpace: logWrap ? 'pre-wrap' : 'pre',
                  wordBreak: logWrap ? 'break-all' : 'normal',
                  background: hit && logSearch ? 'rgba(255, 213, 79, 0.12)' : undefined,
                }}
              >
                <span style={{ opacity: 0.45, userSelect: 'none', marginRight: 8, display: 'inline-block', minWidth: 38, textAlign: 'right' }}>
                  {i + 1}
                </span>
                {rendered}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
