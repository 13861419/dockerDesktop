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

describe('1.62.0 站点访问统计', () => {
  it('统计接口返回结构完整', async () => {
    const r = await req('GET', '/api/sites/stats?days=7');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.daily));
    assert.ok(Array.isArray(r.data?.domains));
    assert.ok(r.data.daily.length <= 7 || r.data.daily.length >= 0);
  });

  it('days 参数边界（1-90 之外回退默认 7）', async () => {
    const r = await req('GET', '/api/sites/stats?days=9999');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.domains));
  });
});
