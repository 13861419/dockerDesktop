import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 9528;

let AUTH_TOKEN = '';

function req(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const r = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          let data: any;
          try {
            data = JSON.parse(buf);
          } catch {
            data = buf;
          }
          resolve({ status: res.statusCode!, data });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  AUTH_TOKEN = r.data?.token || '';
  assert.ok(AUTH_TOKEN, 'login should return a token');
});

describe('1.58.0 日志全文检索（FTS5）', () => {
  it('开启索引设置并触发一轮采集', async () => {
    const on = await req('PUT', '/api/settings', { 'logs.indexEnabled': true });
    assert.equal(on.status, 200);
    const sweep = await req('POST', '/api/logs/history/sweep', {});
    assert.equal(sweep.status, 200);
    assert.equal(sweep.data?.ok, true);
    assert.ok('scanned' in sweep.data);
  });

  it('历史检索结构完整（关键字 ≥3 字符走 FTS）', async () => {
    const r = await req('GET', '/api/logs/history?keyword=error&limit=100');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.lines));
    assert.equal(r.data?.fts, true);
    assert.ok(Array.isArray(r.data?.distribution));
    assert.ok(typeof r.data?.total === 'number');
  });

  it('短关键字回退 LIKE（fts=false）', async () => {
    const r = await req('GET', '/api/logs/history?keyword=ab&limit=100');
    assert.equal(r.status, 200);
    assert.equal(r.data?.fts, false);
    assert.ok(Array.isArray(r.data?.lines));
  });

  it('中文关键字（≥3 字符）FTS 查询不报错', async () => {
    const r = await req('GET', '/api/logs/history?keyword=' + encodeURIComponent('磁盘空间') + '&limit=50');
    assert.equal(r.status, 200);
    assert.equal(r.data?.fts, true);
    assert.ok(Array.isArray(r.data?.distribution));
  });

  it('2 字符关键字按设计回退 LIKE', async () => {
    const r = await req('GET', '/api/logs/history?keyword=' + encodeURIComponent('磁盘') + '&limit=50');
    assert.equal(r.status, 200);
    assert.equal(r.data?.fts, false);
  });

  it('恢复索引开关原状', async () => {
    const off = await req('PUT', '/api/settings', { 'logs.indexEnabled': false });
    assert.equal(off.status, 200);
  });
});
