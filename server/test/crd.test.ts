/**
 * 1.22.0 CRD 查看单测：临时假 apiserver 验证 CRD 列表与自定义资源实例查询
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18097;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/apis/apiextensions.k8s.io/v1/customresourcedefinitions') {
    res.end(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'foos.foo.example.com', creationTimestamp: '2026-01-01T00:00:00Z' },
            spec: {
              group: 'foo.example.com',
              scope: 'Namespaced',
              names: { kind: 'Foo', plural: 'foos' },
              versions: [
                { name: 'v1', storage: true },
                { name: 'v2beta1', storage: false },
              ],
            },
          },
        ],
      }),
    );
    return;
  }
  if (req.url === '/apis/foo.example.com/v1/foos') {
    res.end(
      JSON.stringify({
        items: [
          {
            kind: 'Foo',
            metadata: { name: 'demo', namespace: 'default', creationTimestamp: '2026-02-01T00:00:00Z', labels: { app: 'x' } },
            spec: { size: 3 },
          },
        ],
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-crd-'));
const kubeconfigFile = path.join(tmpDir, 'config');
fs.writeFileSync(
  kubeconfigFile,
  [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    `- name: c1`,
    '  cluster:',
    `    server: http://127.0.0.1:${PORT}`,
    '    insecure-skip-tls-verify: true',
    'contexts:',
    '- name: ctx-crd',
    '  context: {cluster: c1, user: u1}',
    'current-context: ctx-crd',
    'users:',
    '- name: u1',
    '  user: {}',
  ].join('\n'),
);

before(async () => {
  process.env.KUBECONFIG = kubeconfigFile;
  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));
});

after(() => {
  server.close();
  delete process.env.KUBECONFIG;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('crd: listCrds 提取 group/version/kind/plural/scope', async () => {
  const { listCrds } = await import('../src/k8s/k8sClient');
  const crds = await listCrds();
  assert.strictEqual(crds.length, 1);
  assert.strictEqual(crds[0].name, 'foos.foo.example.com');
  assert.strictEqual(crds[0].group, 'foo.example.com');
  assert.strictEqual(crds[0].version, 'v1');
  assert.strictEqual(crds[0].kind, 'Foo');
  assert.strictEqual(crds[0].scope, 'Namespaced');
  assert.strictEqual(crds[0].createdAt, new Date('2026-01-01T00:00:00Z').getTime());
});

test('crd: listCrdResources 返回实例（name/spec/label）且 CRD 不存在时报错', async () => {
  const { listCrdResources } = await import('../src/k8s/k8sClient');
  const items = await listCrdResources('foos.foo.example.com');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'demo');
  assert.strictEqual((items[0].spec as any).size, 3);

  await assert.rejects(() => listCrdResources('nope.example.com'), /CRD 不存在/);
});
