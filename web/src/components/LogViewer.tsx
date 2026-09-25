import { useMemo } from 'react';
import { detectLogLevel } from '../utils/logLevel';
import './LogViewer.less';

export const LOG_MAX_RENDER_LINES = 3000;

/**
 * 日志查看器：按行着色（错误=红 / 警告=黄），渲染行数封顶防大日志卡顿
 */
export default function LogViewer({
  content,
  emptyText,
  truncatedText,
}: {
  content: string;
  emptyText?: string;
  truncatedText?: string;
}) {
  const view = useMemo(() => {
    const all = (content || '').split('\n');
    const truncated = all.length > LOG_MAX_RENDER_LINES;
    return { lines: truncated ? all.slice(-LOG_MAX_RENDER_LINES) : all, truncated };
  }, [content]);

  if (!content) return <pre className="log-viewer">{emptyText || ''}</pre>;

  return (
    <pre className="log-viewer">
      {view.truncated && (
        <div className="log-line log-line--meta">{truncatedText || '…'}</div>
      )}
      {view.lines.map((line, i) => {
        const level = detectLogLevel(line);
        return (
          <div key={i} className={level ? `log-line log-line--${level}` : 'log-line'}>
            {line || '\u00a0'}
          </div>
        );
      })}
    </pre>
  );
}
