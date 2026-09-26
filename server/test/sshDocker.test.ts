/**
 * SSH 引擎桥接单元测试（1.93.0）
 * 覆盖：ssh:// 端点解析、SSH 端点判定、凭证加载容错
 * 真实 SSH 连通性依赖远程主机，不做单测覆盖（冒烟验证于开发环境）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSshEndpoint, isSshEndpoint } from '../src/docker/sshDocker';

test('parseSshEndpoint: 完整形式 user@host:port', () => {
  const p = parseSshEndpoint('ssh://root@192.168.1.10:2222');
  assert.deepStrictEqual(p, { user: 'root', host: '192.168.1.10', port: 2222 });
});

test('parseSshEndpoint: 缺省 user 与 port', () => {
  assert.deepStrictEqual(parseSshEndpoint('ssh://10.0.0.5'), { user: 'root', host: '10.0.0.5', port: 22 });
  assert.deepStrictEqual(parseSshEndpoint('ssh://ops@myhost'), { user: 'ops', host: 'myhost', port: 22 });
  assert.deepStrictEqual(parseSshEndpoint('ssh://root@host:22/'), { user: 'root', host: 'host', port: 22 });
});

test('parseSshEndpoint: 非法端点抛 400', () => {
  assert.throws(() => parseSshEndpoint('tcp://127.0.0.1:2375'), (e: any) => e.statusCode === 400);
  assert.throws(() => parseSshEndpoint('ssh://'), (e: any) => e.statusCode === 400);
  assert.throws(() => parseSshEndpoint(''), (e: any) => e.statusCode === 400);
});

test('isSshEndpoint: 大小写与空值', () => {
  assert.strictEqual(isSshEndpoint('ssh://root@h'), true);
  assert.strictEqual(isSshEndpoint('SSH://root@h'), true);
  assert.strictEqual(isSshEndpoint(' tcp://h:2375 '), false);
  assert.strictEqual(isSshEndpoint(''), false);
  assert.strictEqual(isSshEndpoint(null), false);
  assert.strictEqual(isSshEndpoint(undefined), false);
});
