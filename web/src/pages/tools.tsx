/**
 * 运维工具箱页面
 *
 * 常用运维小工具，全部在浏览器内完成、零后端请求：
 * - JSON 校验/格式化/压缩
 * - 正则表达式测试
 * - Base64 编解码
 * - 时间戳 ↔ 日期互转
 * - 进制转换（2/8/10/16）
 * - 端口范围解析 + IPv4 网段计算
 * - YAML / Compose 校验格式化（1.75.8，js-yaml）
 * - Cron 表达式解析 + 未来执行时间预览（1.75.8，语义与调度器一致）
 * - Hash 校验（1.76.0，Web Crypto SHA-1/256/512，支持文件）
 * - 强密码 / UUID 生成（1.76.0，crypto.getRandomValues）
 * - 文本 Diff 对比（1.76.0，LCS 行级算法 + 行内字符级差异高亮）
 * - JWT 解码（1.76.2，纯前端 base64url，不验证签名）
 * - URL 编解码 / HTTP 状态码速查 / 字节单位换算（1.76.2）
 */
import { useMemo, useRef, useState } from 'react';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import Card from '../components/Card';
import Button from '../components/Button';
import { parseCron } from '../utils/cron';
import { post } from '../api/client';
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

// ---------- YAML 工具（1.75.8） ----------

function YamlTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  function loadYaml(text: string): any | null {
    return yamlLoad(text);
  }

  /** 校验：错误带行号定位 */
  function validate() {
    if (!input.trim()) return;
    try {
      loadYaml(input);
      setError('');
      setOutput(t('YAML 语法正确'));
    } catch (e: any) {
      const mark = e?.mark ? `（第 ${e.mark.line + 1} 行，第 ${e.mark.column + 1} 列）` : '';
      setError(`${mark} ${e?.reason || e?.message || String(e)}`.trim());
      setOutput('');
    }
  }

  function run(mode: 'format' | 'json') {
    if (!input.trim()) return;
    try {
      const obj = loadYaml(input);
      if (mode === 'format') {
        setOutput(yamlDump(obj, { indent: 2, lineWidth: -1, noRefs: true }));
      } else {
        setOutput(JSON.stringify(obj, null, 2));
      }
    } catch (e: any) {
      const mark = e?.mark ? `（第 ${e.mark.line + 1} 行，第 ${e.mark.column + 1} 列）` : '';
      setError(`${mark} ${e?.message || String(e)}`);
      setOutput('');
    }
  }

  return (
    <Card title={t('YAML / Compose 校验格式化')}>
      <TextArea value={input} onChange={setInput} placeholder={t('粘贴 YAML 或 docker compose 配置')} rows={6} mono />
      <div className="tools-row">
        <Button size="sm" onClick={() => validate()}>{t('校验')}</Button>
        <Button size="sm" onClick={() => run('format')}>{t('格式化')}</Button>
        <Button size="sm" onClick={() => run('json')}>{t('转为 JSON')}</Button>
      </div>
      <Out text={output || error} ok={error ? false : undefined} placeholder={t('校验或格式化结果')} />
    </Card>
  );
}

// ---------- Cron 工具（1.75.7） ----------

function CronTool() {
  const [expr, setExpr] = useState('');
  const [result, setResult] = useState('');

  function parse() {
    const r = parseCron(expr);
    if (!r.valid) {
      setResult(r.error);
      return;
    }
    const lines: string[] = r.fields.map((f) => `${f.label}（${f.value}）：${f.desc}`);
    lines.push('');
    lines.push(t('未来 5 次执行时间：'));
    for (const t of r.next) {
      const d = new Date(t);
      const pad = (n: number) => String(n).padStart(2, '0');
      lines.push(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      );
    }
    setResult(lines.join('\n'));
  }

  return (
    <Card title={t('Cron 表达式解析')}>
      <div className="tools-inline">
        <input
          className="tools-input tools-input--grow tools-mono"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder={t('分 时 日 月 周，如 0 3 * * *')}
          onKeyDown={(e) => e.key === 'Enter' && parse()}
        />
        <Button size="sm" onClick={parse}>{t('解析')}</Button>
      </div>
      <Out text={result} placeholder={t('输入 5 段 cron 表达式开始解析')} />
    </Card>
  );
}

// ---------- DNS 解析查询（1.75.9，后端代理） ----------

interface DnsResult {
  host: string;
  a?: string[];
  aaaa?: string[];
  cname?: string[];
  txt?: string[][];
  mx?: { exchange: string; priority: number }[];
  ns?: string[];
}

