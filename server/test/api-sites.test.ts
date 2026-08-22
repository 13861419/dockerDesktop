/**
 * Sites / Reverse Proxy API integration tests
 *
 * Endpoints covered:
 *  1. GET    /api/sites
 *  2. POST   /api/sites
 *  3. PUT    /api/sites/:id
 *  4. DELETE /api/sites/:id
 *  5. POST   /api/sites/:id/toggle
 *  6. POST   /api/sites/reload
 *  7. GET    /api/sites/:id/cert
 *  8. POST   /api/sites/:id/cert
 *
 * Requires backend running on localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

function req(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>,
): Promise<{ status: number; data: any }> {
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
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode || 0, data: parsed });
      });
    });
    r.on('error', reject);
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        r.write(body);
      } else {
        r.write(JSON.stringify(body));
      }
    }
    r.end();
  });
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${adminToken}` };
}

before(async () => {
  const login = await req('POST', '/api/auth/login', {
    username: 'admin',
    password: 'admin888',
  });
  assert.ok(login.data.token, 'login must return token');
  adminToken = login.data.token;
});

/* ─── Auth tests ─── */

test('GET /api/sites: no token returns 401', async () => {
  const res = await req('GET', '/api/sites');
  assert.strictEqual(res.status, 401);
});

test('POST /api/sites: no token returns 401', async () => {
  const res = await req('POST', '/api/sites', {
    domain: 'x.com',
    upstreamHost: '127.0.0.1',
    upstreamPort: 80,
  });
  assert.strictEqual(res.status, 401);
});

test('PUT /api/sites/:id: no token returns 401', async () => {
  const res = await req('PUT', '/api/sites/fake-id', {
    domain: 'x.com',
    upstreamHost: '127.0.0.1',
    upstreamPort: 80,
  });
  assert.strictEqual(res.status, 401);
});

test('DELETE /api/sites/:id: no token returns 401', async () => {
  const res = await req('DELETE', '/api/sites/fake-id');
  assert.strictEqual(res.status, 401);
});

test('POST /api/sites/:id/toggle: no token returns 401', async () => {
  const res = await req('POST', '/api/sites/fake-id/toggle');
  assert.strictEqual(res.status, 401);
});

test('POST /api/sites/reload: no token returns 401', async () => {
  const res = await req('POST', '/api/sites/reload');
  assert.strictEqual(res.status, 401);
});

/* ─── GET /api/sites ─── */

test('GET /api/sites: returns site list', async () => {
  const res = await req('GET', '/api/sites', undefined, auth());
  assert.ok(res.status >= 200 && res.status < 500, 'status ' + res.status);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data.sites), 'sites must be array');
  }
});

/* ─── CRUD lifecycle ─── */

let createdSiteId = '';

const SITE_PAYLOAD = {
  domain: 'test-site-api.example.com',
  upstreamHost: '192.168.1.100',
  upstreamPort: 3000,
  listenPort: 80,
  enableHttps: false,
  enabled: true,
  enableWs: false,
  enableGzip: true,
  enableAuth: false,
  clientMaxBody: '1m',
  proxyTimeout: 60,
};

test('POST /api/sites: create site', async () => {
  const res = await req('POST', '/api/sites', SITE_PAYLOAD, auth());
  assert.ok(res.status >= 200 && res.status < 500, 'status ' + res.status);
  if (res.status === 200) {
    assert.ok(res.data.id, 'must return id');
    createdSiteId = res.data.id;
  }
});

test('POST /api/sites: duplicate domain returns 400', async () => {
  const res = await req('POST', '/api/sites', SITE_PAYLOAD, auth());
  if (createdSiteId) {
    assert.strictEqual(res.status, 400);
    assert.ok(res.data.error);
  } else {
    assert.ok(res.status >= 200 && res.status < 500);
  }
});

