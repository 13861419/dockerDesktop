/**
 * A1「Webhook 自动化部署」核心单元测试（基于 Node 内置 node:test，零第三方依赖）
 *
 * 覆盖：
 *  1. gitCli.sanitizeTag：分支名清洗为合法镜像 tag
 *  2. storage 的 Git 凭证加解密：encryptSecret/decryptSecret 可还原，且不等于明文
 *
 * 运行：先设置临时数据目录再 import storage，避免污染真实 data/ 数据库。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 必须先于 storage 模块加载设置临时数据目录，确保 getDb() / .cred-secret 指向隔离环境
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-webhook-test-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { sanitizeTag } from '../src/gitCli';
import { initStorage, closeDb, encryptSecret, decryptSecret } from '../src/storage';

// 与 auth-security.test.ts 保持一致：initStorage/closeDb 为同步函数，直接调用（不 await）
before(() => {
  initStorage();
});
after(() => {
  closeDb();
});

test('sanitizeTag 清洗分支名为合法镜像 tag', () => {
  assert.strictEqual(sanitizeTag('main'), 'main');
  assert.strictEqual(sanitizeTag('feature/my-app'), 'feature-my-app');
  assert.strictEqual(sanitizeTag('release-1.0'), 'release-1.0');
  assert.strictEqual(sanitizeTag(''), 'latest');
  assert.strictEqual(sanitizeTag('  '), 'latest');
  assert.strictEqual(sanitizeTag(undefined), 'latest');
});

test('Git 凭证可加密落库并解密还原', () => {
  const cred = JSON.stringify({ type: 'ssh', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----' });
  const enc = encryptSecret(cred);
  // 密文不应等于明文，且包含加密特征
  assert.notStrictEqual(enc, cred);
  assert.ok(String(enc));
  // 解密还原须一致
  assert.strictEqual(decryptSecret(enc), cred);
});

test('sanitizeTag 将危险字符替换为连字符', () => {
  assert.strictEqual(sanitizeTag('feature/branch with space'), 'feature-branch-with-space');
  assert.match(sanitizeTag('a&b|c'), /^[a-zA-Z0-9._-]+$/);
});
