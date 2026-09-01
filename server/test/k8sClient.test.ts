/**
 * K8s 客户端封装单测（1.5.0）
 *
 * 不依赖真实集群：通过临时 kubeconfig 文件验证加载、context 列表/切换与 Quantity 解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kubeconfigPath, loadKubeConfig, listK8sContexts, setK8sContext, parseQuantity } from '../src/k8s/k8sClient';

/** 构造临时 kubeconfig 并返回其路径（两个 context） */
function makeKubeconfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8s-test-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(
    file,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      '- name: c1',
      '  cluster:',
      '    server: http://127.0.0.1:18099',
      '    insecure-skip-tls-verify: true',
      '- name: c2',
      '  cluster:',
      '    server: http://127.0.0.1:18098',
      '    insecure-skip-tls-verify: true',
      'contexts:',
      '- name: ctx-a',
      '  context: {cluster: c1, user: u1}',
      '- name: ctx-b',
      '  context: {cluster: c2, user: u1}',
      'users:',
      '- name: u1',
      '  user: {}',
      'current-context: ctx-a',
      '',
    ].join('\n'),
  );
  return file;
}

test('kubeconfigPath 优先读取 KUBECONFIG 环境变量', () => {
  const prev = process.env.KUBECONFIG;
  process.env.KUBECONFIG = '/tmp/fake-kubeconfig';
  try {
    assert.equal(kubeconfigPath(), '/tmp/fake-kubeconfig');
  } finally {
    if (prev === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prev;
  }
});

test('loadKubeConfig 可加载临时 kubeconfig 并列出 context', () => {
  const file = makeKubeconfig();
  const prev = process.env.KUBECONFIG;
  process.env.KUBECONFIG = file;
  try {
    const kc = loadKubeConfig();
    assert.equal(kc.getCurrentContext(), 'ctx-a');
    const contexts = listK8sContexts();
    assert.deepEqual(
      contexts.map((c) => c.name),
      ['ctx-a', 'ctx-b'],
    );
    assert.equal(contexts[0].current, true);
  } finally {
    if (prev === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prev;
  }
});

test('setK8sContext 可运行期切换 context；未知 context 报错', () => {
  const file = makeKubeconfig();
  const prev = process.env.KUBECONFIG;
  process.env.KUBECONFIG = file;
  try {
    setK8sContext('ctx-b');
    const contexts = listK8sContexts();
    assert.equal(contexts.find((c) => c.name === 'ctx-b')?.current, true);
    assert.throws(() => setK8sContext('no-such-ctx'), /context 不存在/);
  } finally {
    if (prev === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prev;
  }
});

test('loadKubeConfig 对不存在的文件抛错', () => {
  const prev = process.env.KUBECONFIG;
  process.env.KUBECONFIG = path.join(os.tmpdir(), 'no-such-kubeconfig-xyz');
  try {
    assert.throws(() => loadKubeConfig());
  } finally {
    if (prev === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prev;
  }
});

test('parseQuantity 解析 CPU 与二进制/十进制内存单位', () => {
  // CPU 毫核
  assert.equal(parseQuantity('500m'), 0.5);
  assert.equal(parseQuantity('2500m'), 2.5);
  assert.equal(parseQuantity('2'), 2);
  // 二进制
  assert.equal(parseQuantity('1Ki'), 1024);
  assert.equal(parseQuantity('1Mi'), 1024 ** 2);
  assert.equal(parseQuantity('1Gi'), 1024 ** 3);
  assert.equal(parseQuantity('128Mi'), 128 * 1024 ** 2);
  // 十进制 SI
  assert.equal(parseQuantity('1k'), 1e3);
  assert.equal(parseQuantity('1M'), 1e6);
  // 空值
  assert.equal(parseQuantity(''), 0);
  assert.equal(parseQuantity(undefined), 0);
});
