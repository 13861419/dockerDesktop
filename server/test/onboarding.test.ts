/**
 * 首次启动向导（1.88.0）单元测试
 *
 * 覆盖：
 *  - onboarding.done 设置描述符注册（bool / 默认 true / hidden）
 *  - 首装种子：users 表为空 → 写入 '0'；有用户 → 不写（存量库不受打扰）
 *  - GET /api/settings/:key 单键读取（首装种子后 value=false；未注册键 404）
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import express from 'express';

// 必须先于 storage 模块加载设置临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-onboard-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, getDb, seedOnboardingFlag } from '../src/storage';
import { getSettingRaw } from '../src/settings';
import settingsRouter from '../src/routes/settings';
import { createSession } from '../src/auth';

// 挂载真实 settings 路由的极简 app（鉴权用内存会话 token）
const app = express();
app.use('/api/settings', settingsRouter);
const server = app.listen(0);
const BASE = `http://127.0.0.1:${(server.address() as any).port}`;
const token = createSession('admin');

// 测试结束后关闭监听句柄，避免 --test-force-exit 退出时触发 libuv 断言崩溃
after(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 最小 GET 封装：返回 status 与解析后的 JSON body */
function get(path: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      new URL(path, BASE),
      { headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let data: any;
          try { data = JSON.parse(body); } catch { data = body; }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    r.on('error', reject);
    r.end();
  });
}

test('onboarding.done 描述符：bool 类型、默认 true（已完成）、hidden', () => {
  const raw = getSettingRaw('onboarding.done');
  assert.ok(raw, 'onboarding.done 应已注册');
  assert.strictEqual(raw.value, true);
  assert.strictEqual(raw.source, 'default');
});

test('首装种子：users 为空 → 写入待完成标记', () => {
  initStorage();
  seedOnboardingFlag();
  const raw = getSettingRaw('onboarding.done');
  assert.strictEqual(raw!.value, false);
  assert.strictEqual(raw!.source, 'db');
});

test('存量库：users 非空且无标记 → 不种子（视为已完成）', () => {
  // 模拟存量库：插入一个用户后清除标记，再次执行种子应保持无键
  getDb()
    .prepare("INSERT INTO users (username, salt, password_hash, role, created_at) VALUES ('legacy', 's', 'h', 'admin', 0)")
    .run();
  getDb().prepare('DELETE FROM setting WHERE key = ?').run('onboarding.done');
  seedOnboardingFlag();
  const raw = getSettingRaw('onboarding.done');
  assert.strictEqual(raw!.source, 'default');
  assert.strictEqual(raw!.value, true);
});

test('GET /api/settings/onboarding.done：首装种子后单键读取到待完成 false', async () => {
  // 复现首装种子状态（前序用例已插入用户并清除标记）
  getDb().prepare('DELETE FROM users').run();
  getDb().prepare('DELETE FROM setting WHERE key = ?').run('onboarding.done');
  seedOnboardingFlag();
  const res = await get('/api/settings/onboarding.done');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.key, 'onboarding.done');
  assert.strictEqual(res.data.value, false);
  assert.strictEqual(res.data.source, 'db');
});

test('GET /api/settings/:key：未注册的键返回 404', async () => {
  const res = await get('/api/settings/not-a-key');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.data.error, '未知的设置项');
});
