/**
 * 日志级别筛选 chips（全部 / 错误 / 警告）
 *
 * 单选分段式：当前选中项高亮；错误/警告 chip 附带命中计数，便于一眼判断日志健康度。
 * 纯展示组件，过滤逻辑由调用方对行数据执行 detectLogLevel 后完成。
 */
import Button from './Button';
import { detectLogLevel } from '../utils/logLevel';

export type LogLevelFilterValue = 'all' | 'error' | 'warn';

/** 从多行文本统计各级别行数（一次遍历） */
export function countLogLevels(content: string): { error: number; warn: number } {
  let error = 0;
  let warn = 0;
  for (const line of (content || '').split('\n')) {
    const level = detectLogLevel(line);
    if (level === 'error') error += 1;
    else if (level === 'warn') warn += 1;
  }
  return { error, warn };
}

/** 按级别过滤多行文本（保留空行与不匹配行之外的全部内容） */
export function filterLogContent(content: string, value: LogLevelFilterValue): string {
  if (value === 'all') return content || '';
  const kept = (content || '').split('\n').filter((line) => {
    if (!line) return true;
    return detectLogLevel(line) === value;
  });
  return kept.join('\n');
}

/**
 * 级别筛选 chips
 * @param value 当前选中级别
 * @param onChange 切换回调
 * @param errorCount 错误行数（用于 chip 计数展示）
 * @param warnCount 警告行数
 * @param labels 文案（调用方经 t() 翻译后传入）
 */
export default function LogLevelFilter({
  value,
  onChange,
  errorCount,
  warnCount,
  labels,
}: {
  value: LogLevelFilterValue;
  onChange: (v: LogLevelFilterValue) => void;
  errorCount: number;
  warnCount: number;
  labels: { all: string; error: string; warn: string };
}) {
  const chips: Array<{ key: LogLevelFilterValue; label: string; count: number }> = [
    { key: 'all', label: labels.all, count: 0 },
    { key: 'error', label: labels.error, count: errorCount },
    { key: 'warn', label: labels.warn, count: warnCount },
  ];
  return (
    <div style={{ display: 'inline-flex', gap: 4 }} role="group" aria-label={labels.all}>
      {chips.map((c) => (
        <Button
          key={c.key}
          variant={value === c.key ? 'primary' : 'secondary'}
          size="sm"
          style={{ minWidth: 56 }}
          onClick={() => onChange(c.key)}
        >
          {c.key === 'all' || c.count === 0 ? c.label : `${c.label} ${c.count}`}
        </Button>
      ))}
    </div>
  );
}
