/**
 * 登录防护单元测试
 *
 * 覆盖：
 *  1. isLocked / getLockRemaining：锁定状态查询
 *  2. registerFailure：累积失败计数
 *  3. resetFailures：重置失败计数
 *  4. getLoginPolicy：获取策略配置
 *  5. 锁定触发：连续失败达阈值后锁定
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  isLocked,
  getLockRemaining,
  registerFailure,
  resetFailures,
  getLoginPolicy,
} from '../src/loginProtection';

const TEST_KEY = 'test-user-login-protection';

test('isLocked: 初始状态未锁定', () => {
  resetFailures(TEST_KEY);
  assert.strictEqual(isLocked(TEST_KEY), false);
});

test('getLockRemaining: 未锁定时返回 0', () => {
  resetFailures(TEST_KEY);
  assert.strictEqual(getLockRemaining(TEST_KEY), 0);
});

test('registerFailure: 累积失败次数', () => {
  resetFailures(TEST_KEY);
  registerFailure(TEST_KEY);
  registerFailure(TEST_KEY);
  // 还未达到阈值，不应锁定
  assert.strictEqual(isLocked(TEST_KEY), false);
});

test('resetFailures: 重置后解除锁定', () => {
  resetFailures(TEST_KEY);
  registerFailure(TEST_KEY);
  registerFailure(TEST_KEY);
  resetFailures(TEST_KEY);
  assert.strictEqual(isLocked(TEST_KEY), false);
});

test('getLoginPolicy: 返回有效配置', () => {
  const policy = getLoginPolicy();
  assert.ok(typeof policy === 'object');
  assert.ok(typeof policy.maxAttempts === 'number');
  assert.ok(typeof policy.lockMinutes === 'number');
  assert.ok(policy.maxAttempts > 0, '最大尝试次数应大于 0');
  assert.ok(policy.lockMinutes > 0, '锁定时间应大于 0 分钟');
});

test('锁定触发：连续失败达阈值后 isLocked 为 true', () => {
  resetFailures(TEST_KEY);
  const policy = getLoginPolicy();
  // 连续失败 maxAttempts 次
  for (let i = 0; i < policy.maxAttempts; i++) {
    registerFailure(TEST_KEY);
  }
  assert.strictEqual(isLocked(TEST_KEY), true, `连续失败 ${policy.maxAttempts} 次后应锁定`);
});

test('getLockRemaining: 锁定后返回正数', () => {
  resetFailures(TEST_KEY);
  const policy = getLoginPolicy();
  for (let i = 0; i < policy.maxAttempts; i++) {
    registerFailure(TEST_KEY);
  }
  const remaining = getLockRemaining(TEST_KEY);
  assert.ok(remaining > 0, `锁定后剩余时间应大于 0，实际 ${remaining}`);
});

test('不同 key 独立计数', () => {
  const keyA = 'test-user-a';
  const keyB = 'test-user-b';
  resetFailures(keyA);
  resetFailures(keyB);
  registerFailure(keyA);
  registerFailure(keyA);
  registerFailure(keyA);
  // keyA 可能已锁定，keyB 应未锁定
  assert.strictEqual(isLocked(keyB), false);
  resetFailures(keyA);
  resetFailures(keyB);
});
