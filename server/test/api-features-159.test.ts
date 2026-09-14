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

describe('1.59.0 DNS-01 通配符证书', () => {
  it('证书状态接口返回挑战服务与目录地址', async () => {
    const r = await req('GET', '/api/certs/status');
    assert.equal(r.status, 200);
    assert.ok(r.data?.challengeServer);
    assert.ok(typeof r.data?.directoryUrl === 'string');
  });

  it('通配符域名未配置 DNS 解析商时返回 400 并提示配置', async () => {
    // 确保解析商为 none
    await req('PUT', '/api/settings', { 'acme.dnsProvider': 'none', 'acme.dnsApiToken': '' });
    const r = await req('POST', '/api/certs/issue', { domains: ['*.example-invalid-wc.com'] });
    assert.equal(r.status, 400);
    assert.ok(String(r.data?.error || '').includes('DNS-01'));
  });

  it('通配符域名格式校验通过（sanitize 层）', async () => {
    // 带非法字符的域名仍 400（区别于通配符）
    const bad = await req('POST', '/api/certs/issue', { domains: ['*.exa mple.com'] });
    assert.equal(bad.status, 400);
    assert.ok(String(bad.data?.error || '').includes('非法域名'));
  });

  it('acme 设置项可见且可写', async () => {
    const list = await req('GET', '/api/settings');
    assert.equal(list.status, 200);
    const keys: string[] = (list.data?.items || []).map((s: any) => s.key || s);
    for (const k of ['acme.contactEmail', 'acme.directoryUrl', 'acme.dnsProvider', 'acme.dnsApiToken']) {
      assert.ok(keys.includes(k), `缺少设置项 ${k}`);
    }
    const put = await req('PUT', '/api/settings', { 'acme.dnsProvider': 'none', 'acme.contactEmail': '' });
    assert.equal(put.status, 200);
  });
});
