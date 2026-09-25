export type LogLevel = 'error' | 'warn' | null;

const ERROR_RE = /\b(error|err|fatal|panic|exception|traceback)\b/i;
const WARN_RE = /\b(warn|warning)\b/i;

/**
 * 检测单行日志级别：错误类（红）/ 警告类（黄）/ 其他（默认色）
 * 关键字按单词边界匹配，避免 "no error"、"0 errors" 这类包含子串的行误报过重
 */
export function detectLogLevel(line: string): LogLevel {
  if (ERROR_RE.test(line)) return 'error';
  if (WARN_RE.test(line)) return 'warn';
  return null;
}