function DnsTool() {
  const [host, setHost] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  async function query() {
    if (!host.trim()) return;
    setBusy(true);
    try {
      const r = await post<DnsResult>('/api/tools/dns', { host: host.trim() });
      const lines: string[] = [];
      if ((r.a || []).length) lines.push(`A：${r.a!.join(', ')}`);
      if ((r.aaaa || []).length) lines.push(`AAAA：${r.aaaa!.join(', ')}`);
      if ((r.cname || []).length) lines.push(`CNAME：${r.cname!.join(', ')}`);
      if ((r.ns || []).length) lines.push(`NS：${r.ns!.join(', ')}`);
      if ((r.mx || []).length) lines.push(r.mx!.map((m) => `MX：${m.priority} ${m.exchange}`).join('\n'));
      if ((r.txt || []).length) {
        const txts = r.txt!.map((arr) => arr.join(''));
        lines.push(`TXT：${txts.join(' | ')}`);
      }
      if (lines.length === 0) lines.push(t('未查询到任何记录（域名可能未配置解析）'));
      setResult(lines.join('\n'));
    } catch (e: any) {
      setResult(e?.message || t('查询失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('DNS 解析查询')}>
      <div className="tools-inline">
        <input
          className="tools-input tools-input--grow tools-mono"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={t('域名，如 example.com')}
          onKeyDown={(e) => e.key === 'Enter' && query()}
        />
        <Button size="sm" loading={busy} onClick={query}>{t('查询')}</Button>
      </div>
      <Out text={result} placeholder={t('从面板服务器发起真实 DNS 查询')} />
    </Card>
  );
}

// ---------- SSL 证书查看器（1.75.9，后端代理） ----------

interface SslResult {
  host: string;
  port: number;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  sans: string[];
  authorized: boolean;
  authorizationError: string;
}

function SslTool() {
  const [host, setHost] = useState('');
  const [result, setResult] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  async function query() {
    if (!host.trim()) return;
    setBusy(true);
    setErr(false);
    try {
      const m = host.trim().match(/^([^:]+)(?::(\d+))?$/);
      const payload = { host: m ? m[1] : host.trim(), port: m && m[2] ? Number(m[2]) : 443 };
      const r = await post<SslResult>('/api/tools/ssl', payload);
      const pad = (n: number) => String(n).padStart(2, '0');
      const fmt = (iso: string) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      const lines = [
        `${t('主题')}: ${r.subject || '-'}`,
        `${t('签发者')}: ${r.issuer || '-'}`,
        `${t('生效时间')}: ${fmt(r.validFrom)}`,
        `${t('到期时间')}: ${fmt(r.validTo)}`,
        `${t('剩余天数')}: ${r.daysLeft}`,
        `${t('自签/不受信')}: ${r.authorized ? t('否') : t('是')}${r.authorizationError ? `（${r.authorizationError}）` : ''}`,
        r.sans.length ? `${t('SAN 域名')}: ${r.sans.join(', ')}` : '',
      ];
      setResult(lines.filter(Boolean).join('\n'));
    } catch (e: any) {
      setErr(true);
      setResult(e?.message || t('查询失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('SSL 证书查看器')}>
      <div className="tools-inline">
        <input
          className="tools-input tools-input--grow tools-mono"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={t('域名或 域名:端口，如 example.com')}
          onKeyDown={(e) => e.key === 'Enter' && query()}
        />
        <Button size="sm" loading={busy} onClick={query}>{t('查询')}</Button>
      </div>
      <Out text={result} ok={err ? false : undefined} placeholder={t('从面板服务器发起 TLS 握手查看证书详情')} />
    </Card>
  );
}

// ---------- Hash 校验（1.76.0，Web Crypto） ----------

function HashTool() {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [algo, setAlgo] = useState<'SHA-1' | 'SHA-256' | 'SHA-512'>('SHA-256');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function compute(buf: BufferSource, source: string) {
    setBusy(true);
    try {
      const digest = await crypto.subtle.digest(algo, buf);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      setResult(`${source}（${algo}）\n${hex}`);
    } catch (e: any) {
      setResult(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('Hash 校验')}>
      <TextArea value={text} onChange={setText} placeholder={t('输入文本，或选择文件校验完整性')} rows={3} mono />
      <div className="tools-row">
        <select className="tools-select" value={algo} onChange={(e) => setAlgo(e.target.value as typeof algo)}>
          <option value="SHA-1">SHA-1</option>
          <option value="SHA-256">SHA-256</option>
          <option value="SHA-512">SHA-512</option>
        </select>
        <Button size="sm" onClick={() => text.trim() && compute(new TextEncoder().encode(text), t('文本'))}>{t('计算文本哈希')}</Button>
        <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>{t('选择文件')}</Button>
        <input
          ref={fileRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            setFile(f || null);
            e.target.value = '';
          }}
        />
        {file && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => file.arrayBuffer().then((b) => compute(b, file.name))}>
            {t('计算文件哈希')}
          </Button>
        )}
      </div>
      {file && <div className="tools-hint">{t('已选文件')}: {file.name}（{file.size.toLocaleString()} bytes）</div>}
      <Out text={result} placeholder={t('哈希结果（十六进制）')} />
    </Card>
  );
}

// ---------- 强密码 / UUID 生成（1.76.0，crypto.getRandomValues） ----------

function KeyGenTool() {
  const [len, setLen] = useState(16);
  const [upper, setUpper] = useState(true);
  const [lower, setLower] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [result, setResult] = useState('');

  function generate() {
    let charset = '';
    if (upper) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (lower) charset += 'abcdefghijklmnopqrstuvwxyz';
    if (digits) charset += '0123456789';
    if (symbols) charset += '!@#$%^&*()-_=+[]{};:,.<>?';
    if (!charset) { setResult(t('请至少选择一种字符集')); return; }
    const bytes = crypto.getRandomValues(new Uint32Array(len));
    const password = Array.from(bytes, (b) => charset[b % charset.length]).join('');
    setResult(password);
  }

  function genUuid() {
    setResult(crypto.randomUUID ? crypto.randomUUID() : String(crypto.getRandomValues(new Uint32Array(4))));
  }

  const cb = (checked: boolean, setter: (v: boolean) => void, label: string) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => setter(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <Card title={t('强密码 / UUID 生成')}>
      <div className="tools-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <label style={{ fontSize: 13 }}>{t('长度')}: {len}</label>
        <input type="range" min={8} max={64} value={len} onChange={(e) => setLen(Number(e.target.value))} style={{ width: 140 }} />
        {cb(upper, setUpper, 'A-Z')}
        {cb(lower, setLower, 'a-z')}
        {cb(digits, setDigits, '0-9')}
        {cb(symbols, setSymbols, '!@#')}
      </div>
      <div className="tools-row">
        <Button size="sm" onClick={generate}>{t('生成密码')}</Button>
        <Button size="sm" variant="secondary" onClick={genUuid}>{t('生成 UUID')}</Button>
      </div>
      <Out text={result} placeholder={t('生成结果（密码或 UUID）')} />
    </Card>
  );
}

// ---------- 文本 Diff 对比（1.76.0，LCS 行级算法） ----------

interface DiffLine { type: 'same' | 'add' | 'del'; line: string; segs?: DiffSeg[] }
interface DiffSeg { text: string; changed: boolean }

function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // LCS 动态规划表
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', line: a[i] }); i++; }
    else { out.push({ type: 'add', line: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', line: a[i++] });
  while (j < m) out.push({ type: 'add', line: b[j++] });
  return out;
}

/** 字符级 LCS：返回两行各自的分段（changed = 该字符属于行内差异） */
function diffSegments(a: string, b: string): [DiffSeg[], DiffSeg[]] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const aChanged = new Array<boolean>(n).fill(false);
  const bChanged = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { aChanged[i++] = true; }
    else { bChanged[j++] = true; }
  }
  while (i < n) aChanged[i++] = true;
  while (j < m) bChanged[j++] = true;
  const group = (s: string, changed: boolean[]): DiffSeg[] => {
    const segs: DiffSeg[] = [];
    for (let k = 0; k < s.length; k++) {
      const last = segs[segs.length - 1];
      if (last && last.changed === changed[k]) last.text += s[k];
      else segs.push({ text: s[k], changed: changed[k] });
    }
    return segs;
  };
  return [group(a, aChanged), group(b, bChanged)];
}

/** 相邻的 -/+ 行两两配对，计算行内字符级差异并挂到 segs */
function attachCharDiff(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'del') { i++; continue; }
    let d = i;
    while (d < lines.length && lines[d].type === 'del') d++;
    let a = d;
    while (a < lines.length && lines[a].type === 'add') a++;
    const pairs = Math.min(d - i, a - d);
    for (let k = 0; k < pairs; k++) {
      const delLine = lines[i + k];
      const addLine = lines[d + k];
      // 超长行跳过字符级对比（O(n*m) 内存控制）
      if (delLine.line.length <= 400 && addLine.line.length <= 400) {
        const [da, db] = diffSegments(delLine.line, addLine.line);
        delLine.segs = da;
        addLine.segs = db;
      }
    }
    i = a;
  }
}

function DiffTool() {
  const [textA, setTextA] = useState('');
  const [textB, setTextB] = useState('');
  const [lines, setLines] = useState<DiffLine[] | null>(null);
  const [error, setError] = useState('');

  function compare() {
    const a = textA.split('\n');
    const b = textB.split('\n');
    if (a.length > 1000 || b.length > 1000) {
      setError(t('行数过多（>1000 行），请拆分后对比'));
      setLines(null);
      return;
    }
    setError('');
    const result = diffLines(a, b);
    attachCharDiff(result);
    setLines(result);
  }

  return (
    <Card title={t('文本 Diff 对比')}>
      <div className="tools-row" style={{ alignItems: 'flex-start' }}>
        <TextArea value={textA} onChange={setTextA} placeholder={t('文本 A')} rows={6} mono />
        <TextArea value={textB} onChange={setTextB} placeholder={t('文本 B')} rows={6} mono />
      </div>
      <div className="tools-row">
        <Button size="sm" onClick={compare}>{t('对比')}</Button>
      </div>
      {error ? <Out text={error} ok={false} /> : lines !== null && (
        <div className="tools-out tools-diff">
          {lines.length === 0 && <span className="tools-out__ph">{t('无差异')}</span>}
          {lines.map((l, idx) => (
            <div key={idx} className={`tools-diff__line ${l.type === 'add' ? 'tools-diff__line--add' : l.type === 'del' ? 'tools-diff__line--del' : ''}`}>
              {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}
              {l.segs
                ? l.segs.map((s, si) => (s.changed ? <span key={si} className="tools-diff__seg">{s.text}</span> : <span key={si}>{s.text}</span>))
                : l.line}
            </div>
          ))}
        </div>
      )}
      {lines !== null && lines.every((l) => l.type === 'same') && <div className="tools-hint">{t('无差异')}</div>}
    </Card>
  );
}

// ---------- JWT 解码（1.76.2，纯前端 base64url，不验证签名） ----------

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return atob(b64 + pad);
}

function JwtTool() {
  const [token, setToken] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  function decode() {
    try {
      const parts = token.trim().split('.');
      if (parts.length < 2) throw new Error(t('不是有效的 JWT（至少两段，以 . 分隔）'));
      const header = JSON.parse(b64urlDecode(parts[0]));
      const payload = JSON.parse(b64urlDecode(parts[1]));
      const fmt = (v: any) => {
        if (typeof v !== 'number') return v;
        const d = new Date(v * 1000);
        return isNaN(d.getTime()) ? v : `${v}（${d.toLocaleString()}）`;
      };
      const shown: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) shown[k] = ['exp', 'iat', 'nbf'].includes(k) ? fmt(v) : v;
      const expired = typeof payload.exp === 'number' ? payload.exp * 1000 < Date.now() : null;
      setResult(
        `Header:\n${JSON.stringify(header, null, 2)}\n\nPayload:\n${JSON.stringify(shown, null, 2)}` +
          (expired === null ? '' : `\n\n${t('签名验证')}: ✗ ${t('仅解码未验证签名')}\n${t('有效期')}: ${expired ? t('已过期') : t('未过期')}`)
      );
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
      setResult('');
    }
  }

  return (
    <Card title={t('JWT 解码')}>
      <TextArea value={token} onChange={setToken} placeholder={t('粘贴 JWT（三段式，以 . 分隔）')} rows={3} mono />
      <div className="tools-row">
        <Button size="sm" onClick={decode}>{t('解码')}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setToken(''); setResult(''); setError(''); }}>{t('清空')}</Button>
      </div>
      {error && <div className="tools-err">✗ {error}</div>}
      <Out text={result} ok={!error} placeholder={t('Header / Payload 明文（exp / iat 自动转为可读时间）')} />
    </Card>
  );
}

