import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 9528;
const BASE = '/api/swarm';

let AUTH_TOKEN = '';

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const r = http.request(
      { hostname: HOST, port: PORT, path, method, headers: { 'Content-Type': 'application/json', ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}) } },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          let data: any;
          try { data = JSON.parse(buf); } catch { data = buf; }
          resolve({ status: res.statusCode!, data });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe('swarm API', () => {
  before(async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
    AUTH_TOKEN = r.data?.token || '';
    assert.ok(AUTH_TOKEN, 'login should return a token');
  });

  it('GET /api/swarm/status — returns swarm state', async () => {
    const r = await req('GET', `${BASE}/status`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.equal(typeof r.data?.enabled, 'boolean');
      assert.equal(typeof r.data?.localNodeState, 'string');
      assert.ok(Array.isArray(r.data?.nodes));
    }
  });

  it('GET /api/swarm/status — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', `${BASE}/status`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('GET /api/swarm/services — returns service list or swarm-not-enabled', async () => {
    const r = await req('GET', `${BASE}/services`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      if (r.data?.ok === false) {
        assert.equal(r.data?.error, 'swarm-not-enabled');
      } else {
        assert.equal(r.data?.ok, true);
        assert.ok(Array.isArray(r.data?.services));
      }
    }
  });

  it('GET /api/swarm/services — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', `${BASE}/services`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('GET /api/swarm/services/:id — non-existent service returns 404 or swarm-not-enabled', async () => {
    const r = await req('GET', `${BASE}/services/nonexistent-svc-id`);
    assert.ok([200, 401, 404].includes(r.status));
    if (r.status === 200) {
      assert.ok(
        r.data?.error === 'swarm-not-enabled' || r.data?.ok === false,
      );
    }
  });

  it('GET /api/swarm/services/:id — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', `${BASE}/services/fake-id`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('DELETE /api/swarm/services/:id — non-existent or swarm-disabled returns gracefully', async () => {
    const r = await req('DELETE', `${BASE}/services/nonexistent-svc-id`);
    assert.ok([200, 401, 404].includes(r.status));
    if (r.status === 200) {
      assert.ok(
        r.data?.ok === false || r.data?.ok === true,
      );
    }
  });

  it('DELETE /api/swarm/services/:id — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('DELETE', `${BASE}/services/fake-id`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('POST /api/swarm/services/:id/scale — non-existent or swarm-disabled returns gracefully', async () => {
    const r = await req('POST', `${BASE}/services/nonexistent-svc-id/scale`, { replicas: 2 });
    assert.ok([200, 401, 404].includes(r.status));
    if (r.status === 200) {
      assert.ok(
        r.data?.ok === false || r.data?.ok === true,
      );
    }
  });

  it('POST /api/swarm/services/:id/scale — invalid replicas returns ok:false', async () => {
    const r = await req('POST', `${BASE}/services/fake-id/scale`, { replicas: -1 });
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.equal(r.data?.ok, false);
      assert.ok(r.data?.error);
    }
  });

  it('POST /api/swarm/services/:id/scale — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('POST', `${BASE}/services/fake-id/scale`, { replicas: 2 });
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });
});
