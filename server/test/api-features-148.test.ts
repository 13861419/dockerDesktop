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

describe('1.48.0 新功能契约', () => {
  it('备份覆盖率体检返回 items 与 summary', async () => {
    const r = await req('GET', '/api/backups/coverage');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.items), 'items should be an array');
    const s = r.data?.summary;
    assert.ok(s && typeof s.total === 'number', 'summary.total should exist');
    assert.ok(typeof s.covered === 'number');
    assert.ok(typeof s.none === 'number');
    assert.equal(r.data?.staleDays, 7);
  });

  it('查询历史列表返回 items 数组', async () => {
    const r = await req('GET', '/api/databases/query-history');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.items));
  });

  it('查询历史收藏接口返回收藏视图', async () => {
    const r = await req('GET', '/api/databases/query-history?favorites=1');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.items));
  });

  it('收藏不存在的查询历史返回 404', async () => {
    const r = await req('POST', '/api/databases/query-history/999999999/favorite', {});
    assert.equal(r.status, 404);
  });

  it('删除不存在的查询历史返回 404', async () => {
    const r = await req('DELETE', '/api/databases/query-history/999999999');
    assert.equal(r.status, 404);
  });

  it('网络诊断缺少目标容器返回 400', async () => {
    const r = await req('POST', '/api/containers/some-id/net-test', {});
    assert.equal(r.status, 400);
    assert.ok(String(r.data?.error || '').includes('targetId'));
  });

  it('网络诊断缺少端口返回 400', async () => {
    const r = await req('POST', '/api/containers/some-id/net-test', { targetId: 'other' });
    assert.equal(r.status, 400);
    assert.ok(String(r.data?.error || '').includes('port'));
  });

  it('容器文件变更接口对存在容器返回 items', async () => {
    const list = await req('GET', '/api/containers');
    assert.equal(list.status, 200);
    const first = Array.isArray(list.data) ? list.data[0] : null;
    if (!first?.Id) {
      // 环境中无容器时跳过（保持测试幂等）
      assert.ok(true);
      return;
    }
    const r = await req('GET', `/api/containers/${encodeURIComponent(first.Id)}/diff`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.items));
  });

  it('网络诊断对不存在容器返回 400', async () => {
    const r = await req('POST', '/api/containers/definitely-nonexistent/net-test', {
      targetId: 'also-nonexistent',
      port: 80,
    });
    assert.equal(r.status, 400);
  });
});
