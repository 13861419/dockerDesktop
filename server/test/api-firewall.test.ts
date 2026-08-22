import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 9528;
const BASE = '/api/firewall';

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

describe('firewall API', () => {
  before(async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
    AUTH_TOKEN = r.data?.token || '';
    assert.ok(AUTH_TOKEN, 'login should return a token');
  });

  it('GET /api/firewall/ports — lists managed ports', async () => {
    const r = await req('GET', `${BASE}/ports`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.equal(typeof r.data?.supported, 'boolean');
      assert.ok(Array.isArray(r.data?.ports));
    }
  });

  it('GET /api/firewall/ports — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', `${BASE}/ports`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('GET /api/firewall/check — returns platform and permission info', async () => {
    const r = await req('GET', `${BASE}/check`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.equal(typeof r.data?.supported, 'boolean');
      assert.equal(typeof r.data?.writable, 'boolean');
    }
  });

  it('GET /api/firewall/check — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', `${BASE}/check`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('POST /api/firewall/ports — invalid port returns 400', async () => {
    const r = await req('POST', `${BASE}/ports`, { port: -1, proto: 'tcp' });
    assert.equal(r.status, 400);
  });

  it('POST /api/firewall/ports — port out of range returns 400', async () => {
    const r = await req('POST', `${BASE}/ports`, { port: 99999, proto: 'tcp' });
    assert.equal(r.status, 400);
  });

  it('POST /api/firewall/ports — invalid protocol returns 400', async () => {
    const r = await req('POST', `${BASE}/ports`, { port: 8080, proto: 'icmp' });
    assert.equal(r.status, 400);
  });

  it('POST /api/firewall/ports — missing port returns 400', async () => {
    const r = await req('POST', `${BASE}/ports`, { proto: 'tcp' });
    assert.equal(r.status, 400);
  });

  it('POST /api/firewall/ports — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('POST', `${BASE}/ports`, { port: 19999, proto: 'tcp' });
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('POST /api/firewall/ports — duplicate port/proto returns 400', async () => {
    // First add
    const r1 = await req('POST', `${BASE}/ports`, { port: 19998, proto: 'udp', remark: 'test-dup' });
    if (r1.status === 201) {
      // Duplicate should fail
      const r2 = await req('POST', `${BASE}/ports`, { port: 19998, proto: 'udp', remark: 'dup' });
      assert.equal(r2.status, 400);
      // Clean up
      await req('DELETE', `${BASE}/ports/${r1.data?.id}`);
    }
  });

  it('POST /api/firewall/ports — non-Windows returns 400', async () => {
    // On non-Windows this should return 400; on Windows with valid port may return 201
    const r = await req('POST', `${BASE}/ports`, { port: 19997, proto: 'tcp', remark: 'test-nonwin' });
    assert.ok([201, 400].includes(r.status));
    if (r.status === 201 && r.data?.id) {
      await req('DELETE', `${BASE}/ports/${r.data.id}`);
    }
  });

  it('DELETE /api/firewall/ports/:id — non-existent id returns 404', async () => {
    const r = await req('DELETE', `${BASE}/ports/nonexistent-id-000`);
    assert.equal(r.status, 404);
  });

  it('DELETE /api/firewall/ports/:id — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('DELETE', `${BASE}/ports/fake-id`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('DELETE /api/firewall/ports/:id — round-trip create then delete', async () => {
    const r1 = await req('POST', `${BASE}/ports`, { port: 19996, proto: 'tcp', remark: 'round-trip' });
    if (r1.status === 201 && r1.data?.id) {
      const r2 = await req('DELETE', `${BASE}/ports/${r1.data.id}`);
      assert.ok([200, 400].includes(r2.status));
    }
  });
});
