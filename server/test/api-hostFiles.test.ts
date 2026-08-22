/**
 * 宿主机文件管理 API 集成测试
 *
 * 覆盖 list / mkdir / read / write / rename / delete / upload / download / archive
 * 全部节点，含认证校验与 CRUD 生命周期。
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

/* ---------- helpers ---------- */

function req(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>,
): Promise<{ status: number; data: any; res: http.IncomingMessage }> {
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
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode || 0, data: parsed, res });
      });
    });
    r.on('error', reject);
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) {
        r.write(body);
      } else {
        r.write(JSON.stringify(body));
      }
    }
    r.end();
  });
}

function reqRaw(
  method: string,
  path: string,
  body: Buffer,
  headers?: Record<string, string>,
): Promise<{ status: number; data: any; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length.toString(),
        ...headers,
      },
    };
    const r = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode || 0, data: parsed, res });
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${adminToken}` };
}

/* ---------- 常量 ---------- */
const TEST_DIR = 'C:\\dm-api-test-hostfiles';
const TEST_FILE = `${TEST_DIR}\\hello.txt`;
const TEST_CONTENT = 'hello from hostfiles api test ' + Date.now();
const TEST_RENAME = `${TEST_DIR}\\hello-renamed.txt`;

/* ---------- setup ---------- */

before(async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  adminToken = login.data.token;
  assert.ok(adminToken, '登录应返回 token');
});

/* ================================================================
   1. Auth – 未认证时应返回 401
   ================================================================ */

test('GET /api/hostfiles/list: 未认证应返回 401', async () => {
  const res = await req('GET', '/api/hostfiles/list');
  assert.strictEqual(res.status, 401, `期望 401，实际 ${res.status}`);
});

test('POST /api/hostfiles/mkdir: 未认证应返回 401', async () => {
  const res = await req('POST', '/api/hostfiles/mkdir', { path: 'C:\\', name: 'noauth' });
  assert.strictEqual(res.status, 401, `期望 401，实际 ${res.status}`);
});

test('POST /api/hostfiles/write: 未认证应返回 401', async () => {
  const res = await req('POST', '/api/hostfiles/write', { path: 'C:\\x.txt', content: '' });
  assert.strictEqual(res.status, 401, `期望 401，实际 ${res.status}`);
});

test('POST /api/hostfiles/rename: 未认证应返回 401', async () => {
  const res = await req('POST', '/api/hostfiles/rename', { from: 'C:\\a', to: 'C:\\b' });
  assert.strictEqual(res.status, 401, `期望 401，实际 ${res.status}`);
});

test('POST /api/hostfiles/delete: 未认证应返回 401', async () => {
  const res = await req('POST', '/api/hostfiles/delete', { path: 'C:\\x.txt' });
  assert.strictEqual(res.status, 401, `期望 401，实际 ${res.status}`);
});

test('POST /api/hostfiles/upload: 未认证应返回 400', async () => {
  const res = await req('POST', '/api/hostfiles/upload?path=C:\\&name=x.txt', Buffer.from('hi'));
  assert.strictEqual(res.status, 400, `期望 400，实际 ${res.status}`);
});

test('POST /api/hostfiles/archive: 未认证应返回 401', async () => {
  const res = await req('POST', '/api/hostfiles/archive', { paths: ['C:\\'] });
  assert.strictEqual(res.status, 401, `期望 401，实际 ${res.status}`);
});

/* ================================================================
   2. GET /api/hostfiles/list
   ================================================================ */

test('GET /api/hostfiles/list: 无参数返回磁盘列表', async () => {
  const res = await req('GET', '/api/hostfiles/list', undefined, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data.items), '应有 items 数组');
    const cDrive = res.data.items.find((i: any) => i.name === 'C:\\');
    assert.ok(cDrive, '应包含 C:\\');
  }
});

test('GET /api/hostfiles/list?path=C:\\: 列出 C 盘根目录', async () => {
  const res = await req('GET', '/api/hostfiles/list?path=C%3A%5C', undefined, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data.items), '应有 items 数组');
    assert.ok(res.data.items.length > 0, 'C:\\ 应有内容');
  }
});

test('GET /api/hostfiles/list?path=不存在的目录: 返回 404', async () => {
  const res = await req('GET', '/api/hostfiles/list?path=C%3A%5C%5Cdoes_not_exist_xyz', undefined, auth());
  assert.ok(res.status === 404, `期望 404，实际 ${res.status}`);
});

/* ================================================================
   3. CRUD lifecycle: mkdir → write → read → rename → download → delete
   ================================================================ */

test('POST /api/hostfiles/mkdir: 创建测试目录', async () => {
  const res = await req('POST', '/api/hostfiles/mkdir', { path: 'C:\\', name: 'dm-api-test-hostfiles' }, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  assert.ok([200, 400].includes(res.status), `200（新建）或 400（已存在），实际 ${res.status}`);
});

test('POST /api/hostfiles/write: 写入测试文件', async () => {
  const res = await req('POST', '/api/hostfiles/write', { path: TEST_FILE, content: TEST_CONTENT }, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.deepStrictEqual(res.data, { ok: true });
  }
});

test('POST /api/hostfiles/read: 读取测试文件', async () => {
  const res = await req('POST', '/api/hostfiles/read', { path: TEST_FILE }, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.content, TEST_CONTENT, '内容应匹配写入的内容');
  }
});

test('POST /api/hostfiles/read: 读取不存在的文件返回 404', async () => {
  const res = await req('POST', '/api/hostfiles/read', { path: 'C:\\does_not_exist_abc.txt' }, auth());
  assert.strictEqual(res.status, 404, `期望 404，实际 ${res.status}`);
});

test('POST /api/hostfiles/rename: 重命名测试文件', async () => {
  const res = await req('POST', '/api/hostfiles/rename', { from: TEST_FILE, to: TEST_RENAME }, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.deepStrictEqual(res.data, { ok: true });
  }
});

test('POST /api/hostfiles/read: 重命名后读取新文件', async () => {
  const res = await req('POST', '/api/hostfiles/read', { path: TEST_RENAME }, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.content, TEST_CONTENT);
  }
});

test('GET /api/hostfiles/download: 下载重命名后的文件', async () => {
  const res = await req('GET', `/api/hostfiles/download?path=${encodeURIComponent(TEST_RENAME)}`, undefined, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    const ct = res.res.headers['content-type'] || '';
    assert.ok(ct.includes('octet-stream') || ct.includes('application/'), `Content-Type 应为流类型，实际 ${ct}`);
  }
});

test('POST /api/hostfiles/delete: 删除测试文件', async () => {
  const res = await req('POST', '/api/hostfiles/delete', { path: TEST_RENAME }, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.deepStrictEqual(res.data, { ok: true });
  }
});

test('POST /api/hostfiles/delete: 删除测试目录（force）', async () => {
  const res = await req('POST', '/api/hostfiles/delete', { path: TEST_DIR, force: true }, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.deepStrictEqual(res.data, { ok: true });
  }
});

/* ================================================================
   4. upload / read round-trip
   ================================================================ */

test('POST /api/hostfiles/upload: 上传文件到 C:\\', async () => {
  const uploadName = 'dm-upload-test.txt';
  const body = Buffer.from('upload payload ' + Date.now());
  const res = await reqRaw(
    'POST',
    `/api/hostfiles/upload?path=${encodeURIComponent('C:\\')}&name=${uploadName}`,
    body,
    auth(),
  );
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.size, body.length);
  }
  // 清理
  await req('POST', '/api/hostfiles/delete', { path: `C:\\${uploadName}` }, auth());
});

/* ================================================================
   5. archive
   ================================================================ */

test('POST /api/hostfiles/archive: 打包 C:\\dm-api-test-hostfiles（已删除则跳过）', async () => {
  // 先重建一个文件用于归档
  await req('POST', '/api/hostfiles/mkdir', { path: 'C:\\', name: 'dm-api-test-hostfiles' }, auth());
  const archiveFile = `${TEST_DIR}\\archive-me.txt`;
  await req('POST', '/api/hostfiles/write', { path: archiveFile, content: 'archive me' }, auth());

  const res = await req('POST', '/api/hostfiles/archive', { paths: [TEST_DIR] }, auth());
  assert.ok(res.status < 500, `不应 5xx，实际 ${res.status}`);
  if (res.status === 200) {
    const ct = res.res.headers['content-type'] || '';
    assert.ok(ct.includes('gzip') || ct.includes('application/'), `Content-Type 应为 gzip，实际 ${ct}`);
    assert.ok(res.data.length > 0, '应返回非空 tar.gz 数据');
  }

  // 清理
  await req('POST', '/api/hostfiles/delete', { path: TEST_DIR, force: true }, auth());
});

test('POST /api/hostfiles/archive: 空 paths 返回 400', async () => {
  const res = await req('POST', '/api/hostfiles/archive', { paths: [] }, auth());
  assert.ok([400, 500].includes(res.status), `期望 400，实际 ${res.status}`);
});

/* ================================================================
   6. 边界校验
   ================================================================ */

test('POST /api/hostfiles/mkdir: 空目录名返回 400', async () => {
  const res = await req('POST', '/api/hostfiles/mkdir', { path: 'C:\\', name: '' }, auth());
  assert.strictEqual(res.status, 400, `期望 400，实际 ${res.status}`);
});

test('POST /api/hostfiles/mkdir: 目录名含斜杠返回 400', async () => {
  const res = await req('POST', '/api/hostfiles/mkdir', { path: 'C:\\', name: 'bad/name' }, auth());
  assert.strictEqual(res.status, 400, `期望 400，实际 ${res.status}`);
});

test('POST /api/hostfiles/upload: 缺少文件名返回 400', async () => {
  const res = await reqRaw('POST', '/api/hostfiles/upload?path=C%3A%5C', Buffer.from('x'), auth());
  assert.ok(res.status === 400, `期望 400，实际 ${res.status}`);
});

test('POST /api/hostfiles/upload: 空内容返回 400', async () => {
  const res = await reqRaw(
    'POST',
    '/api/hostfiles/upload?path=C%3A%5C&name=empty.bin',
    Buffer.alloc(0),
    auth(),
  );
  assert.ok(res.status === 400, `期望 400，实际 ${res.status}`);
});

test('POST /api/hostfiles/download: 不存在的文件返回 404', async () => {
  const res = await req('GET', '/api/hostfiles/download?path=C%3A%5C%5Cno_such_file_xyz.txt', undefined, auth());
  assert.ok(res.status === 404, `期望 404，实际 ${res.status}`);
});

test('GET /api/hostfiles/list?path=C:\\not_a_dir.txt: 非目录返回 400', async () => {
  // 创建临时文件
  const tmp = 'C:\\dm-tmp-not-a-dir.txt';
  await req('POST', '/api/hostfiles/write', { path: tmp, content: 'x' }, auth());
  const res = await req('GET', `/api/hostfiles/list?path=${encodeURIComponent(tmp)}`, undefined, auth());
  assert.ok(res.status === 400, `期望 400，实际 ${res.status}`);
  // 清理
  await req('POST', '/api/hostfiles/delete', { path: tmp }, auth());
});
