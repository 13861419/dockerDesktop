/**
 * 运维工具箱页面
 *
 * 纯前端实现常用运维小工具，全部在浏览器内完成、零后端请求、零第三方依赖：
 * - JSON 校验/格式化/压缩
 * - 正则表达式测试
 * - Base64 编解码
 * - 时间戳 ↔ 日期互转
 * - 进制转换（2/8/10/16）
 * - 端口范围解析 + IPv4 网段计算
 */
import { useMemo, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import { translateNow as t } from '../i18n';
import './tools.less';

/** 通用文本域 */
function TextArea(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <textarea
      className={`tools-ta ${props.mono ? 'tools-ta--mono' : ''}`}
      value={props.value}
      placeholder={props.placeholder}
      rows={props.rows ?? 4}
      onChange={(e) => props.onChange(e.target.value)}
      spellCheck={false}
    />
  );
}

/** 结果输出区（只读） */
function Out({ text, ok, placeholder = t('结果') }: { text: string; ok?: boolean; placeholder?: string }) {
  return (
    <div className={`tools-out ${ok === false ? 'tools-out--err' : ''}`}>
      {text || <span className="tools-out__ph">{placeholder}</span>}
    </div>
  );
}

// ---------- JSON 工具 ----------

function JsonTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  function run(mode: 'format' | 'minify') {
    if (!input.trim()) return;
    try {
      const obj = JSON.parse(input);
      setOutput(mode === 'format' ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
      setOutput('');
    }
  }

  return (
    <Card title={t('JSON 校验 / 格式化')}>
      <TextArea value={input} onChange={setInput} placeholder={t('粘贴 JSON，例如 {"a":1}')} rows={5} mono />
      <div className="tools-row">
        <Button size="sm" onClick={() => run('format')}>{t('格式化')}</Button>
        <Button size="sm" variant="secondary" onClick={() => run('minify')}>{t('压缩')}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setInput(''); setOutput(''); setError(''); }}>{t('清空')}</Button>
      </div>
      {error && <div className="tools-err">✗ {error}</div>}
      <Out text={output} ok={!error} placeholder={t('格式化结果')} />
    </Card>
  );
}

// ---------- 正则测试 ----------

function RegexTool() {
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('g');
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const { matches, ok } = useMemo(() => {
    setError('');
    if (!pattern) return { matches: [] as string[], ok: true };
    try {
      const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
      const found = [...(text.matchAll(re))].map((m) => m[0]);
      return { matches: found, ok: true };
    } catch (e: any) {
      setError(e?.message || String(e));
      return { matches: [], ok: false };
    }
  }, [pattern, flags, text]);

  return (
    <Card title={t('正则表达式测试')}>
      <div className="tools-inline">
        <span className="tools-label">/</span>
        <input className="tools-input tools-input--grow tools-mono" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t('正则表达式')} />
        <span className="tools-label">/</span>
        <input className="tools-input tools-input--flags tools-mono" value={flags} onChange={(e) => setFlags(e.target.value)} placeholder="g" />
      </div>
      <TextArea value={text} onChange={setText} placeholder={t('待匹配文本')} rows={4} mono />
      {error && <div className="tools-err">✗ {error}</div>}
      <div className="tools-hint">
        {ok && pattern ? t('匹配 {{v1}} 处', { v1: matches.length }) : t('输入正则与文本开始测试')}
      </div>
      {matches.length > 0 && (
        <div className="tools-out">
          {matches.slice(0, 50).map((m, i) => (
            <div key={i} className="tools-out__line">[{i + 1}] {m}</div>
          ))}
          {matches.length > 50 && <div className="tools-out__line">… 共 {matches.length} 条</div>}
        </div>
      )}
    </Card>
  );
}

// ---------- Base64 ----------

