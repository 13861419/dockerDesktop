/**
 * 通知渠道扩展单元测试（Telegram / 企业微信 / Slack）
 *
 * 覆盖：
 *  1. 渠道类型校验：缺必填字段返回 400、非法类型拒绝
 *  2. 渠道创建与读取回环：敏感字段（botToken）加密存储且不回显明文
 *  3. 更新时敏感字段传空保留原密文
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-notifych-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { createChannel, getChannel, updateChannel, listChannels } from '../src/notify';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

/* ---------- 类型校验 ---------- */

test('createChannel: telegram 缺 botToken / chatId 返回 400', () => {
  assert.throws(() => createChannel({ name: 'tg', type: 'telegram', config: { chatId: '1' } }), /Bot Token/);
  assert.throws(() => createChannel({ name: 'tg', type: 'telegram', config: { botToken: 'x' } }), /Chat ID/);
});

test('createChannel: wecom / slack 缅 Webhook 地址返回 400', () => {
  assert.throws(() => createChannel({ name: 'wx', type: 'wecom', config: {} }), /企业微信/);
  assert.throws(() => createChannel({ name: 'sl', type: 'slack', config: {} }), /Slack/);
});

test('createChannel: 非法类型拒绝', () => {
  assert.throws(() => createChannel({ name: 'x', type: 'unknown' as any, config: {} }), /不支持的渠道类型/);
});

/* ---------- 创建与读取回环 ---------- */

test('createChannel: telegram 正常创建，botToken 加密不回显', () => {
  const { id } = createChannel({ name: 'TG 告警', type: 'telegram', config: { botToken: '123:ABC', chatId: '-100' } });
  const ch = getChannel(id)!;
  assert.strictEqual(ch.info.type, 'telegram');
  assert.strictEqual(ch.info.secretsSet.botToken, true, 'botToken 应标记已配置');
  assert.strictEqual(ch.info.config.botToken, undefined, 'botToken 不应回显明文');
  assert.strictEqual(ch.info.config.chatId, '-100');
  assert.strictEqual(ch.cfg.botToken, '123:ABC', '内部读取应解密还原');
});

test('createChannel: wecom / slack 正常创建', () => {
  const wx = createChannel({ name: '企微', type: 'wecom', config: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1' } });
  const sl = createChannel({ name: 'Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' } });
  assert.strictEqual(getChannel(wx.id)!.info.type, 'wecom');
  assert.strictEqual(getChannel(sl.id)!.info.type, 'slack');
  assert.strictEqual(listChannels().length >= 3, true);
});

/* ---------- 更新语义 ---------- */

test('updateChannel: botToken 传空保留原密文，chatId 可更新', () => {
  const { id } = createChannel({ name: 'TG2', type: 'telegram', config: { botToken: 'orig-token', chatId: '1' } });
  updateChannel(id, { config: { botToken: '', chatId: '999' } });
  const ch = getChannel(id)!;
  assert.strictEqual(ch.cfg.botToken, 'orig-token', 'botToken 留空应保留原值');
  assert.strictEqual(ch.cfg.chatId, '999', 'chatId 应更新');
});
