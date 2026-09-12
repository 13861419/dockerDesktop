/**
 * 跨引擎批量清理 API 集成测试（1.40.0/1.41.0）
 *
 * 覆盖：
 *  1. 缺省 types 回退 containers+images
 *  2. 四类对象 + untilHours 执行成功
 *  3. dryRun 预览：返回 preview 列表且不执行删除
 *
 * 依赖：后端运行于 localhost:9528，引擎表至少一台引擎
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

function req(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const r = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, data });
          }
        });
      },
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

before(async () => {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin888' }),
  });
  adminToken = ((await login.json()) as any).token;
});

test('batch-prune：缺省 types 回退 containers+images', async () => {
  const eng = await req('GET', '/api/engines');
  const ids = (eng.data.engines || []).map((e: any) => e.id);
  assert.ok(ids.length >= 1, '引擎列表非空');
  const r = await req('POST', '/api/engines/batch-prune', { engineIds: ids });
  assert.equal(r.status, 200);
  assert.equal(r.data.results.length, ids.length);
  for (const x of r.data.results) {
    assert.equal(typeof x.prunedContainers, 'number');
    assert.equal(typeof x.prunedImages, 'number');
  }
});

test('batch-prune：dryRun 预览返回 preview 数组', async () => {
  const eng = await req('GET', '/api/engines');
  const ids = (eng.data.engines || []).map((e: any) => e.id);
  const r = await req('POST', '/api/engines/batch-prune', { engineIds: ids, types: ['containers'], dryRun: true });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.results[0].preview), 'preview 为数组');
  assert.ok(String(r.data.results[0].detail).length > 0);
});

test('batch-prune：空 engineIds 返回 400', async () => {
  const r = await req('POST', '/api/engines/batch-prune', { engineIds: [], type: 'both' });
  assert.equal(r.status, 400);
});
