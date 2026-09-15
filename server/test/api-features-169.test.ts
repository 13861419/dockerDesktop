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

describe('1.69.0 面板一键更新', () => {
  it('update/status 返回当前版本与安装类型（开发环境为 manual，不支持一键更新）', async () => {
    const r = await req('GET', '/api/system/update/status');
    assert.strictEqual(r.status, 200);
    assert.match(r.data.current, /^\d+\.\d+\.\d+$/);
    assert.ok(['windows-service', 'deb', 'rpm', 'docker', 'manual'].includes(r.data.installType));
    assert.strictEqual(typeof r.data.autoUpdate, 'boolean');
    assert.ok(r.data.installLabel.length > 0);
  });

  it('update/apply 在手动安装下拒绝执行并给出指引', async () => {
    const s = await req('GET', '/api/system/update/status');
    if (s.data.autoUpdate) return; // 服务版环境下跳过拒绝路径
    const r = await req('POST', '/api/system/update/apply');
    assert.strictEqual(r.status, 400);
    assert.ok(String(r.data.error).length > 0);
  });
});