function Base64Tool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');

  /** 编码：TextEncoder 处理多字节字符，避免 btoa 中文报错 */
  function encode() {
    try {
      const bytes = new TextEncoder().encode(input);
      let bin = '';
      bytes.forEach((b) => { bin += String.fromCharCode(b); });
      setOutput(btoa(bin));
    } catch (e: any) {
      setOutput(t('编码失败: {{v1}}', { v1: e?.message || e }));
    }
  }

  /** 解码：atob 输出二进制串，TextDecoder 还原 UTF-8 */
  function decode() {
    try {
      const bin = atob(input.trim());
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      setOutput(new TextDecoder().decode(bytes));
    } catch (e: any) {
      setOutput(t('解码失败: {{v1}}', { v1: e?.message || e }));
    }
  }

  return (
    <Card title={t('Base64 编解码')}>
      <TextArea value={input} onChange={setInput} placeholder={t('输入文本或 Base64')} rows={3} mono />
      <div className="tools-row">
        <Button size="sm" onClick={encode}>{t('编码 →')}</Button>
        <Button size="sm" variant="secondary" onClick={decode}>{t('← 解码')}</Button>
      </div>
      <Out text={output} />
    </Card>
  );
}

// ---------- 时间戳 ----------

function TimestampTool() {
  const [ts, setTs] = useState('');
  const [date, setDate] = useState('');
  const [result, setResult] = useState('');

  function tsToDate() {
    const n = Number(ts.trim());
    if (!Number.isFinite(n) || ts.trim() === '') { setResult(t('请输入有效数字')); return; }
    // 自动识别秒（10 位）/毫秒（13 位）
    const ms = ts.trim().length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    if (isNaN(d.getTime())) { setResult(t('时间戳超出范围')); return; }
    setResult(`${d.toLocaleString()}（ISO: ${d.toISOString()}）`);
  }

  function dateToTs() {
    const d = new Date(date);
    if (isNaN(d.getTime())) { setResult(t('请输入有效日期，如 2026-01-01 08:00:00')); return; }
    setResult(t('秒: {{v1}}    毫秒: {{v2}}', { v1: Math.floor(d.getTime() / 1000), v2: d.getTime() }));
  }

  function fillNow() {
    const now = Date.now();
    setResult(t('当前时间戳 — 秒: {{v1}}    毫秒: {{now}}', { v1: Math.floor(now / 1000), now }));
  }

  return (
    <Card title={t('时间戳 ↔ 日期')} extra={<Button size="sm" variant="ghost" onClick={fillNow}>{t('当前时间')}</Button>}>
      <div className="tools-inline">
        <input className="tools-input tools-input--grow tools-mono" value={ts} onChange={(e) => setTs(e.target.value)} placeholder={t('时间戳（秒或毫秒）')} />
        <Button size="sm" onClick={tsToDate}>{t('→ 日期')}</Button>
      </div>
      <div className="tools-inline">
        <input className="tools-input tools-input--grow" value={date} onChange={(e) => setDate(e.target.value)} placeholder={t('日期，如 2026-01-01 08:00:00')} />
        <Button size="sm" variant="secondary" onClick={dateToTs}>{t('→ 时间戳')}</Button>
      </div>
      <Out text={result} />
    </Card>
  );
}

// ---------- 进制转换 ----------

function RadixTool() {
  const [input, setInput] = useState('');
  const [from, setFrom] = useState(10);
  const [result, setResult] = useState('');

  function convert() {
    const trimmed = input.trim();
    if (!trimmed) { setResult(''); return; }
    const n = parseInt(trimmed, from);
    if (isNaN(n) || n < 0) { setResult(t('无法解析该数字（仅支持非负整数）')); return; }
    setResult([2, 8, 10, 16].map((b) => t('{{b}} 进制: {{v2}}{{v3}}', { b, v2: n.toString(b), v3: b === 16 ? t('（0x{{v}}）', { v: n.toString(16).toUpperCase() }) : '' })).join('    '));
  }

  return (
    <Card title={t('进制转换')}>
      <div className="tools-inline">
        <input className="tools-input tools-input--grow tools-mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('输入数字')} onKeyDown={(e) => e.key === 'Enter' && convert()} />
        <select className="tools-input" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
          <option value={2}>{t('二进制')}</option>
          <option value={8}>{t('八进制')}</option>
          <option value={10}>{t('十进制')}</option>
          <option value={16}>{t('十六进制')}</option>
        </select>
        <Button size="sm" onClick={convert}>{t('转换')}</Button>
      </div>
      <Out text={result} />
    </Card>
  );
}

