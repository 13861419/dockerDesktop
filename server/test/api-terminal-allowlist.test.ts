/**
 * 容器资源级授权（终端 WebSocket / 日志聚合）集成测试（1.40.0/1.41.0）
 *
 * 覆盖：
 *  1. 名单外容器终端 WebSocket → 403；名单内 → 101；管理员不受限
 *  2. 日志聚合候选列表过滤
 *
 * 依赖：后端运行于 localhost:9528，Docker 可用
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { execSync } from 'child_process';
import WebSocket from 'ws';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
const sh = (cmd: string) => execSync(cmd, { shell: 'cmd.exe' });

function req(method: string, path: string, body?: any, token?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const r = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || adminToken) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, data });
          }
        });
      },
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

/** WS upgrade 探测，返回最终 HTTP 状态码（101 = 升级成功） */
function wsProbe(containerId: string, token: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:9528/ws/terminal/' + containerId + '?token=' + token, {
      handshakeTimeout: 5000,
    });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_r: unknown, res: { statusCode: number }) => resolve(res.statusCode));
    ws.on('error', () => resolve(0));
    setTimeout(() => resolve(0), 8000);
  });
}

let deniedContainerId = '';
let allowedContainerId = '';

before(async () => {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin888' }),
  });
  adminToken = ((await login.json()) as any).token;
  // 名单外临时容器
  deniedContainerId = sh('docker run -d --name e2e-ws-denied alpine sleep 600').toString().trim();
  // 名单内容器（jackos- 前缀，本仓库约定测试容器均以 jackos-* 命名）
  allowedContainerId = sh('docker run -d --name jackos-e2e-ws alpine sleep 600').toString().trim();
});

test('终端 WebSocket：名单外 403 / 名单内 101 / 管理员不受限', async () => {
  // operator 角色测试用户 + 白名单 jackos-*
  await req('POST', '/api/system/users', { username: 'e2ews', password: 'e2ews123456', role: 'operator' });
  await req('PUT', '/api/system/users/e2ews/container-allowlist', { allowlist: 'jackos-*' });
  const ulogin = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2ews', password: 'e2ews123456' }),
  });
  const userToken = ((await ulogin.json()) as any).token;

  const denied = await wsProbe(deniedContainerId, userToken);
  assert.equal(denied, 403, '名单外容器终端 → 403');
  const allowed = await wsProbe(allowedContainerId, userToken);
  assert.equal(allowed, 101, '名单内容器终端 → 升级成功');
  const admin = await wsProbe(deniedContainerId, adminToken);
  assert.equal(admin, 101, '管理员终端不受限');
});

test('日志聚合：候选列表已按白名单过滤', async () => {
  const ulogin = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2ews', password: 'e2ews123456' }),
  });
  const userToken = ((await ulogin.json()) as any).token;
  const r = await req('GET', '/api/logs/containers', undefined, userToken);
  assert.equal(r.status, 200);
  const names: string[] = (r.data || []).map((x: any) => x.name || '');
  assert.ok(names.every((n) => n.startsWith('jackos-')), '候选列表只含 jackos-* 容器');
});

test('日志聚合：按 id 拉取名单外容器日志 → 403', async () => {
  const ulogin = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2ews', password: 'e2ews123456' }),
  });
  const userToken = ((await ulogin.json()) as any).token;
  const r = await req('GET', '/api/logs/query?containerIds=' + deniedContainerId.slice(0, 12), undefined, userToken);
  assert.equal(r.status, 403, '越权拉日志被拒绝');
});

test('清理测试用户与临时容器', async () => {
  await req('DELETE', '/api/system/users/e2ews');
  sh('docker rm -f e2e-ws-denied jackos-e2e-ws 2>nul');
});
