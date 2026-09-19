/**
 * 镜像构建推送单元测试（1.80.0）：tag 模板求值与 registry host 解析
 */
import { test } from 'node:test';
import assert = require('node:assert');
import { evalImageTag, registryHostOf } from '../src/routes/deploys';

test('evalImageTag: 默认模板 {branch}-{sha7}', () => {
  assert.strictEqual(evalImageTag('{branch}-{sha7}', 'main', 'a1b2c3d4e5f6'), 'main-a1b2c3d');
  assert.strictEqual(evalImageTag(null, 'dev', 'a1b2c3d4e5f6'), 'dev-a1b2c3d');
});

test('evalImageTag: 自定义模板与 {ts} 变量', () => {
  const tag = evalImageTag('v-{ts}', 'main', 'a1b2c3d4e5f6');
  assert.match(tag, /^v-\d{14}$/);
  assert.strictEqual(evalImageTag('release', 'main', 'a1b2c3d4e5f6'), 'release');
});

test('evalImageTag: 无 commit 回退 manual，非法字符归一', () => {
  assert.strictEqual(evalImageTag('{branch}-{sha7}', 'feature/x', ''), 'feature-x-manual');
  assert.strictEqual(evalImageTag('a b:c', 'main', 'a1b2c3d4e5f6'), 'a-b-c');
  assert.strictEqual(evalImageTag('###', 'main', ''), 'latest');
});

test('registryHostOf: 有 host 与无 host（Docker Hub）', () => {
  assert.strictEqual(registryHostOf('harbor.example.com/team/app'), 'harbor.example.com');
  assert.strictEqual(registryHostOf('localhost:5000/app'), 'localhost:5000');
  assert.strictEqual(registryHostOf('myuser/myapp'), '');
  assert.strictEqual(registryHostOf('nginx'), '');
});
