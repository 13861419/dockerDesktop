/**
 * 部署钩子解析单元测试（1.78.0）：多行脚本切分、注释与空行过滤
 */
import { test } from 'node:test';
import assert = require('node:assert');
import { parseHookLines } from '../src/routes/deploys';

test('parseHookLines: 逐行切分并去掉空行与 # 注释', () => {
  const lines = parseHookLines('echo a\n\n# 注释行\n  echo b  \n\n');
  assert.deepStrictEqual(lines, ['echo a', 'echo b']);
});

test('parseHookLines: 空脚本返回空数组', () => {
  assert.deepStrictEqual(parseHookLines(''), []);
  assert.deepStrictEqual(parseHookLines(null), []);
  assert.deepStrictEqual(parseHookLines(undefined), []);
  assert.deepStrictEqual(parseHookLines('# 只有注释'), []);
});
