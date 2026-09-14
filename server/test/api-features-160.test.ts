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

describe('1.60.0 应用商店导出/分享', () => {
  it('内置应用导出为 apps.json 兼容定义', async () => {
    const r = await req('GET', '/api/appstore/nginx/export');
    assert.equal(r.status, 200);
    assert.equal(r.data?.app?.id, 'nginx');
    assert.ok(r.data?.app?.name);
    assert.ok(r.data?.app?.image);
    assert.ok(r.data?.exportedAt);
    assert.equal(r.data?.params, null);
    // 不含内部装饰字段
    assert.ok(!('isCustom' in (r.data?.app || {})));
    assert.ok(!('sourceName' in (r.data?.app || {})));
  });

  it('已安装应用可附带安装参数导出', async () => {
    const r = await req('GET', '/api/appstore/nginx/export?params=1');
    assert.equal(r.status, 200);
    // 未安装时 params 为 null，已安装时为对象
    assert.ok(typeof r.data?.params === 'object' || r.data?.params === null);
  });

  it('不存在的应用返回 404', async () => {
    const r = await req('GET', '/api/appstore/no-such-app-xyz/export');
    assert.equal(r.status, 404);
  });

  it('导出定义满足应用源 apps.json 校验要求（id/name/image 或 compose）', async () => {
    const r = await req('GET', '/api/appstore/redis/export');
    assert.equal(r.status, 200);
    const app = r.data?.app || {};
    assert.ok(typeof app.id === 'string' && app.id.length > 0);
    assert.ok(typeof app.name === 'string' && app.name.length > 0);
    assert.ok(typeof app.image === 'string' || (app.compose && typeof app.compose === 'object'));
  });
});
