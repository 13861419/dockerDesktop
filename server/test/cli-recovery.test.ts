/**
 * 管理员找回 CLI 测试
 *
 * 覆盖：
 *  1. reset-admin：重置密码 + 强制改密标记 + 清除锁定
 *  2. reset-admin --disable-totp：同时关闭两步验证
 *  3. unlock：清除持久化登录锁定
 *  4. 边界：用户不存在返回 1、弱密码拒绝且不改动原密码、list-users 正常退出
 *
 * 运行：先设置临时数据目录再 import 业务模块，确保隔离。
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 必须先于 storage 模块加载设置临时数据目录，确保数据库落在隔离环境
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-cli-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, getDb, closeDb } from '../src/storage';
import { runCli } from '../src/cli';
import { addUser, verifyCredentials, getUserSecurity, setTotpSecret } from '../src/users';
import { getLockRemaining } from '../src/loginProtection';

initStorage();
// 准备一个管理员与一个普通用户
addUser('admin', 'admin888', 'admin');
addUser('operator1', 'operator888', 'operator');

test('reset-admin：重置密码并清除锁定、强制改密', async () => {
  // 先制造锁定状态
  getDb()
    .prepare('UPDATE users SET failed_attempts = 5, locked_until = ? WHERE username = ?')
    .run(Date.now() + 60_000, 'admin');
  assert.ok(getLockRemaining('admin') > 0, '前置条件：账号应处于锁定状态');

  const code = await runCli(
    ['reset-admin', '--user', 'admin', '--password-stdin'],
    { stdin: 'NewPass123!', checkPort: false },
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(getLockRemaining('admin'), 0, '锁定应被清除');
  const check = verifyCredentials('admin', 'NewPass123!');
  assert.strictEqual(check.ok, true, '新密码应可登录');
  assert.strictEqual(check.mustChangePassword, true, '应标记强制改密');
  assert.strictEqual(verifyCredentials('admin', 'admin888').ok, false, '旧密码应失效');
});

test('reset-admin --disable-totp：同时关闭两步验证', async () => {
  setTotpSecret('admin', 'JBSWY3DPEHPK3PXP');
  assert.strictEqual(getUserSecurity('admin').totpEnabled, true, '前置条件：2FA 应已启用');
  const code = await runCli(
    ['reset-admin', '--user', 'admin', '--disable-totp', '--password-stdin'],
    { stdin: 'Another456!', checkPort: false },
  );
  assert.strictEqual(code, 0);
  assert.strictEqual(getUserSecurity('admin').totpEnabled, false, '2FA 应被关闭');
  assert.strictEqual(verifyCredentials('admin', 'Another456!').ok, true);
});

test('unlock：仅清除持久化锁定，不影响密码', async () => {
  getDb()
    .prepare('UPDATE users SET failed_attempts = 5, locked_until = ? WHERE username = ?')
    .run(Date.now() + 60_000, 'operator1');
  const code = await runCli(['unlock', '--user', 'operator1'], { checkPort: false });
  assert.strictEqual(code, 0);
  assert.strictEqual(getLockRemaining('operator1'), 0);
  assert.strictEqual(verifyCredentials('operator1', 'operator888').ok, true, '密码不受影响');
});

test('用户不存在：reset-admin 返回 1', async () => {
  const code = await runCli(
    ['reset-admin', '--user', 'ghost', '--password-stdin'],
    { stdin: 'Whatever123', checkPort: false },
  );
  assert.strictEqual(code, 1);
});

test('弱密码：拒绝重置且原密码不变', async () => {
  const code = await runCli(
    ['reset-admin', '--user', 'operator1', '--password-stdin'],
    { stdin: 'abc', checkPort: false },
  );
  assert.strictEqual(code, 1);
  assert.strictEqual(verifyCredentials('operator1', 'operator888').ok, true, '原密码应保持不变');
});

test('list-users：正常退出', async () => {
  const code = await runCli(['list-users'], { checkPort: false });
  assert.strictEqual(code, 0);
});

after(() => {
  closeDb();
});
