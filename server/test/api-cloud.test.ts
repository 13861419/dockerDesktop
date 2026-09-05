import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let targetId = '';

function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts: http.RequestOptions = {
      method, hostname: url.hostname, port: url.port,
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

before(async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  adminToken = login.data.token;
});

// ======================== Auth ========================

test('GET /targets: unauthenticated returns 401', async () => {
  const res = await req('GET', '/api/cloud/targets');
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('POST /targets: unauthenticated returns 401', async () => {
  const res = await req('POST', '/api/cloud/targets', { name: 'test' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('PUT /targets/:id: unauthenticated returns 401', async () => {
  const res = await req('PUT', '/api/cloud/targets/fake-id', { name: 'test' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('DELETE /targets/:id: unauthenticated returns 401', async () => {
  const res = await req('DELETE', '/api/cloud/targets/fake-id');
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('POST /targets/:id/test: unauthenticated returns 401', async () => {
  const res = await req('POST', '/api/cloud/targets/fake-id/test');
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('POST /upload: unauthenticated returns 401', async () => {
  const res = await req('POST', '/api/cloud/upload?id=x&filename=a.txt');
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

// ======================== list targets ========================

test('GET /api/cloud/targets: list cloud targets', async () => {
  const res = await req('GET', '/api/cloud/targets', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `expected 200, got ${res.status}`);
  assert.ok(Array.isArray(res.data.targets), 'targets should be an array');
});

// ======================== create target ========================

test('POST /api/cloud/targets: create webdav target', async () => {
  const res = await req('POST', '/api/cloud/targets', {
    name: 'dm-test-webdav',
    type: 'webdav',
    endpoint: 'https://example.com/dav',
    bucket: '',
    path: 'backups',
    accessKey: 'testuser',
    secret: 'testpass',
    region: '',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200 && res.data?.id) {
    targetId = res.data.id;
    assert.strictEqual(res.data.ok, true);
  }
});

test('POST /api/cloud/targets: missing name returns 400', async () => {
  const res = await req('POST', '/api/cloud/targets', {
    type: 'webdav', endpoint: 'https://example.com', bucket: '', path: '',
    accessKey: '', secret: '', region: '',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /api/cloud/targets: missing endpoint returns 400', async () => {
  const res = await req('POST', '/api/cloud/targets', {
    name: 'x', type: 'webdav', endpoint: '', bucket: '', path: '',
    accessKey: '', secret: '', region: '',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

// ======================== list after create ========================

test('GET /api/cloud/targets: list after create', { retry: 2 }, async () => {
  const res = await req('GET', '/api/cloud/targets', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
  if (targetId) {
    const found = res.data.targets.some((t: any) => t.id === targetId);
    assert.ok(found, 'created target should appear in list');
    const t = res.data.targets.find((x: any) => x.id === targetId);
    assert.strictEqual(t.type, 'webdav');
    assert.ok(t.hasSecret !== undefined || t.secret !== undefined, 'secret or hasSecret should be present');
  }
});

// ======================== update target ========================

test('PUT /api/cloud/targets/:id: update target', async () => {
  if (!targetId) return;
  const res = await req('PUT', `/api/cloud/targets/${targetId}`, {
    name: 'dm-test-webdav-updated',
    type: 'webdav',
    endpoint: 'https://example.com/dav2',
    bucket: '',
    path: 'backups-v2',
    accessKey: 'testuser2',
    secret: '',
    region: '',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.strictEqual(res.data.ok, true);
});

test('PUT /api/cloud/targets/:id: non-existent returns 404', async () => {
  const res = await req('PUT', '/api/cloud/targets/nonexistent-id', {
    name: 'x', type: 'webdav', endpoint: 'https://x.com', bucket: '', path: '',
    accessKey: '', secret: '', region: '',
  }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404, `expected 404, got ${res.status}`);
});

// ======================== test connectivity ========================

test('POST /api/cloud/targets/:id/test: test connectivity', async () => {
  if (!targetId) return;
  const res = await req('POST', `/api/cloud/targets/${targetId}/test`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) {
    assert.ok('ok' in res.data, 'should return ok field');
  }
});

test('POST /api/cloud/targets/:id/test: non-existent returns error', async () => {
  const res = await req('POST', '/api/cloud/targets/nonexistent-id/test', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
});

// ======================== upload ========================

test('POST /api/cloud/upload: missing id returns 400', async () => {
  const res = await req('POST', '/api/cloud/upload?filename=test.txt', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /api/cloud/upload: missing filename returns 400', async () => {
  const res = await req('POST', '/api/cloud/upload?id=x', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /api/cloud/upload: empty body returns 400', async () => {
  const res = await req('POST', `/api/cloud/upload?id=x&filename=test.txt`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

// ======================== delete target ========================

test('DELETE /api/cloud/targets/:id: delete target', async () => {
  if (!targetId) return;
  const res = await req('DELETE', `/api/cloud/targets/${targetId}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.strictEqual(res.data.ok, true);
});

test('DELETE /api/cloud/targets/:id: non-existent returns 404', async () => {
  const res = await req('DELETE', '/api/cloud/targets/nonexistent-id', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404, `expected 404, got ${res.status}`);
});

// ======================== verify deletion ========================

test('GET /api/cloud/targets: verify deleted target gone', async () => {
  if (!targetId) return;
  const res = await req('GET', '/api/cloud/targets', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
  const found = res.data.targets.some((t: any) => t.id === targetId);
  assert.ok(!found, 'deleted target should not appear');
});
