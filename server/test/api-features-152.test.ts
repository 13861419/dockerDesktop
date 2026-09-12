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

describe('1.52.0 compose 文件编辑历史', () => {
  const projName = 'dm-hist-test';

  it('保存两次后可查到上一版历史并读回内容', async () => {
    // 创建 v1
    const v1 = 'services:\n  test:\n    image: busybox:latest\n    command: sleep 1\n';
    const created = await req('POST', '/api/compose', { name: projName, content: v1 });
    assert.equal(created.status, 201);
    // 覆盖为 v2（历史里应记下 v1）
    const v2 = 'services:\n  test:\n    image: busybox:latest\n    command: sleep 2\n';
    const saved = await req('POST', '/api/compose', { name: projName, content: v2 });
    assert.equal(saved.status, 201);
    // 历史列表
    const list = await req('GET', `/api/compose/${projName}/history`);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.data?.items));
    assert.ok(list.data.items.length >= 1, 'should have at least one history entry');
    // 读回 v1 内容
    const first = list.data.items[0];
    const content = await req('GET', `/api/compose/${projName}/history/${first.id}/content`);
    assert.equal(content.status, 200);
    assert.ok(String(content.data?.content || '').includes('sleep 1'), 'history content should be the previous version');
    // 清理项目（面板项目：down + 删目录）
    await req('DELETE', `/api/compose/${projName}`);
  });

  it('不存在项目的历史返回 404', async () => {
    const r = await req('GET', '/api/compose/no-such-project-xyz/history');
    assert.equal(r.status, 404);
  });
});
