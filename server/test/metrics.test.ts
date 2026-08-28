/**
 * Prometheus 指标输出工具单元测试
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { escapeLabel } from '../src/routes/metrics';

test('escapeLabel：转义反斜杠、双引号与换行', () => {
  assert.strictEqual(escapeLabel('plain'), 'plain');
  assert.strictEqual(escapeLabel('a\\b'), 'a\\\\b');
  assert.strictEqual(escapeLabel('a"b'), 'a\\"b');
  assert.strictEqual(escapeLabel('a\nb'), 'a\\nb');
  assert.strictEqual(escapeLabel('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
});