// ---------- 端口 / 网段计算 ----------

function PortSubnetTool() {
  const [ports, setPorts] = useState('');
  const [cidr, setCidr] = useState('');
  const [result, setResult] = useState('');

  /** 解析 "8000-9000, 80,443" 形式的端口列表 */
  function parsePorts() {
    const parts = ports.split(/[,\s]+/).filter(Boolean);
    let count = 0;
    const ranges: string[] = [];
    try {
      for (const p of parts) {
        if (p.includes('-')) {
          const [a, b] = p.split('-').map(Number);
          if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > 65535 || a > b) throw new Error(t('非法范围: {{p}}', { p }));
          count += b - a + 1;
          ranges.push(`${a}-${b}`);
        } else {
          const n = Number(p);
          if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(t('非法端口: {{p}}', { p }));
          count += 1;
          ranges.push(`${n}`);
        }
      }
      setResult(t('共 {{count}} 个端口：{{v2}}', { count, v2: ranges.join(', ') }));
    } catch (e: any) {
      setResult(e?.message || String(e));
    }
  }

  /** IPv4 CIDR 计算：网络地址 / 广播地址 / 掩码 / 可用主机数 */
  function parseCidr() {
    const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
    if (!m) { setResult(t('格式示例：192.168.1.10/24')); return; }
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) { setResult(t('IPv4 每段须为 0-255')); return; }
    const prefix = m[5] !== undefined ? Number(m[5]) : 32;
    if (prefix > 32) { setResult(t('前缀长度须为 0-32')); return; }
    const ip = octets.reduce((acc, o) => (acc << 8) + o, 0) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const toStr = (v: number) => [24, 16, 8, 0].map((s) => (v >>> s) & 0xff).join('.');
    const total = Math.pow(2, 32 - prefix);
    const usable = prefix >= 31 ? total : total - 2;
    setResult(
      t('网络: {{v1}}/{{prefix}}    掩码: {{v3}}    ', { v1: toStr(network), prefix, v3: toStr(mask) }) +
      t('广播: {{v1}}    可用主机: {{v2}}', { v1: toStr(broadcast), v2: usable.toLocaleString() })
    );
  }

  return (
    <Card title={t('端口范围 / IPv4 网段')}>
      <div className="tools-inline">
        <input className="tools-input tools-input--grow tools-mono" value={ports} onChange={(e) => setPorts(e.target.value)} placeholder={t('端口列表，如 80,443,8000-9000')} onKeyDown={(e) => e.key === 'Enter' && parsePorts()} />
        <Button size="sm" onClick={parsePorts}>{t('解析')}</Button>
      </div>
      <div className="tools-inline">
        <input className="tools-input tools-input--grow tools-mono" value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder={t('IPv4/CIDR，如 192.168.1.10/24')} onKeyDown={(e) => e.key === 'Enter' && parseCidr()} />
        <Button size="sm" variant="secondary" onClick={parseCidr}>{t('计算')}</Button>
      </div>
      <Out text={result} />
    </Card>
  );
}

/** 工具箱页面入口 */
export default function Tools() {
  return (
    <div className="tools-page">
      <div className="tools-page__grid">
        <JsonTool />
        <RegexTool />
        <Base64Tool />
        <TimestampTool />
        <RadixTool />
        <PortSubnetTool />
      </div>
    </div>
  );
}