// ---------- URL 编解码（1.76.2） ----------

function UrlTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  function run(mode: 'encode' | 'decode') {
    if (!input) return;
    try {
      setOutput(mode === 'encode' ? encodeURIComponent(input) : decodeURIComponent(input));
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
      setOutput('');
    }
  }

  return (
    <Card title={t('URL 编解码')}>
      <TextArea value={input} onChange={setInput} placeholder={t('输入待编码/解码的文本或 URL')} rows={3} mono />
      <div className="tools-row">
        <Button size="sm" onClick={() => run('encode')}>{t('编码')}</Button>
        <Button size="sm" variant="secondary" onClick={() => run('decode')}>{t('解码')}</Button>
      </div>
      {error && <div className="tools-err">✗ {error}</div>}
      <Out text={output} ok={!error} placeholder={t('结果')} />
    </Card>
  );
}

// ---------- HTTP 状态码速查（1.76.2） ----------

const HTTP_CODES: Array<[number, string, string]> = [
  [100, 'Continue', '继续，客户端应继续发送请求体'],
  [101, 'Switching Protocols', '切换协议（如 WebSocket 升级）'],
  [200, 'OK', '请求成功'],
  [201, 'Created', '资源已创建'],
  [204, 'No Content', '成功但无返回体'],
  [206, 'Partial Content', '范围请求 / 断点续传'],
  [301, 'Moved Permanently', '永久重定向'],
  [302, 'Found', '临时重定向'],
  [304, 'Not Modified', '缓存命中，内容未变化'],
  [307, 'Temporary Redirect', '临时重定向（保持原方法）'],
  [308, 'Permanent Redirect', '永久重定向（保持原方法）'],
  [400, 'Bad Request', '请求语法或参数错误'],
  [401, 'Unauthorized', '未认证（登录态缺失或失效）'],
  [403, 'Forbidden', '已认证但无权限'],
  [404, 'Not Found', '资源不存在'],
  [405, 'Method Not Allowed', 'HTTP 方法不被允许'],
  [408, 'Request Timeout', '请求超时'],
  [409, 'Conflict', '资源状态冲突'],
  [413, 'Payload Too Large', '请求体过大'],
  [415, 'Unsupported Media Type', '不支持的媒体类型'],
  [422, 'Unprocessable Entity', '语义错误（校验不通过）'],
  [429, 'Too Many Requests', '请求过于频繁（触发限流）'],
  [444, 'Nginx No Response', 'Nginx 静默断开连接'],
  [500, 'Internal Server Error', '服务器内部错误'],
  [501, 'Not Implemented', '功能未实现'],
  [502, 'Bad Gateway', '网关收到无效上游响应（后端多半挂了）'],
  [503, 'Service Unavailable', '服务不可用（过载或维护中）'],
  [504, 'Gateway Timeout', '网关等待上游超时'],
];

