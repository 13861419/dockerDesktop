/**
 * 部署凭据库（1.85.0）单元测试
 *
 * 覆盖：
 *  - normalizeCredSecret：git / registry 凭据校验与归一
 *  - nextCloneName：克隆应用唯一命名
 *  - resolveGitCred / resolveRegistryCred：凭据库引用优先、回落内联、损坏回落
 */
import { test } from 'node:test';
import assert from 'node:assert';

// 必须先于 storage 模块加载设置临时数据目录
import os from 'os';
import path from 'path';
import fs from 'fs';
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-creds-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { normalizeCredSecret } from '../src/routes/creds';
import { nextCloneName, resolveGitCred, resolveRegistryCred } from '../src/routes/deploys';
import { getDb, encryptSecret } from '../src/storage';

test('normalizeCredSecret: git token / ssh / registry', () => {
  assert.deepStrictEqual(normalizeCredSecret('git', { token: ' t1 ' }), { type: 'token', token: 't1' });
  assert.deepStrictEqual(normalizeCredSecret('git', { privateKey: 'key', passphrase: 'p', type: 'ssh' }), { type: 'ssh', privateKey: 'key', passphrase: 'p' });
  assert.deepStrictEqual(normalizeCredSecret('registry', { user: 'u', pass: 'p' }), { user: 'u', pass: 'p' });
  // 非法：git 无 token 也无 key；registry 缺密码；未知类型；非对象
  assert.strictEqual(normalizeCredSecret('git', { user: 'x' }), null);
  assert.strictEqual(normalizeCredSecret('registry', { user: 'u' }), null);
  assert.strictEqual(normalizeCredSecret('other', { a: 1 }), null);
  assert.strictEqual(normalizeCredSecret('git', 'str'), null);
});

test('nextCloneName: 唯一命名链', () => {
  assert.strictEqual(nextCloneName([], 'app'), 'app');
  assert.strictEqual(nextCloneName(['app'], 'app'), 'app-copy');
  assert.strictEqual(nextCloneName(['app', 'app-copy'], 'app'), 'app-copy-2');
  assert.strictEqual(nextCloneName(['app', 'app-copy', 'app-copy-2', 'app-copy-3'], 'app'), 'app-copy-4');
  // 超长截断后仍不冲突
  const long = 'a'.repeat(64);
  const names = [long];
  const out = nextCloneName(names, long);
  assert.ok(out.length <= 64);
  assert.ok(!names.includes(out));
});

test('resolveGitCred: 引用优先、回落内联、无凭据 null', () => {
  const d = getDb();
  const now = Date.now();
  d.prepare('INSERT INTO deploy_creds (name, type, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('g1', 'git', encryptSecret(JSON.stringify({ type: 'token', token: 'VAULT_T' })), now, now);
  d.prepare('INSERT INTO deploy_creds (name, type, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('r1', 'registry', encryptSecret(JSON.stringify({ user: 'ru', pass: 'rp' })), now, now);
  const vaultGit = d.prepare('SELECT id FROM deploy_creds WHERE name = ?').get('g1') as any;
  const vaultReg = d.prepare('SELECT id FROM deploy_creds WHERE name = ?').get('r1') as any;

  const app = {
    git_cred_id: vaultGit.id,
    registry_cred_id: vaultReg.id,
    cred_encrypted: encryptSecret(JSON.stringify({ type: 'token', token: 'INLINE_T' })),
    registry_user_enc: encryptSecret('iu'),
    registry_pass_enc: encryptSecret('ip'),
  };
  // 引用优先
  const git = resolveGitCred(app as any);
  assert.strictEqual(git?.token, 'VAULT_T');
  const reg = resolveRegistryCred(app as any);
  assert.deepStrictEqual(reg, { user: 'ru', pass: 'rp' });

  // 引用置空 → 内联
  const inlineOnly = { ...app, git_cred_id: null, registry_cred_id: null };
  assert.strictEqual(resolveGitCred(inlineOnly as any)?.token, 'INLINE_T');
  assert.deepStrictEqual(resolveRegistryCred(inlineOnly as any), { user: 'iu', pass: 'ip' });

  // 引用悬空（凭据已删）→ 回落内联
  assert.strictEqual(resolveGitCred({ ...app, git_cred_id: 99999 } as any)?.token, 'INLINE_T');
  assert.deepStrictEqual(resolveRegistryCred({ ...app, registry_cred_id: 99999 } as any), { user: 'iu', pass: 'ip' });

  // 无凭据
  assert.strictEqual(resolveGitCred({ git_cred_id: null, cred_encrypted: null } as any), null);
  assert.deepStrictEqual(resolveRegistryCred({ registry_cred_id: null, registry_user_enc: null, registry_pass_enc: null } as any), { user: '', pass: '' });
});
