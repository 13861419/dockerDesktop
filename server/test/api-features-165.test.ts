import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const PORT = 9528;

let AUTH_TOKEN = '';
let EDGE_ID = '';
let EDGE_TOKEN = '';
let WS: WebSocket | null = null;

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

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

before(async () => {
  const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  AUTH_TOKEN = r.data?.token || '';
  assert.ok(AUTH_TOKEN, 'login should return a token');
  const node = await req('POST', '/api/edge/nodes', { name: 'e2e-edge-165' });
  EDGE_ID = node.data.node.id;
  EDGE_TOKEN = node.data.token;
  WS = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/api/edge/ws?token=${encodeURIComponent(EDGE_TOKEN)}`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', version: 'test-1.65' }));
      resolve(ws);
    });
    ws.on('message', (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof msg?.id === 'string' && typeof msg?.method === 'string') {
        ws.send(JSON.stringify({ id: msg.id, ok: true, status: 200, data: { echo: msg.path, method: msg.method } }));
      }
    });
    ws.on('error', reject);
  });
});

after(async () => {
  WS?.close();
  await req('DELETE', `/api/edge/nodes/${EDGE_ID}`);
});

describe('1.65.0 Edge 事件聚合 / 部署 / 日志', () => {
  it('容器创建与日志路径白名单可透传', async () => {
    const c = await req('POST', `/api/edge/nodes/${EDGE_ID}/docker/containers/create?name=e2e`, {
      Image: 'nginx:alpine',
    });
    assert.equal(c.status, 200);
    assert.equal(c.data.echo, '/containers/create?name=e2e');

    const l = await req('GET', `/api/edge/nodes/${EDGE_ID}/docker/containers/abc/logs?stdout=1&tail=100`);
    assert.equal(l.status, 200);
    assert.equal(l.data.echo, '/containers/abc/logs?stdout=1&tail=100');
  });

  it('agent 转发的远端事件并入统一事件流（scope=edge:<nodeId>）', async () => {
    const raw = {
      Type: 'container',
      Action: 'die',
      time: Math.floor(Date.now() / 1000),
      Actor: { ID: 'edgebeef123', Attributes: { name: 'e2e-edge-xyz', image: 'nginx' } },
    };
    WS!.send(JSON.stringify({ type: 'event', event: raw }));
    await wait(500);
    const r = await req('GET', '/api/events?type=container&limit=50');
    assert.equal(r.status, 200);
    const items = r.data?.events || r.data?.items || r.data || [];
    const hit = (Array.isArray(items) ? items : []).find(
      (e: any) => e.id === 'edgebeef123' || e.entityId === 'edgebeef123',
    );
    assert.ok(hit, 'edge event should be in the unified stream');
    assert.ok(String(hit.scope || '').startsWith('edge:'), 'scope should be edge:<nodeId>');
  });

  it('自动化规则对 Edge 事件生效（跨节点自愈：restart 经隧道执行）', async () => {
    const rule = await req('POST', '/api/automations', {
      name: 'e2e-edge-selfheal',
      eventType: 'container.die',
      matchContainer: 'e2e-edge-xyz',
      action: 'restart',
      cooldownSec: 1,
    });
    assert.equal(rule.status, 201);
    const ruleId = rule.data?.rule?.id;

    WS!.send(
      JSON.stringify({
        type: 'event',
        event: {
          Type: 'container',
          Action: 'die',
          time: Math.floor(Date.now() / 1000),
          Actor: { ID: 'edgebeef123', Attributes: { name: 'e2e-edge-xyz', image: 'nginx' } },
        },
      }),
    );
    await wait(1500);
    const evs = await req('GET', '/api/automations/events');
    const hit = (evs.data?.events || []).find((e: any) => e.rule_name === 'e2e-edge-selfheal');
    assert.ok(hit, 'automation should trigger for edge event');
    assert.equal(hit.ok, 1, 'edge action should succeed via tunnel');
    assert.ok(String(hit.detail || '').includes('Edge'));

    if (ruleId) await req('DELETE', `/api/automations/${ruleId}`);
  });
});
