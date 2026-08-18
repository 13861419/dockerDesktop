/**
 * 轻量 YAML 编辑器组件
 *
 * 提供等宽字体编辑 + 行号 + 基础 YAML 语法着色 + 错误行标注。
 * 实现采用"透明 textarea 覆盖高亮 pre"的经典方案：
 * - textarea 文字设为透明（仅保留可见光标），用户始终在其上编辑；
 * - 下层 <pre> 通过 dangerouslySetInnerHTML 渲染已转义 + 着色的 HTML，随滚动自动同步；
 * - 行号栏独立，通过滚动事件与编辑区保持同步；
 * - 语法着色按行单遍扫描，避免正则嵌套破坏，且所有回显内容均经 HTML 转义，无注入风险。
 */
import { useMemo, useRef } from 'react';
import './YamlEditor.less';

/** 行高的像素值（用于行号与编辑区逐行对齐） */
const LINE_H = 19.2;

/**
 * 将单个字符转义为 HTML 实体（防止注入并保证显示正确）
 * @param s 原始字符串
 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 对单个 YAML 行做语法着色（单遍扫描，保证不会死循环也不会嵌套破坏）
 * 支持的 token：注释 / 字符串 / 数字 / 布尔 / 键
 * @param line 单行文本
 */
function highlightLine(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    // 注释：到行尾
    if (ch === '#') {
      out += '<span class="yl cm">' + esc(line.slice(i)) + '</span>';
      break;
    }
    // 单双引号字符串（含转义）
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === q) {
          j++;
          break;
        }
        j++;
      }
      out += '<span class="yl st">' + esc(line.slice(i, j)) + '</span>';
      i = j;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch)) {
      const num = line.slice(i).match(/^\d+(?:\.\d+)?/);
      if (num) {
        out += '<span class="yl nu">' + esc(num[0]) + '</span>';
        i += num[0].length;
        continue;
      }
    }
    // 布尔 / null
    if (/[A-Za-z]/.test(ch)) {
      const word = line.slice(i).match(/^[A-Za-z]+/);
      if (word && /^(true|false|null)$/.test(word[0])) {
        out += '<span class="yl bo">' + esc(word[0]) + '</span>';
        i += word[0].length;
        continue;
      }
    }
    // 键：以字母/_ 开头，后跟可选空格 + 冒号
    if (/[A-Za-z_]/.test(ch)) {
      const key = line.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.-]*/);
      if (key && key[0]) {
        let k = i + key[0].length;
        while (k < line.length && line[k] === ' ') k++;
        if (k < line.length && line[k] === ':') {
          out += '<span class="yl ke">' + esc(key[0]) + '</span>';
          i += key[0].length;
          continue;
        }
      }
    }
    // 普通字符：逐字符追加（保证 i 前进，避免死循环）
    out += esc(ch);
    i++;
  }
  return out;
}

/**
 * 将整个 YAML 文本着色为 HTML（逐行处理）
 * @param src YAML 文本
 */
function highlightYaml(src: string): string {
  return src
    .split('\n')
    .map((line) => highlightLine(line))
    .join('\n');
}

interface YamlEditorProps {
  /** 编辑器内容 */
  value: string;
  /** 内容变化回调 */
  onChange?: (v: string) => void;
  /** 显示行数（决定编辑器初始高度） */
  rows?: number;
  /** 出错行号（从 1 起），用于行号栏标红 */
  errorLine?: number | null;
  /** 错误提示文本（显示在编辑器下方） */
  errorMessage?: string;
  /** 占位提示（内容为空时显示） */
  placeholder?: string;
  /** 是否只读 */
  readOnly?: boolean;
  /** 是否禁用编辑（灰显） */
  disabled?: boolean;
}

/**
 * 轻量 YAML 编辑器，默认导出组件
 */
export default function YamlEditor({
  value,
  onChange,
  rows = 10,
  errorLine,
  errorMessage,
  placeholder,
  readOnly = false,
  disabled = false,
}: YamlEditorProps) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const lineCount = value.split('\n').length;
  // 内容为空且无占位时，pre 渲染单个空格避免塌陷
  const html = useMemo(() => {
    if (!value) {
      return placeholder ? `<span class="yl ph">${esc(placeholder)}</span>` : '&nbsp;';
    }
    return highlightYaml(value);
  }, [value, placeholder]);

  /** 同步行号栏与编辑区滚动位置 */
  const syncScroll = () => {
    if (gutterRef.current && scrollRef.current) {
      gutterRef.current.scrollTop = scrollRef.current.scrollTop;
    }
  };

  return (
    <div className={`yaml-editor${disabled ? ' yaml-editor--disabled' : ''}`}>
      <div className="yaml-editor__body">
        <div className="yaml-editor__gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <div
              key={i}
              className={`yaml-editor__ln${errorLine === i + 1 ? ' yaml-editor__ln--err' : ''}`}
              style={{ height: LINE_H }}
            >
              {i + 1}
            </div>
          ))}
        </div>
        <div className="yaml-editor__scroll" ref={scrollRef} onScroll={syncScroll}>
          <pre className="yaml-editor__pre" dangerouslySetInnerHTML={{ __html: html }} />
          <textarea
            className="yaml-editor__ta"
            style={{ height: rows * LINE_H + 16 }}
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            readOnly={readOnly}
            disabled={disabled}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
          />
        </div>
      </div>
      {errorMessage && <div className="yaml-editor__error">⚠ {errorMessage}</div>}
    </div>
  );
}
