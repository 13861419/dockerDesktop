/**
 * 审批门禁扩展（GATE_ACTIONS / 执行器注册 / maybeGateOrForbidden）单元测试
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import type { Response } from 'express';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-approvalgate-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { setSetting } from '../src/settings';
import {
  GATE_ACTIONS,
  hasExecutor,
  maybeGateOrForbidden,
  type ApprovalStatus,
} from '../src/approvals';
import type { Request } from 'express';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

/** 构造最小可用的 req/res 桩 */
function stubRes() {
  const res: any = {
    statusCode: 0,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    locals: { username: 'alice', user: { username: 'alice', role: 'user' } },
  };
  return res;
}
function stubReq(): Request { return {} as Request; }

test('0.4.0 新增动作均已注册且配有执行器', () => {
  for (const action of ['compose.down', 'image.deleteBatch', 'image.prune', 'volume.prune']) {
    assert.ok(action in GATE_ACTIONS, `GATE_ACTIONS 缺少 ${action}`);
    assert.ok(hasExecutor(action), `执行器缺少 ${action}`);
  }
  // 原有动作不被破坏
  for (const action of ['container.delete', 'image.delete', 'volume.delete', 'network.prune', 'container.fix']) {
    assert.ok(hasExecutor(action));
  }
});

test('管理员直接放行（返回 false 不响应）', () => {
  const res = stubRes();
  res.locals.user.role = 'admin';
  const handled = maybeGateOrForbidden(stubReq(), res, 'compose.down', 'demo', {});
  assert.strictEqual(handled, false);
  assert.strictEqual(res.statusCode, 0);
});

test('非管理员 + 审批关闭：403 拒绝（默认安全姿态不变）', () => {
  setSetting('approvals.enabled', false);
  const res = stubRes();
  const handled = maybeGateOrForbidden(stubReq(), res, 'compose.down', 'demo', {});
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 403);
});

test('非管理员 + 审批开启：202 转审批并落库', () => {
  setSetting('approvals.enabled', true);
  const res = stubRes();
  const handled = maybeGateOrForbidden(stubReq(), res, 'image.deleteBatch', 'nginx:latest, redis:7', {
    names: ['nginx:latest', 'redis:7'],
  });
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.approvalPending, true);
  assert.ok(Number.isInteger(res.body.approvalId));
});

test('未知动作类型对非管理员一律 403（不因开关开启而放行）', () => {
  setSetting('approvals.enabled', true);
  const res = stubRes();
  const handled = maybeGateOrForbidden(stubReq(), res, 'not.a.real.action', 'x', {});
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 403);
});
