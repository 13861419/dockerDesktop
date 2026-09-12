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

describe('1.57.0 应用绑定域名（站点闭环）', () => {
  const domain = 'bind-app-test.example.com';

  it('为应用创建站点（绑定域名闭环的 API 契约）', async () => {
    // 清理可能的历史残留
    const list0 = await req('GET', '/api/sites');
    const old = (list0.data?.sites || []).find((s: any) => s.domain === domain);
    if (old) await req('DELETE', `/api/sites/${old.id}`);
    // 创建：HTTP 上游 127.0.0.1:34567
    const created = await req('POST', '/api/sites', {
      domain,
      upstreamHost: '127.0.0.1',
      upstreamPort: '34567',
      listenPort: '80',
      enableHttps: false,
      certPath: '',
    });
    assert.equal(created.status, 200);
    assert.equal(created.data?.ok, true);
    // 列表中可见且上游正确
    const list = await req('GET', '/api/sites');
    const site = (list.data?.sites || []).find((s: any) => s.domain === domain);
    assert.ok(site, 'site should exist');
    assert.equal(site.upstreamHost, '127.0.0.1');
    assert.equal(site.upstreamPort, 34567);
    // 重复创建被拒绝
    const dup = await req('POST', '/api/sites', {
      domain,
      upstreamHost: '127.0.0.1',
      upstreamPort: '34567',
      listenPort: '80',
    });
    assert.equal(dup.status, 400);
    // 清理
    const del = await req('DELETE', `/api/sites/${site.id}`);
    assert.equal(del.status, 200);
  });
});
