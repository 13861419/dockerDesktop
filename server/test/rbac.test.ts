/**
 * 自定义角色 RBAC 单元测试
 *
 * 覆盖：内置角色种子 / 权限判定 / 角色 CRUD 守卫 / requirePermission / 审批门禁联动
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-rbac-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { ensureBuiltinRoles, hasPermission, requirePermission, listRoles, createRole, updateRole, deleteRole } from '../src/rbac';
import { addUser, deleteUser, userExists } from '../src/users';
import { setSetting } from '../src/settings';
import { shouldGate } from '../src/approvals';

before(() => {
  initStorage();
  ensureBuiltinRoles();
});

after(() => {
  for (const u of ['rbac-u1', 'rbac-u2']) {
    try { if (userExists(u)) deleteUser(u); } catch {}
  }
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('内置角色已种子：admin/operator/user/auditor', () => {
  const names = listRoles().map((r) => r.name);
  for (const n of ['admin', 'operator', 'user', 'auditor']) {
    assert.ok(names.includes(n), `缺少内置角色 ${n}`);
  }
});

test("hasPermission：admin 通配（'*'），operator 默认集，user 只读", () => {
  assert.ok(hasPermission('admin', 'containers.run'));
  assert.ok(hasPermission('admin', '任意未定义键'));
  assert.ok(hasPermission('operator', 'containers.run'), 'operator 默认含容器生命周期');
  assert.ok(!hasPermission('operator', 'containers.delete'), 'operator 默认不含删除容器');
  assert.ok(!hasPermission('user', 'containers.run'), 'user 默认只读');
  assert.ok(!hasPermission('ghost-role', 'containers.run'), '未知角色无权限');
});

test('自定义角色：创建后按白名单判定，更新即时生效', () => {
  createRole('发布员', ['containers.run', 'images.pull']);
  assert.ok(hasPermission('发布员', 'containers.run'));
  assert.ok(!hasPermission('发布员', 'volumes.write'));
  updateRole('发布员', ['volumes.write']);
  assert.ok(hasPermission('发布员', 'volumes.write'));
  assert.ok(!hasPermission('发布员', 'containers.run'), '更新后旧权限被移除');
});

test('角色 CRUD 守卫：未知权限键 400 / 重复名 409 / 内置锁定 / 使用中禁删', () => {
  assert.throws(() => createRole('坏*名', []), /角色名/);
  assert.throws(() => createRole('发布员', []), /已存在/);
  assert.throws(() => createRole('测试角色', ['not.a.key']), /未知权限键/);
  assert.throws(() => updateRole('admin', []), /内置角色权限固定/);
  assert.throws(() => deleteRole('user'), /内置角色不可删除/);

  // operator 属内置但允许调整权限集
  const before = hasPermission('operator', 'containers.run');
  updateRole('operator', []);
  assert.ok(!hasPermission('operator', 'containers.run'), 'operator 权限可调整');
  updateRole('operator', before ? ['containers.run'] : []);
  assert.strictEqual(hasPermission('operator', 'containers.run'), before, '恢复 operator 默认权限');

  addUser('rbac-u1', 'password1', '发布员');
  assert.throws(() => deleteRole('发布员'), /仍有.*用户使用/);
  deleteUser('rbac-u1');
  deleteRole('发布员');
  assert.ok(!hasPermission('发布员', 'volumes.write'), '删除后权限失效');
});

test('requirePermission：有权限放行，无权限 403', async () => {
  const { requirePermission } = await import('../src/rbac');
  const middleware = requirePermission('volumes.delete');
  const mkRes = () =>
    ({
      statusCode: 0,
      body: null as any,
      status(code: number) { this.statusCode = code; return this; },
      json(p: any) { this.body = p; return this; },
      locals: { user: { username: 'u', role: '发布员' } },
    }) as any;
  const next = () => {
    (mkRes as any).__next = true;
  };

  const resA = mkRes();
  middleware({} as any, resA, next);
  assert.strictEqual(resA.statusCode, 403, '无权限应返回 403 而非 next');

  createRole('存储员', ['volumes.delete']);
  const resB = mkRes();
  (resB as any).locals.user.role = '存储员';
  let called = false;
  middleware({} as any, resB, () => { called = true; });
  assert.ok(called, '有权限应调用 next');
});

test('审批门禁联动：角色持有删除权限时不拦截，未持有时转审批', () => {
  setSetting('approvals.enabled', true);
  // operator 默认无删除权限 → 应拦截
  assert.ok(shouldGate('operator', 'container.delete'));
  // 授权后直行
  updateRole('operator', [
    'containers.run',
    'images.pull',
    'images.write',
    'volumes.write',
    'networks.write',
    'compose.write',
    'containers.delete',
  ]);
  assert.ok(!shouldGate('operator', 'container.delete'), '已授权的操作不再走审批');
  assert.ok(shouldGate('user', 'container.delete'), 'user 无删除权限应拦截');
  assert.ok(!shouldGate('admin', 'container.delete'), 'admin 恒直行');
});
