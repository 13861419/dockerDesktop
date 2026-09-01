/**
 * 安全加固单元测试：TOTP（RFC 6238 向量）/ IP 白名单 CIDR / 密码策略 / 会话管理
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-security-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { getSetting, setSetting } from '../src/settings';
import { generateSecret, verifyTotp, base32Decode, otpauthUri } from '../src/totp';
import { ipMatchesCidr, parseAllowlist, validatePasswordPolicy, isPasswordExpired } from '../src/security';
import { createSession, listSessions, revokeSessions, isValidToken } from '../src/auth';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

/* ---------- TOTP ---------- */

test('totp: base32 解码往返', () => {
  const secret = generateSecret();
  assert.strictEqual(secret.length, 32);
  assert.strictEqual(base32Decode(secret).length, 20);
});

test('totp: RFC 6238 测试向量（SHA1）', () => {
  // RFC 6238 附录 B：secret = ASCII "12345678901234567890"（Base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ）
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.strictEqual(base32Decode(key).toString('hex'), '3132333435363738393031323334353637383930');
  // T=59s → counter=1 → 6 位码 287082（RFC 向量 94287082 的后 6 位）
  assert.strictEqual(verifyTotp(key, '287082', 0, 59_000), true);
  // T=89s → counter=2 → 326384
  assert.strictEqual(verifyTotp(key, '326384', 0, 89_000), true);
  // 相邻步容差（counter=1 的码在 counter=2 时刻可过 window=1）
  assert.strictEqual(verifyTotp(key, '287082', 1, 89_000), true);
  assert.strictEqual(verifyTotp(key, '287082', 0, 89_000), false);
  // 错误码拒绝
  assert.strictEqual(verifyTotp(key, '000000', 1, 59_000), false);
  // otpauth URI 格式
  const uri = otpauthUri('admin', 'JBSWY3DPEHPK3PXP');
  assert.ok(uri.startsWith('otpauth://totp/DockerManager%3Aadmin?secret=JBSWY3DPEHPK3PXP'));
});

/* ---------- IP 白名单 ---------- */

test('cidr: 精确 IP 与网段匹配', () => {
  assert.strictEqual(ipMatchesCidr('192.168.1.10', '192.168.1.10'), true);
  assert.strictEqual(ipMatchesCidr('192.168.1.10', '192.168.1.0/24'), true);
  assert.strictEqual(ipMatchesCidr('192.168.2.10', '192.168.1.0/24'), false);
  assert.strictEqual(ipMatchesCidr('10.0.0.5', '10.0.0.0/8'), true);
  assert.strictEqual(ipMatchesCidr('10.1.0.5', '10.0.0.0/8'), true);
  assert.strictEqual(ipMatchesCidr('11.1.0.5', '10.0.0.0/8'), false);
  // 0.0.0.0/0 放行全部
  assert.strictEqual(ipMatchesCidr('8.8.8.8', '0.0.0.0/0'), true);
  // IPv6 仅精确相等
  assert.strictEqual(ipMatchesCidr('::1', '::1'), true);
  assert.strictEqual(ipMatchesCidr('::2', '::1'), false);
  // 非法输入
  assert.strictEqual(ipMatchesCidr('', '192.168.1.0/24'), false);
  assert.strictEqual(ipMatchesCidr('192.168.1.10', 'abc'), false);
});

test('allowlist: 逗号/换行解析', () => {
  assert.deepStrictEqual(parseAllowlist(' 192.168.1.0/24, 10.0.0.1\n::1 '), ['192.168.1.0/24', '10.0.0.1', '::1']);
  assert.deepStrictEqual(parseAllowlist(''), []);
});

/* ---------- 密码策略 ---------- */

test('password policy: 长度与复杂度', () => {
  validatePasswordPolicy('abc123');
  const prev = getSetting<number>('security.passwordMinLength');
  setSetting('security.passwordMinLength', 8);
  let threw = '';
  try {
    validatePasswordPolicy('abc123');
  } catch (e: any) {
    threw = e.message;
  }
  assert.ok(threw.includes('8'));
  setSetting('security.passwordRequireComplex', true);
  threw = '';
  try {
    validatePasswordPolicy('abcdefgh');
  } catch (e: any) {
    threw = e.message;
  }
  assert.ok(threw.includes('大写'));
  validatePasswordPolicy('Abc12345');
  setSetting('security.passwordMinLength', prev ?? 0);
  setSetting('security.passwordRequireComplex', false);
});

test('password policy: 过期判断', () => {
  assert.strictEqual(isPasswordExpired(null), false);
  assert.strictEqual(isPasswordExpired(Date.now() - 86400_000), false);
  const prev = getSetting<number>('security.passwordExpiryDays');
  setSetting('security.passwordExpiryDays', 30);
  assert.strictEqual(isPasswordExpired(Date.now() - 31 * 86400_000), true);
  assert.strictEqual(isPasswordExpired(Date.now() - 1), false);
  setSetting('security.passwordExpiryDays', prev ?? 0);
});

/* ---------- 会话管理 ---------- */

test('sessions: 列表/并发上限/撤销', () => {
  setSetting('auth.maxSessionsPerUser', 2);
  const t1 = createSession('sec-user', '1.2.3.4', 'ua');
  const t2 = createSession('sec-user', '1.2.3.4', 'ua');
  const t3 = createSession('sec-user', '1.2.3.4', 'ua');
  // 上限 2：创建第 3 个后最早的一个失效
  assert.strictEqual(isValidToken(t1), false);
  assert.strictEqual(isValidToken(t2), true);
  assert.strictEqual(listSessions('sec-user').length, 2);
  // 撤销单条（前缀定位）
  const view = listSessions('sec-user')[0];
  const n = revokeSessions({ tokenPrefix: view.id, username: 'sec-user' });
  assert.strictEqual(n, 1);
  // 撤销全部
  const n2 = revokeSessions({ username: 'sec-user' });
  assert.strictEqual(n2, 1);
  assert.strictEqual(isValidToken(t3), false);
  setSetting('auth.maxSessionsPerUser', 0);
  void t2;
  void t3;
});
