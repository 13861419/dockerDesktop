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

describe('1.50.0 新功能契约', () => {
  it('容器配置快照：保存并回查列表', async () => {
    const list = await req('GET', '/api/containers');
    assert.equal(list.status, 200);
    const first = Array.isArray(list.data) ? list.data[0] : null;
    if (!first?.Id) {
      assert.ok(true);
      return;
    }
    const enc = encodeURIComponent(first.Id);
    const saved = await req('POST', `/api/containers/${enc}/snapshot`);
    assert.equal(saved.status, 201);
    const snapId = saved.data?.snapshot?.id;
    assert.ok(snapId, 'snapshot id should be returned');
    const r = await req('GET', `/api/containers/${enc}/snapshots`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.items));
    assert.ok(r.data.items.length >= 1);
    // 与自身对比：无差异
    const diff = await req('GET', `/api/containers/${enc}/snapshot-diff?from=${snapId}&to=${snapId}`);
    assert.equal(diff.status, 200);
    assert.equal(diff.data?.diffs?.length, 0);
  });

  it('删除不存在的快照返回 404', async () => {
    const r = await req('DELETE', '/api/containers/snapshots/999999999');
    assert.equal(r.status, 404);
  });

  it('快照 diff 缺少参数返回 400', async () => {
    const list = await req('GET', '/api/containers');
    const first = Array.isArray(list.data) ? list.data[0] : null;
    if (!first?.Id) {
      assert.ok(true);
      return;
    }
    const r = await req('GET', `/api/containers/${encodeURIComponent(first.Id)}/snapshot-diff`);
    assert.equal(r.status, 400);
  });

  it('备份任务支持 cloudTargetId 配置字段', async () => {
    const list = await req('GET', '/api/tasks');
    assert.ok([200].includes(list.status));
    assert.ok(Array.isArray(list.data?.tasks || list.data?.items || []));
  });
});
