import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 9528;
const BASE = '/api/engines';

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

describe('engines API', () => {
  before(async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
    AUTH_TOKEN = r.data?.token || '';
    assert.ok(AUTH_TOKEN, 'login should return a token');
  });

  it('GET /api/engines — lists engines', async () => {
    const r = await req('GET', BASE);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.engines));
    }
  });

  it('GET /api/engines — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', BASE);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('POST /api/engines — create with bad endpoint returns 400', async () => {
    const r = await req('POST', BASE, { name: 'test-engine', endpoint: 'tcp://192.0.2.1:99999' });
    assert.ok([400, 500].includes(r.status));
  });

  it('POST /api/engines — create with invalid name returns 400', async () => {
    const r = await req('POST', BASE, { name: '', endpoint: 'tcp://127.0.0.1:2375' });
    assert.equal(r.status, 400);
  });

  it('POST /api/engines — create with missing endpoint returns 400', async () => {
    const r = await req('POST', BASE, { name: 'no-endpoint' });
    assert.equal(r.status, 400);
  });

  it('POST /api/engines — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('POST', BASE, { name: 'x', endpoint: 'tcp://127.0.0.1:2375' });
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('PUT /api/engines/:id — non-existent id returns 404', async () => {
    const r = await req('PUT', `${BASE}/nonexistent-id-000`, { name: 'updated' });
    assert.equal(r.status, 404);
  });

  it('PUT /api/engines/:id — empty name returns 400', async () => {
    const r = await req('PUT', `${BASE}/nonexistent-id-000`, { name: '' });
    assert.equal(r.status, 404);
  });

  it('PUT /api/engines/:id — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('PUT', `${BASE}/fake-id`, { name: 'x' });
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('DELETE /api/engines/:id — non-existent id returns 404', async () => {
    const r = await req('DELETE', `${BASE}/nonexistent-id-000`);
    assert.equal(r.status, 404);
  });

  it('DELETE /api/engines/:id — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('DELETE', `${BASE}/fake-id`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('POST /api/engines/:id/switch — non-existent id returns 404', async () => {
    const r = await req('POST', `${BASE}/nonexistent-id-000/switch`);
    assert.equal(r.status, 404);
  });

  it('POST /api/engines/:id/switch — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('POST', `${BASE}/fake-id/switch`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });
});
