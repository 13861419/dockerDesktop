import React, { useMemo } from 'react';
import { detectLogLevel } from '../utils/logLevel';
import './LogViewer.less';

export const LOG_MAX_RENDER_LINES = 3000;

/**
 * 日志查看器：按行着色（错误=红 / 警告=黄），渲染行数封顶防大日志卡顿；
 * 可选行号、关键字高亮与滚动容器引用（跟随刷新自动滚底用）
 */
export default function LogViewer({
  content,
  emptyText,
  truncatedText,
  showLineNumbers = false,
  search = '',
  wrap = false,
  preRef,
  onWheel,
}: {
  content: string;
  emptyText?: string;
  truncatedText?: string;
  showLineNumbers?: boolean;
  search?: string;
  wrap?: boolean;
  preRef?: React.RefObject<HTMLPreElement>;
  onWheel?: React.WheelEventHandler<HTMLPreElement>;
}) {
  const view = useMemo(() => {
    const all = (content || '').split('\n');
    const truncated = all.length > LOG_MAX_RENDER_LINES;
    return { lines: truncated ? all.slice(-LOG_MAX_RENDER_LINES) : all, truncated };
  }, [content]);

  if (!content) return <pre ref={preRef} className="log-viewer">{emptyText || ''}</pre>;

  const q = search.trim().toLowerCase();

  const renderText = (line: string) => {
    if (!q) return line;
    const idx = line.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return line;
    return (
      <>
        {line.slice(0, idx)}
        <mark>{line.slice(idx, idx + q.length)}</mark>
        {line.slice(idx + q.length)}
      </>
    );
  };

  return (
    <pre
      ref={preRef}
      className={`log-viewer${wrap ? ' log-viewer--wrap' : ''}`}
      onWheel={onWheel}
    >
      {view.truncated && (
        <div className="log-line log-line--meta">{truncatedText || '…'}</div>
      )}
      {view.lines.map((line, i) => {
        const level = detectLogLevel(line);
        return (
          <div key={i} className={level ? `log-line log-line--${level}` : 'log-line'}>
            {showLineNumbers && <span className="log-line__no">{i + 1}</span>}
            {renderText(line) || '\u00a0'}
          </div>
        );
      })}
    </pre>
  );
}
