import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/storage';

beforeEach(() => {
  getDb().exec('DELETE FROM ai_actions');
});

describe('aiActions CRUD + execution', () => {
  it('createAction: 创建操作记录', async () => {
    const { createAction } = await import('../src/aiActions');
    const action = createAction('admin', 'restart', { containerId: 'abc123' }, '请重启容器');
    assert.ok(action.id > 0);
    assert.equal(action.username, 'admin');
    assert.equal(action.actionType, 'restart');
    assert.equal(action.status, 'pending');
  });

  it('approveAction + rejectAction: 状态变更', async () => {
    const { createAction, approveAction, rejectAction } = await import('../src/aiActions');
    const a1 = createAction('admin', 'stop', { containerId: 'c1' }, '停止');
    const a2 = createAction('admin', 'start', { containerId: 'c2' }, '启动');
    const approved = approveAction(a1.id);
    assert.ok(approved);
    assert.equal(approved!.status, 'approved');
    const rejected = rejectAction(a2.id);
    assert.ok(rejected);
    assert.equal(rejected!.status, 'rejected');
  });

  it('markExecuted: 标记执行结果', async () => {
    const { createAction, approveAction, markExecuted } = await import('../src/aiActions');
    const a = createAction('admin', 'remove', { containerId: 'c3' }, '删除');
    approveAction(a.id);
    markExecuted(a.id, 'OK', true);
    const { getAction } = await import('../src/aiActions');
    const result = getAction(a.id);
    assert.ok(result);
    assert.equal(result!.status, 'executed');
    assert.equal(result!.result, 'OK');
  });

  it('getActionStats: 统计', async () => {
    const { createAction, approveAction, rejectAction, getActionStats } = await import('../src/aiActions');
    const a1 = createAction('admin', 'restart', { containerId: 'c1' }, 'r');
    const a2 = createAction('admin', 'stop', { containerId: 'c2' }, 's');
    const a3 = createAction('admin', 'start', { containerId: 'c3' }, 'st');
    approveAction(a1.id);
    rejectAction(a2.id);
    const stats = getActionStats();
    assert.ok(stats.pending >= 1);
    assert.ok(stats.approved >= 1);
    assert.ok(stats.rejected >= 1);
  });
});

describe('aiActionExecutor', () => {
  it('executeAction: 非 approved 状态返回 ok=false', async () => {
    const { createAction } = await import('../src/aiActions');
    const { executeAction } = await import('../src/aiActionExecutor');
    const a = createAction('admin', 'restart', { containerId: 'c1' }, '未批准');
    const result = await executeAction(a.id);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('无法执行'));
  });

  it('ACTION_TYPE_LABELS: 包含所有 9 种类型', async () => {
    const { ACTION_TYPE_LABELS } = await import('../src/aiActions');
    const types = Object.keys(ACTION_TYPE_LABELS);
    assert.ok(types.length >= 9);
    assert.ok(types.includes('restart_container'));
    assert.ok(types.includes('restart_network'));
    assert.ok(types.includes('prune_volumes'));
    assert.ok(types.includes('exec_command'));
  });
});
