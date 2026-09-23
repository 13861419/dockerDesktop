/**
 * 任务链式编排与运行参数（1.84.0）单元测试
 *
 * 覆盖 scheduler.ts 三个纯函数：
 *  - wouldCreateCycle：链式成环判定（自环 / 间接环 / 空目标 / 断链）
 *  - extractPlaceholders：{{占位符}} 提取（去重 / 非法键名忽略）
 *  - applyParams：config 深替换（嵌套对象 / 数组 / 缺失键保留 / 非字符串原样）
 */
import { test, after } from 'node:test';
import assert from 'node:assert';

// 必须先于 storage 模块加载设置临时数据目录
import os from 'os';
import path from 'path';
import fs from 'fs';
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-chain-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { wouldCreateCycle, extractPlaceholders, applyParams, CHAIN_MAX_DEPTH } from '../src/scheduler';

test('wouldCreateCycle: 空目标 / 简单链不成环', () => {
  assert.strictEqual(wouldCreateCycle({}, 'a', null), false);
  assert.strictEqual(wouldCreateCycle({}, 'a', undefined), false);
  assert.strictEqual(wouldCreateCycle({ a: 'b' }, 'a', 'b'), false);
  assert.strictEqual(wouldCreateCycle({ a: 'b', b: 'c' }, 'a', 'c'), false);
});

test('wouldCreateCycle: 自环与间接环', () => {
  // a → a 自环
  assert.strictEqual(wouldCreateCycle({}, 'a', 'a'), true);
  // a → b，b 已指向 a
  assert.strictEqual(wouldCreateCycle({ b: 'a' }, 'a', 'b'), true);
  // 间接：a → c，c → b，b → a
  assert.strictEqual(wouldCreateCycle({ b: 'a', c: 'b' }, 'a', 'c'), true);
});

test('wouldCreateCycle: 断链与深度遍历', () => {
  // 链在中间断掉（b 的下游不存在），不影响判定
  assert.strictEqual(wouldCreateCycle({ b: 'ghost' }, 'a', 'b'), false);
  // 长链尾端回到起点
  const map: Record<string, string | null> = { b: 'c', c: 'd', d: 'e' };
  assert.strictEqual(wouldCreateCycle({ b: 'c', c: 'd', d: 'e' }, 'a', 'b'), false);
  map.e = 'a';
  assert.strictEqual(wouldCreateCycle(map, 'a', 'b'), true);
});

test('extractPlaceholders: 提取 / 去重 / 非法键名忽略', () => {
  assert.deepStrictEqual(extractPlaceholders('no placeholders'), []);
  assert.deepStrictEqual(extractPlaceholders('deploy {{TARGET}} now'), ['TARGET']);
  assert.deepStrictEqual(extractPlaceholders('{{a}} {{b}} {{a}}'), ['a', 'b']);
  // 允许两侧空白
  assert.deepStrictEqual(extractPlaceholders('{{  spaced  }}'), ['spaced']);
  // 非法键名（数字开头 / 含连字符）不产出
  assert.deepStrictEqual(extractPlaceholders('{{1bad}} {{a-b}}'), []);
});

test('applyParams: 嵌套对象与数组内字符串替换', () => {
  const cfg = {
    commands: 'docker stop {{NAME}}',
    nested: { host: '{{HOST}}', port: 5328 },
    list: ['{{A}}-x', 3, true, null],
  };
  const r = applyParams(cfg, { NAME: 'web', HOST: '1.2.3.4', A: 'v' });
  assert.deepStrictEqual(r.config, {
    commands: 'docker stop web',
    nested: { host: '1.2.3.4', port: 5328 },
    list: ['v-x', 3, true, null],
  });
  assert.deepStrictEqual(r.applied.sort(), ['A', 'HOST', 'NAME']);
  assert.deepStrictEqual(r.missing, []);
  // 原对象不被修改
  assert.strictEqual((cfg as any).commands, 'docker stop {{NAME}}');
});

test('applyParams: 缺失键保留占位符并记录 missing', () => {
  const r = applyParams({ cmd: 'echo {{GIVEN}} {{MISSING}}' }, { GIVEN: 'hi' });
  assert.strictEqual(r.config.cmd, 'echo hi {{MISSING}}');
  assert.deepStrictEqual(r.missing, ['MISSING']);
});

test('applyParams: 非法键名的参数被忽略', () => {
  const r = applyParams({ cmd: 'x {{ok_key}}' }, { ok_key: 'v', 'bad-key': 'v2' });
  assert.strictEqual(r.config.cmd, 'x v');
  assert.deepStrictEqual(r.applied, ['ok_key']);
});

test('CHAIN_MAX_DEPTH 兜底上限存在', () => {
  assert.strictEqual(CHAIN_MAX_DEPTH, 10);
});

// 测试后清理临时数据目录（失败不阻塞退出）
after(() => {
  try { fs.rmSync(tmpData, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 句柄释放滞后等场景清理失败不阻塞 */ }
});
