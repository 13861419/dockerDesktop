/**
 * AI 对话历史模块（aiChatHistory）单元测试（node:test）
 * 覆盖：createChatSession / listChatSessions / getChatSession / updateChatSessionTitle /
 *       updateChatSessionMessages / deleteChatSession / 用户隔离
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录（须在 import storage 前设置）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-aihist-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, getDb, closeDb } from '../src/storage';
import {
  createChatSession,
  listChatSessions,
  getChatSession,
  updateChatSessionTitle,
  updateChatSessionMessages,
  deleteChatSession,
  togglePinChatSession,
  updateMessageFeedback,
  deleteChatSessions,
  clearAllChatSessions,
} from '../src/aiChatHistory';

before(() => {
  initStorage();
  getDb().prepare('DELETE FROM ai_chat_sessions').run();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('createChatSession 创建空会话并返回记录', () => {
  const s = createChatSession('alice');
  assert.ok(s.id > 0);
  assert.strictEqual(s.title, '新对话');
  assert.strictEqual(s.messageCount, 0);
  assert.deepStrictEqual(s.messages, []);
});

test('updateChatSessionMessages + getChatSession 读写消息', () => {
  const s = createChatSession('alice');
  const ok = updateChatSessionMessages(
    s.id,
    'alice',
    [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你？' },
    ],
  );
  assert.strictEqual(ok, true);

  const got = getChatSession(s.id, 'alice');
  assert.ok(got);
  assert.strictEqual(got.messageCount, 2);
  assert.strictEqual(got.messages[0].role, 'user');
  assert.strictEqual(got.messages[1].content, '你好！有什么可以帮你？');
});

test('updateChatSessionTitle 更新标题', () => {
  const s = createChatSession('alice');
  assert.strictEqual(updateChatSessionTitle(s.id, 'alice', '我的首个人工智能对话'), true);
  assert.strictEqual(getChatSession(s.id, 'alice')!.title, '我的首个人工智能对话');
});

test('listChatSessions 按更新时间倒序返回', () => {
  const s1 = createChatSession('bob');
  updateChatSessionMessages(s1.id, 'bob', [{ role: 'user', content: 'x' }]);
  // s1 更新时间最新
  const list = listChatSessions('bob');
  assert.ok(list.length >= 1);
  assert.strictEqual(list[0].id, s1.id);
  assert.strictEqual(list[0].messageCount, 1);
});

test('用户隔离：无法读取/修改/删除他人会话', () => {
  const s = createChatSession('carol');
  // 他人读不到
  assert.strictEqual(getChatSession(s.id, 'mallory'), null);
  // 他人改不了
  assert.strictEqual(updateChatSessionTitle(s.id, 'mallory', 'hacked'), false);
  assert.strictEqual(updateChatSessionMessages(s.id, 'mallory', [{ role: 'user', content: 'hacked' }]), false);
  // 他人删不了
  assert.strictEqual(deleteChatSession(s.id, 'mallory'), false);
  // 本人仍可读
  assert.ok(getChatSession(s.id, 'carol'));
});

test('deleteChatSession 删除会话', () => {
  const s = createChatSession('dave');
  assert.strictEqual(deleteChatSession(s.id, 'dave'), true);
  assert.strictEqual(getChatSession(s.id, 'dave'), null);
  // 重复删除返回 false
  assert.strictEqual(deleteChatSession(s.id, 'dave'), false);
});

test('坏 messages JSON 返回空数组（容错）', () => {
  getDb()
    .prepare("UPDATE ai_chat_sessions SET messages = 'not-json' WHERE id = ?")
    .run(createChatSession('erin').id);
  const got = listChatSessions('erin');
  assert.strictEqual(got[0].messageCount, 0);
});

test('togglePinChatSession 切换收藏/置顶状态', () => {
  const s = createChatSession('pin_user');
  assert.strictEqual(listChatSessions('pin_user').find((x) => x.id === s.id)!.pinned, false);
  assert.strictEqual(togglePinChatSession(s.id, 'pin_user'), true);
  assert.strictEqual(listChatSessions('pin_user').find((x) => x.id === s.id)!.pinned, true);
  assert.strictEqual(togglePinChatSession(s.id, 'pin_user'), false);
  assert.strictEqual(listChatSessions('pin_user').find((x) => x.id === s.id)!.pinned, false);
  assert.strictEqual(togglePinChatSession(s.id, 'mallory'), null);
  assert.strictEqual(togglePinChatSession(999999, 'pin_user'), null);
});

test('updateMessageFeedback 给 AI 回复点赞/点踩', () => {
  const s = createChatSession('fb_user');
  updateChatSessionMessages(s.id, 'fb_user', [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！有什么可以帮你？' },
    { role: 'user', content: '列出镜像' },
  ]);
  // 对第 1 条 AI 回复点赞
  assert.strictEqual(updateMessageFeedback(s.id, 'fb_user', 1, 'good'), true);
  const got = getChatSession(s.id, 'fb_user')!;
  assert.strictEqual(got.messages[1].feedback, 'good');
  // 改踩
  assert.strictEqual(updateMessageFeedback(s.id, 'fb_user', 1, 'bad'), true);
  assert.strictEqual(getChatSession(s.id, 'fb_user')!.messages[1].feedback, 'bad');
  // 用户消息不能打分
  assert.strictEqual(updateMessageFeedback(s.id, 'fb_user', 0, 'good'), false);
  // 越界索引失败
  assert.strictEqual(updateMessageFeedback(s.id, 'fb_user', 99, 'good'), false);
  // 他人不能打分
  assert.strictEqual(updateMessageFeedback(s.id, 'mallory', 1, 'good'), false);
  // 不存在会话
  assert.strictEqual(updateMessageFeedback(999999, 'fb_user', 0, 'good'), false);
});

test('deleteChatSessions 批量删除（用户隔离）', () => {
  const a1 = createChatSession('batch_a');
  const a2 = createChatSession('batch_a');
  const b1 = createChatSession('batch_b');
  // 只删自己的，跨用户不受影响
  const deleted = deleteChatSessions([a1.id, a2.id, b1.id], 'batch_a');
  assert.strictEqual(deleted, 2);
  assert.strictEqual(getChatSession(a1.id, 'batch_a'), null);
  assert.strictEqual(getChatSession(a2.id, 'batch_a'), null);
  // bob 的会话仍在
  assert.ok(getChatSession(b1.id, 'batch_b'));
  // 空数组返回 0
  assert.strictEqual(deleteChatSessions([], 'batch_a'), 0);
});

test('clearAllChatSessions 清空指定用户全部会话', () => {
  createChatSession('clear_user');
  createChatSession('clear_user');
  createChatSession('clear_other');
  const count = clearAllChatSessions('clear_user');
  assert.strictEqual(count, 2);
  assert.strictEqual(listChatSessions('clear_user').length, 0);
  // 其他用户不受影响
  assert.strictEqual(listChatSessions('clear_other').length, 1);
});
