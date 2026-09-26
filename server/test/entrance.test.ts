/**
 * 安全入口（隐藏路径）中间件测试
 *
 * 覆盖：
 *  1. 未设置 ENTRANCE_PATH：直通（向后兼容）
 *  2. 启用后：未持凭证一律 404；机器入口（health/metrics/webhook）豁免
 *  3. 秘密路径：签发 HttpOnly Cookie 并放行；持凭证请求正常通过
 *  4. 篡改 Cookie / 非 GET 访问入口：404
 *  5. 完整 app 集成：/api/auth/me 未持凭证 404、持凭证到达鉴权层 401
 *
 * 运行：先设置临时数据目录再 import 业务模块（.cred-secret 写入临时目录）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import express from 'express';

// 必须先于 storage 模块加载设置临时数据目录，确保密钥文件与数据库落在隔离环境
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-entrance-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { entranceGate } from '../src/entrance';
import { closeDb } from '../src/storage';

/** 构建带兜底路由的最小应用：到达业务层 = 200 OK，与门禁 404 可区分 */
function buildApp(gate: express.RequestHandler): express.Express {
  const a = express();
  a.use(gate);
  a.get('/api/health', (_q, r) => r.json({ ok: true }));
  a.use((_q, r) => r.status(200).send('OK'));
  return a;
}

function listen(a: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => {
      const addr = s.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function request(
  base: string,
  reqPath: string,
  cookie?: string,
): Promise<{ status: number; setCookie: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      base + reqPath,
      { headers: cookie ? { Cookie: cookie } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            setCookie: res.headers['set-cookie']?.[0],
            body: data,
          }),
        );
      },
    );
    req.on('error', reject);
  });
}

test('未设置入口路径：中间件直通', async () => {
  const base = await listen(buildApp(entranceGate(undefined)));
  const res = await request(base, '/anything');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, 'OK');
});

test('启用后：未持凭证一律 404，豁免入口放行', async () => {
  const base = await listen(buildApp(entranceGate('/secret-path-9x7')));
  // 普通路径与登录 API 均被门禁拦截
  assert.strictEqual((await request(base, '/')).status, 404);
  assert.strictEqual((await request(base, '/login')).status, 404);
  assert.strictEqual((await request(base, '/api/auth/login')).status, 404);
  // 自带鉴权的机器入口保持可达
  assert.strictEqual((await request(base, '/api/health')).status, 200);
  assert.strictEqual((await request(base, '/metrics')).status, 200);
  assert.strictEqual((await request(base, '/api/webhook/abc')).status, 200);
  assert.strictEqual((await request(base, '/api/mcp')).status, 200);
});

test('秘密路径：GET 签发 Cookie 并放行，持凭证后正常访问', async () => {
  const base = await listen(buildApp(entranceGate('/secret-path-9x7')));
  const first = await request(base, '/secret-path-9x7');
  assert.strictEqual(first.status, 200);
  assert.ok(first.setCookie, '应下发 Set-Cookie');
  assert.ok(first.setCookie.includes('dm_entrance='));
  assert.ok(first.setCookie.includes('HttpOnly'));
  assert.ok(first.setCookie.includes('SameSite=Strict'));
  const cookie = first.setCookie.split(';')[0];
  // 持凭证访问任意路径均放行
  assert.strictEqual((await request(base, '/', cookie)).status, 200);
  assert.strictEqual((await request(base, '/api/auth/login', cookie)).status, 200);
  // 带尾斜杠同样可进入
  const slash = await request(base, '/secret-path-9x7/');
  assert.ok(slash.setCookie, '尾斜杠路径也应下发 Cookie');
});

test('凭证校验：篡改 Cookie 与非 GET 入口均 404', async () => {
  const base = await listen(buildApp(entranceGate('/secret-path-9x7')));
  const first = await request(base, '/secret-path-9x7');
  const cookie = first.setCookie!.split(';')[0];
  const tampered = cookie.replace(/dm_entrance=.+/, 'dm_entrance=' + '0'.repeat(64));
  assert.strictEqual((await request(base, '/', tampered)).status, 404);
  // 非 GET 不签发 Cookie
  const post = await new Promise<{ status: number }>((resolve, reject) => {
    const u = new URL(base + '/secret-path-9x7');
    const r = http.request(
      { method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode || 0 });
      },
    );
    r.on('error', reject);
    r.end();
  });
  assert.strictEqual(post.status, 404);
});

test('完整 app：启用入口后 API 门禁生效', async () => {
  process.env.ENTRANCE_PATH = '/portal-test-9x7';
  const appMod = await import('../src/app');
  const server = appMod.default.listen(0, '127.0.0.1');
  const base = await new Promise<string>((resolve) => {
    server.once('listening', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  // health 豁免
  assert.strictEqual((await request(base, '/api/health')).status, 200);
  // 未持凭证：页面与鉴权 API 均 404
  assert.strictEqual((await request(base, '/')).status, 404);
  assert.strictEqual((await request(base, '/api/auth/me')).status, 404);
  // 访问入口获取凭证
  const e = await request(base, '/portal-test-9x7');
  assert.ok(e.setCookie?.startsWith('dm_entrance='), '入口应下发 Cookie');
  const cookie = e.setCookie!.split(';')[0];
  // 持凭证：放行至鉴权层（未登录 401，而非门禁 404）
  assert.strictEqual((await request(base, '/api/auth/me', cookie)).status, 401);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

after(() => {
  closeDb();
});
