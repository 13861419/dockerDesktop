/**
 * 1.4.0 OpenAPI 文档单元测试：骨架结构与端点覆盖
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-openapi-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { buildOpenApiDocument, PATHS } from '../src/openapi';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('openapi: 文档结构符合 OpenAPI 3.0', () => {
  const doc = buildOpenApiDocument('http://localhost:9528');
  assert.strictEqual(doc.openapi, '3.0.3');
  assert.ok(doc.info.title.includes('Docker Manager'));
  assert.ok(doc.servers[0].url === 'http://localhost:9528');
  assert.ok(doc.components.securitySchemes.bearerAuth);
  // 端点数量充足（核心骨架 ≥ 30 个路径）
  assert.ok(Object.keys(doc.paths).length >= 30);
});

test('openapi: 端点条目含标签 / 鉴权 / 方法', () => {
  const login = PATHS['认证 / 会话']['POST /api/auth/login'];
  assert.ok(login.summary.includes('Token'));
  assert.strictEqual(login.auth, true);
  const history = PATHS['监控']['GET /api/monitor/history/range'];
  assert.strictEqual(history.queryParams?.range?.description.includes('30d'), true);
  // build 后每个 operation 携带 security 与 tags
  const doc = buildOpenApiDocument('http://x');
  const approve = doc.paths['/api/approvals/:id/approve'].post;
  assert.deepStrictEqual(approve.tags, ['审批']);
  assert.deepStrictEqual(approve.security, [{ bearerAuth: [] }]);
});
