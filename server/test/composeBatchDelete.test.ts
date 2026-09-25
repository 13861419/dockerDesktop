/**
 * Compose 项目批量删除（1.89.0）单元测试
 *
 * 覆盖：
 *  - 未登录 401 / 非管理员 403（requireAdmin）
 *  - 空 names / names 非数组 → 400
 *  - 不存在的项目逐项记入 failed（不中断整批，不触碰 docker）
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import express from 'express';

// 必须先于 storage 模块加载设置临时数据目录
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-composebatch-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { closeDb, initStorage, getDb } from '../src/storage';
import composeRouter from '../src/routes/compose';
import { createSession, requireAuth } from '../src/auth';

initStorage();
// 预置 admin / 普通用户两行（requireAdmin 按 users 表角色判定）
getDb()
  .prepare("INSERT INTO users (username, salt, password_hash, role, created_at) VALUES ('batchadmin', 's', 'h', 'admin', 0)")
  .run();
getDb()
  .prepare("INSERT INTO users (username, salt, password_hash, role, created_at) VALUES ('batchuser', 's', 'h', 'user', 0)")
  .run();

const app = express();
app.use(express.json());
// 与 app.ts 一致：鉴权在挂载层统一注入
app.use('/api/compose', requireAuth, composeRouter);
const server = app.listen(0);
const BASE = `http://127.0.0.1:${(server.address() as any).port}`;
const adminToken = createSession('batchadmin');
const userToken = createSession('batchuser');

after(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) =>
    server.close(() => {
      closeDb();
      try {
        fs.rmSync(tmpData, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // 句柄释放滞后等场景清理失败不阻塞退出
      }
      resolve();
    }),
  );
});

/** 最小 POST 封装：JSON body + 可选 token */
function post(path: string, body: unknown, token?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      new URL(path, BASE),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data: any;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
}

test('POST /api/compose/batch-delete：未登录返回 401', async () => {
  const res = await post('/api/compose/batch-delete', { names: ['a'] });
  assert.strictEqual(res.status, 401);
});

test('POST /api/compose/batch-delete：非管理员返回 403', async () => {
  const res = await post('/api/compose/batch-delete', { names: ['a'] }, userToken);
  assert.strictEqual(res.status, 403);
});

test('POST /api/compose/batch-delete：空 names 返回 400', async () => {
  const res = await post('/api/compose/batch-delete', { names: [] }, adminToken);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.data.error, '缺少待删除的项目列表');
});

test('POST /api/compose/batch-delete：names 非数组返回 400', async () => {
  const res = await post('/api/compose/batch-delete', { names: 'nope' }, adminToken);
  assert.strictEqual(res.status, 400);
});

test('POST /api/compose/batch-delete：不存在的项目逐项记入 failed，不影响其他项', async () => {
  // 唯一名防止与本机 COMPOSE_ROOT 里可能存在的目录撞名（allowDirOnly 会把存在的目录当作可删）
  const unique = (s: string) => `${s}-${Date.now()}`;
  const res = await post('/api/compose/batch-delete', { names: [unique('ghost-a'), unique('ghost-b')] }, adminToken);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.ok, false);
  assert.deepStrictEqual(res.data.deleted, []);
  assert.strictEqual(res.data.failed.length, 2);
});

test('POST /api/compose/batch-delete：目录存在但无 compose 文件的空目录可删除（清理残留）', async () => {
  // 路由默认 COMPOSE_ROOT = tmpdir()/docker-compose-projects（与服务一致的兜底）
  const composeRoot = path.join(os.tmpdir(), 'docker-compose-projects');
  const dirName = `dm-test-leftover-${Date.now()}`;
  fs.mkdirSync(path.join(composeRoot, dirName), { recursive: true });
  const res = await post('/api/compose/batch-delete', { names: [dirName] }, adminToken);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.data.deleted, [dirName]);
  assert.strictEqual(fs.existsSync(path.join(composeRoot, dirName)), false);
});
