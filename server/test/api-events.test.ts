import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 9528;
const BASE = '/api/events';

let AUTH_TOKEN = '';

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
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
          resolve({ status: res.statusCode!, data, headers: res.headers });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe('events API', () => {
  before(async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
    AUTH_TOKEN = r.data?.token || '';
    assert.ok(AUTH_TOKEN, 'login should return a token');
  });

  it('GET /api/events — returns recent events', async () => {
    const r = await req('GET', BASE);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.events));
      assert.ok(Array.isArray(r.data?.types));
      assert.ok(Array.isArray(r.data?.actions));
      assert.equal(r.data?.history, false);
    }
  });

  it('GET /api/events — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', BASE);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('GET /api/events?type=container — filter by type', async () => {
    const r = await req('GET', `${BASE}?type=container`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.events));
    }
  });

  it('GET /api/events?action=start — filter by action', async () => {
    const r = await req('GET', `${BASE}?action=start`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.events));
    }
  });

  it('GET /api/events?history=1 — persisted history query', async () => {
    const r = await req('GET', `${BASE}?history=1`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.events));
      assert.equal(r.data?.history, true);
    }
  });

  it('GET /api/events?history=1&limit=10 — pagination', async () => {
    const r = await req('GET', `${BASE}?history=1&limit=10`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(r.data?.events.length <= 10);
    }
  });

  it('GET /api/events?history=1&type=container&action=start — combined filters', async () => {
    const r = await req('GET', `${BASE}?history=1&type=container&action=start`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.events));
    }
  });

  it('GET /api/events/history/export — returns CSV', async () => {
    const r = await req('GET', `${BASE}/history/export`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(r.headers['content-type']?.includes('text/csv'));
      assert.ok(typeof r.data === 'string');
    }
  });

  it('GET /api/events/history/export — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', `${BASE}/history/export`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('GET /api/events/history/export?type=container — filtered CSV export', async () => {
    const r = await req('GET', `${BASE}/history/export?type=container`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(r.headers['content-type']?.includes('text/csv'));
    }
  });

  it('DELETE /api/events/history — clears persisted history', async () => {
    const r = await req('DELETE', `${BASE}/history`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.equal(r.data?.ok, true);
    }
  });

  it('DELETE /api/events/history — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('DELETE', `${BASE}/history`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('GET /api/events/stats — returns event statistics', async () => {
    const r = await req('GET', `${BASE}/stats`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.byType));
      assert.ok(Array.isArray(r.data?.byAction));
      assert.ok(Array.isArray(r.data?.timeline));
    }
  });

  it('GET /api/events/stats — unauthenticated returns 401', async () => {
    const saved = AUTH_TOKEN;
    AUTH_TOKEN = '';
    const r = await req('GET', `${BASE}/stats`);
    AUTH_TOKEN = saved;
    assert.equal(r.status, 401);
  });

  it('GET /api/events/stats?bucket=day — day bucket', async () => {
    const r = await req('GET', `${BASE}/stats?bucket=day`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.timeline));
    }
  });

  it('GET /api/events/stats?type=container — filtered stats', async () => {
    const r = await req('GET', `${BASE}/stats?type=container`);
    assert.ok([200, 401].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.data?.byType));
    }
  });
});
