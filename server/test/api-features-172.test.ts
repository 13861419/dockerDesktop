/**
 * 1.72.0 应用「保留数据升级」API 契约测试
 *
 * 覆盖：
 *  1. 升级不存在的应用 → 404
 *  2. 升级非 Compose 套件应用 → 400
 */
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

describe('1.72.0 应用保留数据升级', () => {
  it('升级不存在的应用 → 404', async () => {
    const r = await req('POST', '/api/appstore/no-such-app-172/upgrade', {});
    assert.strictEqual(r.status, 404);
  });

  it('升级非 Compose 套件应用 → 400', async () => {
    const list = await req('GET', '/api/appstore');
    assert.strictEqual(list.status, 200);
    const items = list.data?.items || list.data || [];
    const single = Array.isArray(items) ? items.find((x: any) => x && !x.compose && x.id) : null;
    if (!single) {
      return;
    }
    const r = await req('POST', `/api/appstore/${single.id}/upgrade`, {});
    assert.strictEqual(r.status, 400);
    assert.match(String(r.data.error), /Compose/);
  });
});
