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

describe('1.54.0 compose 环境变量 .env', () => {
  const projName = 'dm-env-test';

  it('.env 不存在时返回空，保存后可读回', async () => {
    // 创建项目
    const yaml = 'services:\n  test:\n    image: busybox:latest\n    command: sleep 1\n';
    const created = await req('POST', '/api/compose', { name: projName, content: yaml });
    assert.equal(created.status, 201);
    // 初始无 .env
    const before = await req('GET', `/api/compose/${projName}/env`);
    assert.equal(before.status, 200);
    assert.equal(before.data?.exists, false);
    // 保存
    const save = await req('POST', `/api/compose/${projName}/env`, { content: 'FOO=bar\n' });
    assert.equal(save.status, 200);
    assert.equal(save.data?.ok, true);
    // 读回
    const after = await req('GET', `/api/compose/${projName}/env`);
    assert.equal(after.status, 200);
    assert.equal(after.data?.exists, true);
    assert.equal(after.data?.content, 'FOO=bar\n');
    // 清理
    await req('DELETE', `/api/compose/${projName}`);
  });

  it('缺少 content 参数返回 400', async () => {
    // 项目先确保存在
    await req('POST', '/api/compose', { name: projName, content: 'services:\n  test:\n    image: busybox:latest\n' });
    const r = await req('POST', `/api/compose/${projName}/env`, {});
    assert.equal(r.status, 400);
    await req('DELETE', `/api/compose/${projName}`);
  });
});
