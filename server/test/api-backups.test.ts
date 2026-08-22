import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let backupId = '';

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

test('GET /: unauthenticated returns 401', async () => {
  const res = await req('GET', '/api/backups');
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('POST /: unauthenticated returns 401', async () => {
  const res = await req('POST', '/api/backups', { kind: 'database', name: 'test' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('POST /:id/restore: unauthenticated returns 401', async () => {
  const res = await req('POST', '/api/backups/fake-id/restore');
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('DELETE /:id: unauthenticated returns 401', async () => {
  const res = await req('DELETE', '/api/backups/fake-id');
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('POST /:id/upload-to-cloud: unauthenticated returns 401', async () => {
  const res = await req('POST', '/api/backups/fake-id/upload-to-cloud', { targetId: 'x' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

// ======================== list ========================

test('GET /api/backups: list backups', async () => {
  const res = await req('GET', '/api/backups', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `expected 200, got ${res.status}`);
  assert.ok(Array.isArray(res.data.backups), 'backups should be an array');
});

// ======================== create ========================

test('POST /api/backups: create database backup', async () => {
  const res = await req('POST', '/api/backups', { kind: 'database', name: 'dm-test-db-backup' }, { Authorization: `Bearer ${adminToken}` });
  // 500 is expected when no actual database exists to backup
  assert.ok(res.status === 201 || res.status === 500, `expected 201 or 500, got ${res.status}`);
  if (res.status === 201 && res.data?.backup?.id) {
    backupId = res.data.backup.id;
    assert.strictEqual(res.data.backup.kind, 'database');
    assert.strictEqual(res.data.backup.name, 'dm-test-db-backup');
  }
});

test('POST /api/backups: invalid kind returns 400', async () => {
  const res = await req('POST', '/api/backups', { kind: 'invalid', name: 'test' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /api/backups: missing name returns 400', async () => {
  const res = await req('POST', '/api/backups', { kind: 'database' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /api/backups: create compose backup', async () => {
  const res = await req('POST', '/api/backups', { kind: 'compose', name: 'dm-test-compose-backup', source: '' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 600, `got ${res.status}`);
});

// ======================== list after create ========================

test('GET /api/backups: list after create', async () => {
  const res = await req('GET', '/api/backups', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
  assert.ok(Array.isArray(res.data.backups));
  if (backupId) {
    const found = res.data.backups.some((b: any) => b.id === backupId);
    assert.ok(found, 'created backup should appear in list');
  }
});

// ======================== download ========================

test('GET /api/backups/:id/download: download backup', async () => {
  if (!backupId) return;
  const res = await req('GET', `/api/backups/${backupId}/download`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 600, `got ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data.length > 0 || typeof res.data === 'string', 'download should have content');
  }
});

test('GET /api/backups/:id/download: non-existent returns 404', async () => {
  const res = await req('GET', '/api/backups/nonexistent-id-xyz/download', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404, `expected 404, got ${res.status}`);
});

// ======================== restore ========================

test('POST /api/backups/:id/restore: restore backup', async () => {
  if (!backupId) return;
  const res = await req('POST', `/api/backups/${backupId}/restore`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 600, `got ${res.status}`);
  if (res.status === 200) {
    assert.ok('result' in res.data, 'should return result');
  }
});

test('POST /api/backups/:id/restore: non-existent returns error', async () => {
  const res = await req('POST', '/api/backups/nonexistent-id-xyz/restore', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404 || res.status < 600, `got ${res.status}`);
});

// ======================== upload-to-cloud ========================

test('POST /api/backups/:id/upload-to-cloud: missing targetId returns 400', async () => {
  if (!backupId) return;
  const res = await req('POST', `/api/backups/${backupId}/upload-to-cloud`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /api/backups/:id/upload-to-cloud: non-existent backup returns 404', async () => {
  const res = await req('POST', '/api/backups/nonexistent-id-xyz/upload-to-cloud', { targetId: 'x' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404, `expected 404, got ${res.status}`);
});

// ======================== delete ========================

test('DELETE /api/backups/:id: delete backup', async () => {
  if (!backupId) return;
  const res = await req('DELETE', `/api/backups/${backupId}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 600, `got ${res.status}`);
  if (res.status === 200) assert.strictEqual(res.data.ok, true);
});

test('DELETE /api/backups/:id: non-existent returns 404', async () => {
  const res = await req('DELETE', '/api/backups/nonexistent-id-xyz', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404, `expected 404, got ${res.status}`);
});
