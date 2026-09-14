import { describe, it, before, after } from 'node:test';
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
      ws.send(JSON.stringify({ type: 'hello', version: 'test-1.64' }));
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
}

before(async () => {
  const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  AUTH_TOKEN = r.data?.token || '';
  assert.ok(AUTH_TOKEN, 'login should return a token');
  const node = await req('POST', '/api/edge/nodes', { name: 'e2e-edge-write' });
  EDGE_ID = node.data.node.id;
  EDGE_TOKEN = node.data.token;
  globalThis.__ws = await fakeAgent(EDGE_TOKEN);
});

describe('1.64.0 Edge 写透传与安装下发', () => {
  it('容器 start/stop/restart 白名单可透传', async () => {
    const r = await req('POST', `/api/edge/nodes/${EDGE_ID}/docker/containers/abc123/start`, {});
    assert.equal(r.status, 200);
    assert.equal(r.data.echo, '/containers/abc123/start');
    assert.equal(r.data.method, 'POST');
  });

  it('镜像拉取（长耗时）可透传', async () => {
    const r = await req('POST', `/api/edge/nodes/${EDGE_ID}/docker/images/create?fromImage=nginx`, {});
    assert.equal(r.status, 200);
    assert.equal(r.data.echo, '/images/create?fromImage=nginx');
  });

  it('白名单外写操作返回 400', async () => {
    const r = await req('POST', `/api/edge/nodes/${EDGE_ID}/docker/containers`, { image: 'x' });
    assert.equal(r.status, 400);
    const r2 = await req('POST', `/api/edge/nodes/${EDGE_ID}/docker/secrets`, {});
    assert.equal(r2.status, 400);
  });

  it('agent.js / agent.sh 公开下发（无需登录）', async () => {
    const r = await req('GET', '/api/edge/agent.js');
    assert.equal(r.status, 200);
    assert.ok(String(r.data).includes('EDGE_TOKEN'));
    const s = await req('GET', '/api/edge/agent.sh');
    assert.equal(s.status, 200);
    assert.ok(String(s.data).includes('systemctl'));
  });
});

after(async () => {
  (globalThis as any).__ws?.close();
  await req('DELETE', `/api/edge/nodes/${EDGE_ID}`);
});
