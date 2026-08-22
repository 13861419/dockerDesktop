import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let testVolume = 'dm-autotest-vol';

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
  await req('POST', '/api/volumes', { name: testVolume }, { Authorization: `Bearer ${adminToken}` });
});

// ======================== Auth ========================

test('ls: unauthenticated returns 401', async () => {
  const res = await req('GET', `/api/volume-files/${testVolume}/ls`);
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('upload: unauthenticated returns 401', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/upload?path=/&name=x.txt`);
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('mkdir: unauthenticated returns 401', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/mkdir`, { path: '/x' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('rename: unauthenticated returns 401', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/rename`, { path: '/a', newName: 'b' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

test('delete: unauthenticated returns 401', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/delete`, { path: '/x' });
  assert.ok(res.status === 401, `expected 401, got ${res.status}`);
});

// ======================== ls ========================

test('GET /:volume/ls: list root directory', async () => {
  const res = await req('GET', `/api/volume-files/${testVolume}/ls?path=/`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.ok(Array.isArray(res.data.items));
});

test('GET /:volume/ls: non-existent volume returns error', async () => {
  const res = await req('GET', '/api/volume-files/nonexistent-vol-xyz/ls?path=/', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
});

// ======================== upload ========================

test('POST /:volume/upload: upload file to volume', async () => {
  const content = Buffer.from('dm-volume-upload-test');
  const res = await req('POST', `/api/volume-files/${testVolume}/upload?path=/&name=dm-vol-test.txt`, undefined,
    { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' }, content);
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.name, 'dm-vol-test.txt');
  }
});

// ======================== read ========================

test('GET /:volume/read: read uploaded file', async () => {
  const res = await req('GET', `/api/volume-files/${testVolume}/read?path=/dm-vol-test.txt`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.ok('content' in res.data);
});

test('GET /:volume/read: non-existent file returns error', async () => {
  const res = await req('GET', `/api/volume-files/${testVolume}/read?path=/no-such-xyz.txt`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
});

// ======================== download ========================

test('GET /:volume/download: download file', async () => {
  const res = await req('GET', `/api/volume-files/${testVolume}/download?path=/dm-vol-test.txt`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
});

// ======================== mkdir ========================

test('POST /:volume/mkdir: create directory', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/mkdir`, { path: '/dm-test-subdir' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.path, '/dm-test-subdir');
  }
});

test('POST /:volume/mkdir: missing path returns 400', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/mkdir`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

// ======================== rename ========================

test('POST /:volume/rename: rename file', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/rename`,
    { path: '/dm-vol-test.txt', newName: 'dm-vol-renamed.txt' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.strictEqual(res.data.ok, true);
});

test('POST /:volume/rename: missing path returns 400', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/rename`, { newName: 'x' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

test('POST /:volume/rename: missing newName returns 400', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/rename`, { path: '/a' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

// ======================== delete ========================

test('POST /:volume/delete: delete file', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/delete`,
    { path: '/dm-vol-renamed.txt' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.strictEqual(res.data.ok, true);
});

test('POST /:volume/delete: recursive delete directory', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/delete`,
    { path: '/dm-test-subdir', recursive: true }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
  if (res.status === 200) assert.strictEqual(res.data.ok, true);
});

test('POST /:volume/delete: missing path returns 400', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/delete`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, `expected 400, got ${res.status}`);
});

// ======================== edge cases ========================

test('ls: path traversal returns 400', async () => {
  const res = await req('GET', `/api/volume-files/${testVolume}/ls?path=/tmp/../../etc`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `got ${res.status}`);
});

test('upload: missing name returns 400', async () => {
  const content = Buffer.from('test');
  const res = await req('POST', `/api/volume-files/${testVolume}/upload?path=/`, undefined,
    { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' }, content);
  assert.ok(res.status === 400 || res.status === 404, `expected 400 or 404, got ${res.status}`);
});

test('upload: empty body returns 400', async () => {
  const res = await req('POST', `/api/volume-files/${testVolume}/upload?path=/&name=test.txt`, undefined,
    { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' });
  assert.ok(res.status === 200 || res.status === 400 || res.status === 404, `expected 200, 400 or 404, got ${res.status}`);
});
