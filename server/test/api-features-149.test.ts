import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 9528;

let AUTH_TOKEN = '';

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
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

describe('1.49.0 新功能契约', () => {
  it('端口预检返回逐端口结果', async () => {
    const r = await req('POST', '/api/containers/port-check', { ports: [59999] });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.results));
    assert.equal(r.data.results[0]?.port, 59999);
    assert.equal(typeof r.data.results[0]?.busy, 'boolean');
  });

  it('端口预检缺少端口返回 400', async () => {
    const r = await req('POST', '/api/containers/port-check', {});
    assert.equal(r.status, 400);
  });

  it('重跑不存在的任务返回 404', async () => {
    const r = await req('POST', '/api/tasks/999999999/run');
    assert.equal(r.status, 404);
  });

  it('登录提醒与应急清理设置项已注册', async () => {
    const r = await req('GET', '/api/settings');
    assert.equal(r.status, 200);
    const items: any[] = Array.isArray(r.data) ? r.data : r.data?.items || [];
    const keys = items.map((i) => String(i?.key || ''));
    assert.ok(keys.includes('security.loginNotify'), 'security.loginNotify should be registered');
    assert.ok(keys.includes('alerts.diskAutoGc'), 'alerts.diskAutoGc should be registered');
    assert.ok(keys.includes('alerts.diskAutoGcKeep'), 'alerts.diskAutoGcKeep should be registered');
  });
});
