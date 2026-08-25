/**
 * 日志解析工具（logUtil）单元测试（node:test，零第三方依赖）
 * 覆盖：多路复用解析 / TTY / 时间戳提取 / stripAnsi
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { demuxLogToLines, stripAnsi } from '../src/docker/logUtil';

function demuxBuf(entries: Array<{ stream: number; text: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const payload = Buffer.from(e.text, 'utf8');
    const head = Buffer.alloc(8);
    head[0] = e.stream; // 1=stdout 2=stderr
    head.writeUInt32BE(payload.length, 4);
    chunks.push(head, payload);
  }
  return Buffer.concat(chunks);
}

test('demuxLogToLines 解析 stdout/stderr 多行', () => {
  const buf = demuxBuf([
    { stream: 1, text: 'hello\nworld' },
    { stream: 2, text: 'err1\nerr2' },
  ]);
  const lines = demuxLogToLines(buf, { timestamps: false });
  assert.ok(lines.length >= 2);
  assert.ok(lines.some((l) => l.stream === 'stdout' && l.text === 'hello'));
  assert.ok(lines.some((l) => l.stream === 'stderr' && l.text === 'err1'));
});

test('TTY 整段作为 stdout 解析', () => {
  const buf = Buffer.from('line1\nline2\n', 'utf8');
  const lines = demuxLogToLines(buf, { tty: true });
  assert.strictEqual(lines[0].stream, 'stdout');
  assert.strictEqual(lines[0].text, 'line1');
  assert.strictEqual(lines[1].text, 'line2');
});

test('带时间戳前缀的行解析 ts', () => {
  const buf = Buffer.from('2026-01-01T00:00:00.000000000Z hello\n', 'utf8');
  const lines = demuxLogToLines(buf, { tty: true, timestamps: true });
  assert.ok(lines.length >= 1);
  assert.ok(lines[0].ts && lines[0].ts > 0);
  assert.strictEqual(lines[0].text, 'hello');
});

test('stripAnsi 去除 ANSI 颜色码', () => {
  assert.strictEqual(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.strictEqual(stripAnsi('plain'), 'plain');
});
