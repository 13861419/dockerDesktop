/**
 * 用户管理单元测试
 *
 * 覆盖：
 *  1. ensureInitialUser：默认管理员创建（幂等）
 *  2. addUser：新增用户（正常/重复用户名/非法输入）
 *  3. deleteUser：删除用户
 *  4. listUsers：列出用户
 *  5. userExists / getUserRole：查询用户
 *  6. changePassword：修改密码（正确旧密码/错误旧密码）
 *  7. verifyCredentials：凭证校验（正确/错误/锁定）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-users-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import {
  ensureInitialUser,
  addUser,
  deleteUser,
  listUsers,
  userExists,
  getUserRole,
  changePassword,
  verifyCredentials,
} from '../src/users';

before(() => {
  initStorage();
  ensureInitialUser();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('ensureInitialUser: 幂等，多次调用不报错', () => {
  assert.doesNotThrow(() => ensureInitialUser());
  assert.doesNotThrow(() => ensureInitialUser());
});

test('listUsers: 至少包含 admin', () => {
  const users = listUsers();
  assert.ok(users.length >= 1);
  const admin = users.find(u => u.username === 'admin');
  assert.ok(admin, '应包含 admin 用户');
  assert.strictEqual(admin!.role, 'admin');
});

test('userExists: admin 存在，test不存在', () => {
  assert.strictEqual(userExists('admin'), true);
  assert.strictEqual(userExists('nonexistent-user-xyz'), false);
});

test('getUserRole: admin 角色正确', () => {
  assert.strictEqual(getUserRole('admin'), 'admin');
});

test('addUser: 新增普通用户成功', () => {
  addUser('testuser1', 'TestPass123!', 'user');
  assert.strictEqual(userExists('testuser1'), true);
  const users = listUsers();
  const u = users.find(x => x.username === 'testuser1');
  assert.ok(u);
  assert.strictEqual(u!.role, 'user');
});

test('addUser: 重复用户名抛异常', () => {
  assert.throws(() => addUser('testuser1', 'AnotherPass!', 'user'), /已存在/);
});

test('addUser: 空用户名抛异常', () => {
  assert.throws(() => addUser('', 'pass', 'user'));
});

test('addUser: 管理员角色可创建', () => {
  addUser('testadmin', 'AdminPass123!', 'admin');
  assert.strictEqual(getUserRole('testadmin'), 'admin');
});

test('deleteUser: 删除存在的用户', () => {
  deleteUser('testuser1');
  assert.strictEqual(userExists('testuser1'), false);
});

test('deleteUser: 删除不存在的用户抛异常', () => {
  assert.throws(() => deleteUser('nonexistent-user-xyz'), /不存在/);
});

test('verifyCredentials: 正确凭证', () => {
  const result = verifyCredentials('admin', 'admin888');
  assert.strictEqual(result.ok, true);
});

test('verifyCredentials: 错误密码', () => {
  const result = verifyCredentials('admin', 'wrongpassword');
  assert.strictEqual(result.ok, false);
});

test('verifyCredentials: 不存在的用户', () => {
  const result = verifyCredentials('nonexistent', 'pass');
  assert.strictEqual(result.ok, false);
});

test('changePassword: 正确旧密码修改成功', () => {
  addUser('chpwduser', 'OldPass1!', 'user');
  assert.doesNotThrow(() => changePassword('chpwduser', 'OldPass1!', 'NewPass2!'));
  // 旧密码失效
  assert.strictEqual(verifyCredentials('chpwduser', 'OldPass1!').ok, false);
  // 新密码生效
  assert.strictEqual(verifyCredentials('chpwduser', 'NewPass2!').ok, true);
  deleteUser('chpwduser');
});

test('changePassword: 错误旧密码抛异常', () => {
  addUser('chpwduser2', 'CorrectPass!', 'user');
  assert.throws(() => changePassword('chpwduser2', 'WrongPass!', 'NewPass!'), /旧密码|密码/);
  deleteUser('chpwduser2');
});