function HttpStatusTool() {
  const [kw, setKw] = useState('');
  const list = HTTP_CODES.filter(([code, name, desc]) => {
    if (!kw.trim()) return true;
    const k = kw.trim().toLowerCase();
    return String(code).includes(k) || name.toLowerCase().includes(k) || desc.includes(kw.trim());
  });
  return (
    <Card title={t('HTTP 状态码速查')}>
      <div className="tools-inline">
        <input className="tools-input tools-input--grow" value={kw} onChange={(e) => setKw(e.target.value)} placeholder={t('输入状态码或关键字过滤，如 404 / redirect / 重定向')} />
      </div>
      <div className="tools-out tools-diff">
        {list.length === 0 && <span className="tools-out__ph">{t('无匹配')}</span>}
        {list.map(([code, name, desc]) => (
          <div key={code} className="tools-out__line">
            <span className="tools-mono">{code}</span> {name} — {t(desc)}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- 字节单位换算（1.76.2） ----------

function BytesTool() {
  const [value, setValue] = useState('1');
  const [unit, setUnit] = useState<'B' | 'KB' | 'MB' | 'GB' | 'TB'>('MB');
  const num = Number(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  const idx = units.indexOf(unit);
  const bytes = isFinite(num) && num >= 0 ? num * Math.pow(1024, idx) : NaN;

  const fmt = (n: number) => {
    if (!isFinite(n)) return '—';
    if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(3);
    return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });
  };

  return (
    <Card title={t('字节单位换算')}>
      <div className="tools-row">
        <input
          className="tools-input tools-input--grow tools-mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('数值')}
          inputMode="decimal"
        />
        <select className="tools-select" value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)}>
          {units.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      <Out
        text={
          isNaN(bytes)
            ? t('请输入有效数字')
            : units.map((u, k) => {
                const bin = bytes / Math.pow(1024, k);
                const dec = bytes / Math.pow(1000, k);
                return `${u}（1024）: ${fmt(bin)}    ${u}（1000）: ${fmt(dec)}`;
              }).join('\n')
        }
        placeholder={t('换算结果（同时给出 1024 与 1000 两种进制）')}
      />
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
        <YamlTool />
        <CronTool />
        <DnsTool />
        <SslTool />
        <HashTool />
        <KeyGenTool />
        <DiffTool />
        <JwtTool />
        <UrlTool />
        <HttpStatusTool />
        <BytesTool />
      </div>
    </div>
  );
}
