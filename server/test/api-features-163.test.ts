import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const PORT = 9528;

let AUTH_TOKEN = '';
let EDGE_ID = '';
let EDGE_TOKEN = '';

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

/** 模拟 agent 的 WebSocket 客户端：收到请求回执固定数据 */
function fakeAgent(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/api/edge/ws?token=${encodeURIComponent(token)}`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', version: 'test-1.0' }));
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
        ws.send(JSON.stringify({ id: msg.id, ok: true, status: 200, data: { echo: msg.path, fake: true } }));
      }
    });
    ws.on('error', reject);
  });
}

before(async () => {
  const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  AUTH_TOKEN = r.data?.token || '';
  assert.ok(AUTH_TOKEN, 'login should return a token');
});

describe('1.63.0 Edge 节点', () => {
  it('创建节点返回一次性 token，列表显示离线', async () => {
    const r = await req('POST', '/api/edge/nodes', { name: 'e2e-edge' });
    assert.equal(r.status, 201);
    assert.ok(r.data.token?.startsWith('edge_'));
    assert.ok(r.data.node?.id);
    EDGE_ID = r.data.node.id;
    EDGE_TOKEN = r.data.token;
    const list = await req('GET', '/api/edge/nodes');
    const node = list.data.items.find((n: any) => n.id === EDGE_ID);
    assert.ok(node, 'node in list');
    assert.equal(node.online, false);
  });

  it('节点离线时 ping 返回 502', async () => {
    const r = await req('POST', `/api/edge/nodes/${EDGE_ID}/ping`, {});
    assert.equal(r.status, 502);
    assert.equal(r.data.ok, false);
  });

  it('agent 连接后隧道 ping 与只读透传可用', async () => {
    const ws = await fakeAgent(EDGE_TOKEN);
    const list = await req('GET', '/api/edge/nodes');
    const node = list.data.items.find((n: any) => n.id === EDGE_ID);
    assert.equal(node.online, true);

    const ping = await req('POST', `/api/edge/nodes/${EDGE_ID}/ping`, {});
    assert.equal(ping.status, 200);
    assert.equal(ping.data.ok, true);
    assert.equal(ping.data.version.echo, '/version');

    const passthrough = await req(
      'GET',
      `/api/edge/nodes/${EDGE_ID}/docker/containers/json?all=true`,
    );
    assert.equal(passthrough.status, 200);
    assert.equal(passthrough.data.echo, '/containers/json?all=true');
    ws.close();
  });

  it('透传路径白名单外的路径返回 400', async () => {
    const r = await req('GET', `/api/edge/nodes/${EDGE_ID}/docker/run`);
    assert.equal(r.status, 400);
  });

  it('无效 token 的 agent 连接被拒绝', async () => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/api/edge/ws?token=edge_bad`);
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve(1006));
    });
    const code = await closed;
    assert.notEqual(code, 1000, '有效连接不应发生');
  });

  it('删除节点', async () => {
    const r = await req('DELETE', `/api/edge/nodes/${EDGE_ID}`);
    assert.equal(r.status, 200);
    const list = await req('GET', '/api/edge/nodes');
    assert.ok(!list.data.items.find((n: any) => n.id === EDGE_ID));
  });
});
