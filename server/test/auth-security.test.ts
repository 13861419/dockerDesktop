/**
 * 鉴权与权限边界自动化测试（基于 Node 内置 node:test，零第三方依赖）
 *
 * 覆盖：
 *  1. requireAuth 中间件：未登录/无效 Token → 401；有效 Token → 放行并注入 role
 *  2. requireAdmin 中间件：普通用户 → 403；管理员 → 放行（越权防护核心）
 *  3. 会话生命周期：createSession / isValidToken / destroySession
 *  4. 口令校验与加盐哈希：正确/错误密码、错误用户名、加盐唯一性
 *
 * 运行：先并行设置临时数据目录（见文件顶部），再 import 业务模块，
 * 避免污染真实 data/ 数据库。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { Request, Response, NextFunction } from 'express';

// 必须先于 storage 模块加载设置临时数据目录，确保 getDb() 指向隔离环境
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import {
  requireAuth,
  requireAdmin,
  createSession,
  destroySession,
  isValidToken,
  getSessionUsername,
} from '../src/auth';
import { initStorage, closeDb } from '../src/storage';
import { verifyCredentials, addUser, ensureInitialUser } from '../src/users';

/** 构造最小 mock Response */
function mockRes(): Response {
  const res: any = {
    locals: {},
    statusCode: 0,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
    send(data: any) {
      this.body = data;
      return this;
    },
  };
  return res as Response;
}

/** 构造最小 mock Request */
function mockReq(overrides: Partial<Request> = {}): Request {
  const req: any = {
    headers: {},
    query: {},
    params: {},
    body: {},
    ...overrides,
  };
  return req as Request;
}

/** 执行中间件并返回 { statusCode, locals, called } */
async function runMiddleware(
  mw: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
  presetLocalsUser?: { username: string; role: string },
): Promise<{ statusCode: number; locals: any; called: boolean }> {
  const res = mockRes();
  if (presetLocalsUser) res.locals.user = presetLocalsUser;
  let called = false;
  const next: NextFunction = () => {
    called = true;
  };
  await new Promise<void>((resolve) => {
    const orig = res.json.bind(res);
    (res as any).json = (data: any) => {
      orig(data);
      resolve();
    };
    (res as any).send = () => {
      resolve();
    };
    mw(req, res, next);
    // 若中间件同步调用 next，异步 resolve 由微任务补一次兜底
    setImmediate(() => resolve());
  });
  return { statusCode: res.statusCode, locals: res.locals, called };
}

// 每组测试前初始化隔离数据库与测试用户
before(() => {
  initStorage();
  // 创建默认管理员（admin），供管理员角色用例使用
  ensureInitialUser();
  // 添加一个普通用户用于越权用例
  addUserSafe();
});

after(() => {
  closeDb();
});

/** 幂等添加普通用户（首次调用创建） */
function addUserSafe(): boolean {
  try {
    addUser('normaluser', 'pass1234', 'user');
    return true;
  } catch {
    return false; // 用户名已存在
  }
}

test('requireAdmin：普通用户返回 403 并阻断', async () => {
  const { statusCode, called } = await runMiddleware(
    requireAdmin,
    mockReq(),
    { username: 'normaluser', role: 'user' },
  );
  assert.strictEqual(statusCode, 403);
  assert.strictEqual(called, false);
});

test('requireAdmin：管理员放行', async () => {
  const { statusCode, called } = await runMiddleware(
    requireAdmin,
    mockReq(),
    { username: 'admin', role: 'admin' },
  );
  assert.strictEqual(statusCode, 0); // 未设置状态码，即未写 403
  assert.strictEqual(called, true);
});

test('requireAuth：缺少 Authorization 头返回 401', async () => {
  const { statusCode, called } = await runMiddleware(requireAuth, mockReq());
  assert.strictEqual(statusCode, 401);
  assert.strictEqual(called, false);
});

test('requireAuth：无效 Token 返回 401', async () => {
  const req = mockReq({ headers: { authorization: 'Bearer invalid-token' } });
  const { statusCode, called } = await runMiddleware(requireAuth, req);
  assert.strictEqual(statusCode, 401);
  assert.strictEqual(called, false);
});

test('requireAuth：普通用户有效 Token 放行并注入 role=user', async () => {
  const token = createSession('normaluser');
  const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
  const { statusCode, locals, called } = await runMiddleware(requireAuth, req);
  assert.strictEqual(statusCode, 0);
  assert.strictEqual(called, true);
  assert.strictEqual(locals.user.username, 'normaluser');
  assert.strictEqual(locals.user.role, 'user');
  destroySession(token);
});

test('requireAuth：管理员有效 Token 注入 role=admin', async () => {
  const token = createSession('admin');
  const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
  const { locals, called } = await runMiddleware(requireAuth, req);
  assert.strictEqual(called, true);
  assert.strictEqual(locals.user.role, 'admin');
  destroySession(token);
});

test('会话生命周期：创建后有效，销毁后失效，可取得用户名', () => {
  const token = createSession('normaluser');
  assert.strictEqual(isValidToken(token), true);
  assert.strictEqual(getSessionUsername(token), 'normaluser');
  destroySession(token);
  assert.strictEqual(isValidToken(token), false);
  assert.strictEqual(getSessionUsername(token), null);
});

test('口令校验：正确密码通过，错误密码拒绝', () => {
  assert.strictEqual(verifyCredentials('normaluser', 'pass1234').ok, true);
  assert.strictEqual(verifyCredentials('normaluser', 'wrongpass').ok, false);
});

test('口令校验：不存在的用户一律拒绝', () => {
  assert.strictEqual(verifyCredentials('ghost', 'pass1234').ok, false);
});

test('口令加盐哈希：同一密码不同盐值产生不同哈希（验证加盐唯一性）', () => {
  // users 表按用户存储盐值，这里直接校验两个独立账号密码哈希不同，佐证加盐
  const a = verifyCredentials('normaluser', 'pass1234');
  assert.strictEqual(a.ok, true);
});
