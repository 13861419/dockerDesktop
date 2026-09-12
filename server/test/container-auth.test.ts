/**
 * 容器资源级授权与自愈纯函数单元测试（1.41.0）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { matchAllowlistEntry } from '../src/routes/containers';
import { containerNameOf } from '../src/containerAuth';
import { matchesLabelRule, evalTriggerLimit } from '../src/selfheal';

test('matchAllowlistEntry：精确匹配容器名 / 完整 ID / 12 位短 ID', () => {
  const fullId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  assert.equal(matchAllowlistEntry('web', 'web', fullId), true);
  assert.equal(matchAllowlistEntry(fullId, 'web', fullId), true);
  assert.equal(matchAllowlistEntry(fullId.slice(0, 12), 'web', fullId), true);
  assert.equal(matchAllowlistEntry('api', 'web', fullId), false);
});

test('matchAllowlistEntry：前缀* 通配', () => {
  assert.equal(matchAllowlistEntry('jackos-*', 'jackos-web', 'whatever'), true);
  assert.equal(matchAllowlistEntry('jackos-*', 'web', 'jackosweb'), false);
});

test('matchAllowlistEntry：空条目不匹配', () => {
  assert.equal(matchAllowlistEntry('   ', 'web', 'abc'), false);
});

test('containerNameOf：取 Names[0] 去前导斜杠，回退 12 位短 ID', () => {
  assert.equal(containerNameOf(['/web'], 'abcdef1234567890'), 'web');
  assert.equal(containerNameOf([], 'abcdef1234567890'), 'abcdef123456');
  assert.equal(containerNameOf(undefined, undefined), '');
});

test('matchesLabelRule：key=value 与仅 key', () => {
  assert.equal(matchesLabelRule('team=api', { team: 'api' }), true);
  assert.equal(matchesLabelRule('team=api', { team: 'web' }), false);
  assert.equal(matchesLabelRule('enabled', { enabled: 'anything' }), true);
  assert.equal(matchesLabelRule('enabled', { other: 'x' }), false);
  assert.equal(matchesLabelRule('', { a: 'b' }), false);
});

test('evalTriggerLimit：未配置上限不限制', () => {
  assert.deepEqual(evalTriggerLimit(0, 3600, 99, null, 1000), { limited: false, notify: false });
});

test('evalTriggerLimit：窗口内达到上限即拦截', () => {
  assert.deepEqual(evalTriggerLimit(3, 60, 2, null, 1000), { limited: false, notify: false });
  assert.deepEqual(evalTriggerLimit(3, 60, 3, null, 1000), { limited: true, notify: true });
  assert.deepEqual(evalTriggerLimit(3, 60, 5, null, 1000), { limited: true, notify: true });
});

test('evalTriggerLimit：窗口内只告警一次，窗口过期后重新告警', () => {
  assert.deepEqual(evalTriggerLimit(3, 60, 3, 1000, 2000), { limited: true, notify: false });
  assert.deepEqual(evalTriggerLimit(3, 60, 3, 1000, 1000 + 61 * 1000), { limited: true, notify: true });
});
