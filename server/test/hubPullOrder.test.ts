/**
 * 镜像源拉取候选排序单元测试（1.93.0）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { orderPullCandidates } from '../src/hubConfig';
import type { HubSource } from '../src/hubConfig';

/** 构造镜像源条目 */
function src(id: string, host: string, isDefault = false): HubSource {
  return { id, host, isDefault, enabled: true };
}

test('orderPullCandidates: 未显式指定时默认源优先，直连兜底', () => {
  const enabled = [src('a', 'https://a.example'), src('b', 'https://b.example', true), src('c', 'https://c.example')];
  const r = orderPullCandidates(undefined, enabled);
  assert.deepStrictEqual(r, ['https://b.example', 'https://a.example', 'https://c.example', '']);
});

test('orderPullCandidates: 显式源在最前且不再追加直连', () => {
  const enabled = [src('a', 'https://a.example', true), src('b', 'https://b.example')];
  const r = orderPullCandidates('https://custom.mirror', enabled);
  assert.deepStrictEqual(r, ['https://custom.mirror', 'https://a.example', 'https://b.example']);
});

test('orderPullCandidates: 无启用源时仅直连', () => {
  assert.deepStrictEqual(orderPullCandidates(undefined, []), ['']);
});

test('orderPullCandidates: 主机去重（协议差异视为同源）', () => {
  const enabled = [src('a', 'https://dup.example'), src('b', 'dup.example', true)];
  const r = orderPullCandidates('https://dup.example', enabled);
  assert.deepStrictEqual(r, ['https://dup.example']);
});