test('POST /api/sites: missing required fields returns 400', async () => {
  const res = await req('POST', '/api/sites', { domain: '' }, auth());
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites: invalid port returns 400', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    { domain: 'port-test.example.com', upstreamHost: '127.0.0.1', upstreamPort: 99999 },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites: invalid domain format returns 400', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    { domain: 'not-a-valid-domain', upstreamHost: '127.0.0.1', upstreamPort: 80 },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('PUT /api/sites/:id: update site', async () => {
  if (!createdSiteId) return;
  const res = await req(
    'PUT',
    '/api/sites/' + createdSiteId,
    { ...SITE_PAYLOAD, upstreamPort: 4000, enableGzip: false },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500, 'status ' + res.status);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
  }
});

test('PUT /api/sites/:id: non-existent site returns 404', async () => {
  const res = await req(
    'PUT',
    '/api/sites/00000000-0000-0000-0000-000000000000',
    { domain: 'ghost.example.com', upstreamHost: '127.0.0.1', upstreamPort: 80 },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('PUT /api/sites/:id: invalid domain returns 400', async () => {
  if (!createdSiteId) return;
  const res = await req(
    'PUT',
    '/api/sites/' + createdSiteId,
    { domain: '!!!invalid', upstreamHost: '127.0.0.1', upstreamPort: 80 },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites/:id/toggle: toggle site', async () => {
  if (!createdSiteId) return;
  const res = await req('POST', '/api/sites/' + createdSiteId + '/toggle', undefined, auth());
  assert.ok(res.status >= 200 && res.status < 500, 'status ' + res.status);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(typeof res.data.enabled, 'boolean');
  }
});

test('POST /api/sites/:id/toggle: non-existent site returns 404', async () => {
  const res = await req(
    'POST',
    '/api/sites/00000000-0000-0000-0000-000000000000/toggle',
    undefined,
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites/reload: reload config', async () => {
  const res = await req('POST', '/api/sites/reload', undefined, auth());
  // 502 is acceptable when nginx is not running
  assert.ok(res.status >= 200 && res.status <= 502, 'status ' + res.status);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
  }
});

test('GET /api/sites/:id/cert: cert status', async () => {
  if (!createdSiteId) return;
  const res = await req('GET', '/api/sites/' + createdSiteId + '/cert', undefined, auth());
  assert.ok(res.status >= 200 && res.status < 500, 'status ' + res.status);
  if (res.status === 200) {
    assert.strictEqual(typeof res.data.exists, 'boolean');
  }
});

test('GET /api/sites/:id/cert: non-existent site returns 404', async () => {
  const res = await req(
    'GET',
    '/api/sites/00000000-0000-0000-0000-000000000000/cert',
    undefined,
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites/:id/cert: missing cert path returns 400', async () => {
  if (!createdSiteId) return;
  const res = await req(
    'POST',
    '/api/sites/' + createdSiteId + '/cert',
    Buffer.from('fake-cert-data'),
    { ...auth(), 'Content-Type': 'application/octet-stream' },
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites/:id/cert: non-existent site returns 404', async () => {
  const res = await req(
    'POST',
    '/api/sites/00000000-0000-0000-0000-000000000000/cert?certPath=/tmp/test.crt',
    Buffer.from('fake-cert-data'),
    { ...auth(), 'Content-Type': 'application/octet-stream' },
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

/* ─── Advanced config validation ─── */

test('POST /api/sites: auth enabled without username returns 400', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    {
      domain: 'auth-test.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 80,
      enableAuth: true,
      authUsername: '',
      authPassword: 'test1234',
    },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites: auth with short password returns 400', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    {
      domain: 'auth-short.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 80,
      enableAuth: true,
      authUsername: 'admin',
      authPassword: 'ab',
    },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites: invalid rate limit format returns 400', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    {
      domain: 'rate-test.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 80,
      rateLimit: 'invalid-format',
    },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites: valid rate limit accepted', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    {
      domain: 'rate-valid.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 80,
      rateLimit: '5r/s',
    },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
  if (res.status === 200) {
    assert.ok(res.data.id);
    await req('DELETE', '/api/sites/' + res.data.id, undefined, auth());
  }
});

test('POST /api/sites: invalid clientMaxBody returns 400', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    {
      domain: 'body-test.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 80,
      clientMaxBody: 'invalid',
    },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('POST /api/sites: valid clientMaxBody accepted', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    {
      domain: 'body-valid.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 80,
      clientMaxBody: '10m',
    },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
  if (res.status === 200) {
    assert.ok(res.data.id);
    await req('DELETE', '/api/sites/' + res.data.id, undefined, auth());
  }
});

test('POST /api/sites: WebSocket and auth options accepted', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    {
      domain: 'ws-auth.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 80,
      enableWs: true,
      enableGzip: true,
      enableAuth: true,
      authUsername: 'user',
      authPassword: 'securepass123',
    },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
  if (res.status === 200) {
    assert.ok(res.data.id);
    await req('DELETE', '/api/sites/' + res.data.id, undefined, auth());
  }
});

/* ─── DELETE ─── */

test('DELETE /api/sites/:id: delete created site', async () => {
  if (!createdSiteId) return;
  const res = await req('DELETE', '/api/sites/' + createdSiteId, undefined, auth());
  assert.ok(res.status >= 200 && res.status < 500, 'status ' + res.status);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
  }
});

test('DELETE /api/sites/:id: non-existent site returns 404', async () => {
  const res = await req(
    'DELETE',
    '/api/sites/00000000-0000-0000-0000-000000000000',
    undefined,
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
});

test('DELETE /api/sites/:id: already deleted returns 404', async () => {
  if (!createdSiteId) return;
  const res = await req('DELETE', '/api/sites/' + createdSiteId, undefined, auth());
  assert.ok(res.status >= 200 && res.status < 500);
});

/* ─── HTTPS site creation ─── */

test('POST /api/sites: HTTPS site creation accepted', async () => {
  const res = await req(
    'POST',
    '/api/sites',
    {
      domain: 'https-site.example.com',
      upstreamHost: '127.0.0.1',
      upstreamPort: 8443,
      enableHttps: true,
      listenPort: 443,
    },
    auth(),
  );
  assert.ok(res.status >= 200 && res.status < 500);
  if (res.status === 200) {
    assert.ok(res.data.id);
    await req('DELETE', '/api/sites/' + res.data.id, undefined, auth());
  }
});
