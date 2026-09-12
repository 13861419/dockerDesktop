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

describe('1.56.0 ACME SSL 证书', () => {
  it('GET /api/certs 返回证书数组', async () => {
    const r = await req('GET', '/api/certs');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.certs));
  });

  it('GET /api/certs/status 返回挑战服务状态与 ACME 目录', async () => {
    const r = await req('GET', '/api/certs/status');
    assert.equal(r.status, 200);
    assert.ok(r.data?.challengeServer);
    assert.ok(typeof r.data.challengeServer.port === 'number');
    assert.ok(String(r.data?.directoryUrl || '').startsWith('https://'));
  });

  it('签发参数校验：空域名 / 非法域名返回 400', async () => {
    const empty = await req('POST', '/api/certs/issue', { domains: '' });
    assert.equal(empty.status, 400);
    const bad = await req('POST', '/api/certs/issue', { domains: 'bad!!domain.com' });
    assert.equal(bad.status, 400);
    const wildcard = await req('POST', '/api/certs/issue', { domains: '*.example.com' });
    assert.equal(wildcard.status, 400);
  });

  it('删除不存在的证书返回 404', async () => {
    const r = await req('DELETE', '/api/certs/no-such-cert');
    assert.equal(r.status, 404);
  });
});
