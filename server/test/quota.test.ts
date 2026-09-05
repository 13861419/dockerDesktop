/**
 * 1.24.0 配额巡检单测：本地假 apiserver 验证 ResourceQuota / LimitRange / NetworkPolicy 提取
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18096;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const u = (req.url || '').split('?')[0];
  if (u === '/api/v1/resourcequotas') {
    res.end(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'quota-a', namespace: 'default', creationTimestamp: '2026-01-01T00:00:00Z' },
            status: { hard: { 'requests.cpu': '4', pods: '20' }, used: { 'requests.cpu': '1500m', pods: '5' } },
          },
        ],
      }),
    );
    return;
  }
  if (u === '/api/v1/limitranges') {
    res.end(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'lr-a', namespace: 'default', creationTimestamp: '2026-01-01T00:00:00Z' },
            spec: { limits: [{ type: 'Container', default: { cpu: '500m' }, defaultRequest: { memory: '128Mi' } }] },
          },
        ],
      }),
    );
    return;
  }
  if (u === '/apis/networking.k8s.io/v1/networkpolicies') {
    res.end(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'np-a', namespace: 'default', creationTimestamp: '2026-01-01T00:00:00Z' },
            spec: {
              podSelector: { matchLabels: { app: 'web' } },
              policyTypes: ['Ingress', 'Egress'],
              ingress: [{}],
              egress: [{}, {}],
            },
          },
        ],
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-quota-'));
const kubeconfigFile = path.join(tmpDir, 'config');
fs.writeFileSync(
  kubeconfigFile,
  [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: c1',
    '  cluster:',
    `    server: http://127.0.0.1:${PORT}`,
    '    insecure-skip-tls-verify: true',
    'contexts:',
    '- name: ctx-quota',
    '  context: {cluster: c1, user: u1}',
    'current-context: ctx-quota',
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

test('quota: listResourceQuotas 提取 hard/used', async () => {
  const { listResourceQuotas } = await import('../src/k8s/k8sClient');
  const quotas = await listResourceQuotas();
  assert.strictEqual(quotas.length, 1);
  assert.strictEqual(quotas[0].name, 'quota-a');
  assert.strictEqual(quotas[0].hard.pods, '20');
  assert.strictEqual(quotas[0].used['requests.cpu'], '1500m');
});

test('quota: listLimitRanges 提取 default/defaultRequest', async () => {
  const { listLimitRanges } = await import('../src/k8s/k8sClient');
  const ranges = await listLimitRanges();
  assert.strictEqual(ranges.length, 1);
  assert.strictEqual(ranges[0].limits[0].default, 'cpu=500m');
  assert.strictEqual(ranges[0].limits[0].defaultRequest, 'memory=128Mi');
});

test('quota: listNetworkPolicies 提取 policyTypes 与选择器', async () => {
  const { listNetworkPolicies } = await import('../src/k8s/k8sClient');
  const nps = await listNetworkPolicies();
  assert.strictEqual(nps.length, 1);
  assert.strictEqual(nps[0].policyTypes.join('/'), 'Ingress/Egress');
  assert.strictEqual(nps[0].podSelector, 'app=web');
  assert.strictEqual(nps[0].ingress, 1);
  assert.strictEqual(nps[0].egress, 2);
});
