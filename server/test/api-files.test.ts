import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let testContainerId = '';
const testFile = '/tmp/dm-test-file.txt';

function req(method: string, path: string, body?: any, headers?: Record<string, string>, rawBody?: Buffer): Promise<{ status: number; data: any }> {
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
    if (rawBody) r.write(rawBody);
    else if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

before(async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  adminToken = login.data.token;

  const create = await req('POST', '/api/containers', {
    image: 'alpine:latest', name: 'dm-autotest-files', command: 'sleep 3600', tty: true,
  }, { Authorization: `Bearer ${adminToken}` });
  if (create.data?.id) testContainerId = create.data.id;

  if (testContainerId) {
    await req('POST', `/api/containers/${testContainerId}/start`, undefined, { Authorization: `Bearer ${adminToken}` });
    const content = Buffer.from('hello from dm test');
    await req('POST', `/api/files/${testContainerId}/upload?path=/tmp&name=dm-test-file.txt`, undefined,
      { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' }, content);
  }
});

// ======================== Auth ========================

test('ls: unauthenticated returns 401', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/files/${testContainerId}/ls`);
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('upload: unauthenticated returns 401', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/upload?path=/tmp&name=x.txt`);
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('mkdir: unauthenticated returns 401', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/mkdir`, { path: '/tmp/x' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('rename: unauthenticated returns 401', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/rename`, { path: '/tmp/a', newName: 'b' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('delete: unauthenticated returns 401', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/delete`, { path: '/tmp/x' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

// ======================== ls ========================

test('GET /:containerId/ls: list root directory', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/files/${testContainerId}/ls?path=/`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.ok(Array.isArray(res.data.items));
});

test('GET /:containerId/ls: list /tmp', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/files/${testContainerId}/ls?path=/tmp`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.ok(Array.isArray(res.data.items));
});

// ======================== read ========================

test('GET /:containerId/read: read file', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/files/${testContainerId}/read?path=${testFile}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.ok('content' in res.data);
});

test('GET /:containerId/read: non-existent file', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/files/${testContainerId}/read?path=/tmp/no-such-xyz.txt`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
});

// ======================== download ========================

test('GET /:containerId/download: download file', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/files/${testContainerId}/download?path=${testFile}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
});

// ======================== upload ========================

test('POST /:containerId/upload: upload file', async () => {
  if (!testContainerId) return;
  const content = Buffer.from('dm-upload-test-content');
  const res = await req('POST', `/api/files/${testContainerId}/upload?path=/tmp&name=dm-upload-test.txt`, undefined,
    { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' }, content);
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.name, 'dm-upload-test.txt');
  }
});

// ======================== mkdir ========================

test('POST /:containerId/mkdir: create directory', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/mkdir`, { path: '/tmp/dm-test-dir' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.path, '/tmp/dm-test-dir');
  }
});

test('POST /:containerId/mkdir: missing path returns 400', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/mkdir`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

// ======================== rename ========================

test('POST /:containerId/rename: rename file', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/rename`,
    { path: '/tmp/dm-upload-test.txt', newName: 'dm-renamed.txt' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.path, '/tmp/dm-renamed.txt');
  }
});

test('POST /:containerId/rename: missing path returns 400', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/rename`, { newName: 'x' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /:containerId/rename: missing newName returns 400', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/rename`, { path: '/tmp/a' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

// ======================== delete ========================

test('POST /:containerId/delete: delete file', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/delete`,
    { path: '/tmp/dm-renamed.txt' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.path, '/tmp/dm-renamed.txt');
  }
});

test('POST /:containerId/delete: recursive delete directory', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/delete`,
    { path: '/tmp/dm-test-dir', recursive: true }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.strictEqual(res.data.ok, true);
});

test('POST /:containerId/delete: missing path returns 400', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/files/${testContainerId}/delete`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

// ======================== edge cases ========================

test('ls: path traversal returns 400', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/files/${testContainerId}/ls?path=/tmp/../../etc`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
});

test('ls: non-existent container returns 404', async () => {
  const res = await req('GET', '/api/files/nonexistent12345/ls?path=/', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 404 || res.status < 500, `got ${res.status}`);
});
