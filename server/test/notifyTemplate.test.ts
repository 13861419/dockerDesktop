/**
 * 通知渠道消息模板单元测试
 *
 * 覆盖：
 *  1. renderTemplate 纯函数：四个变量替换、未知变量保留、空模板透传
 *  2. 渠道模板字段的创建/更新回环与限长校验
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-notifytpl-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { createChannel, getChannel, updateChannel, renderTemplate } from '../src/notify';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

/* ---------- renderTemplate 纯函数 ---------- */

test('renderTemplate: 四个变量全部替换', () => {
  const out = renderTemplate('【{{level}}】{{message}} @ {{time}} ({{channel}})', {
    level: 'danger',
    message: '容器 foo 已退出',
    time: '2026-08-29 16:00:00',
    channel: '钉钉群',
  });
  assert.strictEqual(out, '【danger】容器 foo 已退出 @ 2026-08-29 16:00:00 (钉钉群)');
});

test('renderTemplate: 未知变量原样保留', () => {
  const out = renderTemplate('{{message}} {{unknown}} {{level}}', { level: 'warn', message: 'hi' });
  assert.strictEqual(out, 'hi {{unknown}} warn');
});

test('renderTemplate: 同一变量出现多次均替换', () => {
  const out = renderTemplate('{{message}} / {{message}}', { message: 'X' });
  assert.strictEqual(out, 'X / X');
});

test('renderTemplate: 空模板返回原文本（兼容未配置渠道）', () => {
  assert.strictEqual(renderTemplate('', { message: '原文' }), '原文');
  assert.strictEqual(renderTemplate('   ', { message: '原文' }), '原文');
});

test('renderTemplate: 变量缺失替换为空串且容忍空白（{{ level }}）', () => {
  assert.strictEqual(renderTemplate('L={{level}}!', {}), 'L=!');
  assert.strictEqual(renderTemplate('L={{ level }}!', { level: 'warn' }), 'L=warn!');
});

/* ---------- 渠道模板字段回环 ---------- */

test('createChannel: 模板字段持久化并可读取', () => {
  const { id } = createChannel({
    name: '模板渠道',
    type: 'webhook',
    config: { url: 'https://example.com/hook' },
    template: '【{{level}}】{{message}}',
  });
  const ch = getChannel(id)!;
  assert.strictEqual(ch.info.template, '【{{level}}】{{message}}');
});

test('createChannel: 未传模板默认为空串', () => {
  const { id } = createChannel({ name: '无模板', type: 'webhook', config: { url: 'https://e.com/h' } });
  assert.strictEqual(getChannel(id)!.info.template, '');
});

test('updateChannel: 模板可更新，未传保持原值，传空清空', () => {
  const { id } = createChannel({
    name: 'TG 模板',
    type: 'telegram',
    config: { botToken: 't', chatId: '1' },
    template: 'A{{message}}',
  });
  updateChannel(id, { template: 'B{{message}}' });
  assert.strictEqual(getChannel(id)!.info.template, 'B{{message}}');
  // 不传 template 保持原值
  updateChannel(id, { name: 'TG 模板2' });
  assert.strictEqual(getChannel(id)!.info.template, 'B{{message}}');
  // 传空串清空
  updateChannel(id, { template: '  ' });
  assert.strictEqual(getChannel(id)!.info.template, '');
});

test('createChannel/updateChannel: 模板超过 500 字符返回 400', () => {
  const long = 'x'.repeat(501);
  assert.throws(
    () => createChannel({ name: '长模板', type: 'webhook', config: { url: 'https://e.com/h' }, template: long }),
    /500/,
  );
  const { id } = createChannel({ name: '正常渠道', type: 'webhook', config: { url: 'https://e.com/h' } });
  assert.throws(() => updateChannel(id, { template: long }), /500/);
});
