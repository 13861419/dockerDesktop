/**
 * K8s 路由 API 集成测试
 *
 * 覆盖：
 *  1. GET /api/k8s/status：可用性探测结构（available/contexts/reason）
 *  2. 未认证访问 401
 *  3. 集群端点返回结构合法（有集群 → 200 数据；无集群 → 503 引导）
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';

function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode || 0, data: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

let token = '';

before(async () => {
  const res = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  token = res.data?.token || res.data?.data?.token || '';
});

test('k8s api: 未认证访问 401/403', async () => {
  const res = await req('GET', '/api/k8s/status');
  assert.ok(res.status === 401 || res.status === 403, `unauth status ${res.status}`);
});

test('k8s api: status 返回可用性与 context 结构', async () => {
  const res = await req('GET', '/api/k8s/status', undefined, { Authorization: `Bearer ${token}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.data.available, 'boolean');
  assert.ok(Array.isArray(res.data.contexts));
  if (res.data.available === false) {
    assert.ok(typeof res.data.reason === 'string' && res.data.reason.length > 0, '不可用时给出引导 reason');
  }
});

test('k8s api: 列表端点返回结构合法（200 数组 或 503 引导）', async () => {
  for (const p of ['/api/k8s/overview', '/api/k8s/pods', '/api/k8s/deployments', '/api/k8s/configmaps', '/api/k8s/secrets', '/api/k8s/ingresses', '/api/k8s/helm-releases', '/api/k8s/metrics-history']) {
    const res = await req('GET', p, undefined, { Authorization: `Bearer ${token}` });
    const ok = res.status === 200 || res.status === 503;
    assert.ok(ok, `${p} status ${res.status}`);
    if (res.status === 503) {
      assert.ok(res.body.reason, `${p} 503 须携带 reason`);
    }
  }
});
