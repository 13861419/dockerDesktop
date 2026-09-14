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

let createdId = 0;

before(async () => {
  const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  AUTH_TOKEN = r.data?.token || '';
  assert.ok(AUTH_TOKEN, 'login should return a token');
});

describe('1.61.0 事件自动化规则', () => {
  it('新建规则（container.die → restart）', async () => {
    const r = await req('POST', '/api/automations', {
      name: 'api-test-crash-rule',
      eventType: 'container.die',
      matchContainer: 'no-such-container-xyz',
      action: 'restart',
      cooldownSec: 60,
    });
    assert.equal(r.status, 201);
    assert.ok(r.data?.rule?.id > 0);
    assert.equal(r.data.rule.enabled, true);
    assert.equal(r.data.rule.action, 'restart');
    createdId = r.data.rule.id;
  });

  it('webhook 规则缺 URL 时 400', async () => {
    const r = await req('POST', '/api/automations', { name: 'bad', eventType: 'container.die', action: 'webhook', actionParams: {} });
    assert.equal(r.status, 400);
    assert.ok(String(r.data?.error || '').includes('webhook'));
  });

  it('非法事件类型 400', async () => {
    const r = await req('POST', '/api/automations', { name: 'bad2', eventType: 'not valid!!', action: 'restart' });
    assert.equal(r.status, 400);
  });

  it('列表包含新规则（webhook secret 不外泄）', async () => {
    const r = await req('GET', '/api/automations');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.rules));
    const mine = r.data.rules.find((x: any) => x.id === createdId);
    assert.ok(mine, 'created rule should be listed');
  });

  it('更新与启停', async () => {
    const off = await req('PUT', `/api/automations/${createdId}/enabled`, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.data?.rule?.enabled, false);
    const on = await req('PUT', `/api/automations/${createdId}/enabled`, { enabled: true });
    assert.equal(on.data?.rule?.enabled, true);
  });

  it('触发历史接口可用', async () => {
    const r = await req('GET', '/api/automations/events?limit=10');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data?.events));
  });

  it('删除规则', async () => {
    const r = await req('DELETE', `/api/automations/${createdId}`);
    assert.equal(r.status, 200);
    const after = await req('GET', '/api/automations');
    assert.ok(!after.data.rules.find((x: any) => x.id === createdId));
  });
});
