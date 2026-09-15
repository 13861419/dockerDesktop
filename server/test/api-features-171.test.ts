/**
 * 1.71.0 Edge agent 一键升级 + 节点资源采样 API 契约测试
 *
 * 覆盖：
 *  1. GET /api/edge/nodes 返回 latestAgentVersion（与 agent.js 内 AGENT_VERSION 一致）
 *  2. POST /api/edge/nodes/:id/upgrade —— 离线节点 → 400
 *  3. GET /api/edge/nodes/:id/stats → { series: [] }（无采样时为空数组）
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'fs';
import path from 'path';

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

describe('1.71.0 Edge agent 升级与资源监控', () => {
  it('节点列表返回 latestAgentVersion 且与 agent.js 内版本一致', async () => {
    const r = await req('GET', '/api/edge/nodes');
    assert.strictEqual(r.status, 200);
    assert.ok(/^\d+\.\d+\.\d+$/.test(r.data.latestAgentVersion));
    const agentCode = fs.readFileSync(path.resolve(__dirname, '../agent/agent.js'), 'utf8');
    const m = agentCode.match(/AGENT_VERSION\s*=\s*'([\d.]+)'/);
    assert.strictEqual(r.data.latestAgentVersion, m ? m[1] : '');
  });

  it('升级接口：离线节点 → 400', async () => {
    const create = await req('POST', '/api/edge/nodes', { name: 'upgrade-test-171' });
    assert.strictEqual(create.status, 201);
    const id = create.data.node.id;
    const r = await req('POST', `/api/edge/nodes/${id}/upgrade`, {});
    assert.strictEqual(r.status, 400);
    assert.match(String(r.data.error), /离线/);
  });

  it('资源采样接口：无数据返回空 series', async () => {
    const create = await req('POST', '/api/edge/nodes', { name: 'stats-test-171' });
    assert.strictEqual(create.status, 201);
    const id = create.data.node.id;
    const r = await req('GET', `/api/edge/nodes/${id}/stats`);
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.data.series));
    assert.strictEqual(r.data.series.length, 0);
  });
});
