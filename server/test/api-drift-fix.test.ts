/**
 * Compose 漂移一键修复 API 集成测试（1.40.0）
 *
 * 覆盖：本地引擎 fix-drift —— 修复后容器运行且漂移复检为 match。
 *
 * 依赖：后端运行于 localhost:9528，Docker 可用
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { execSync } from 'child_process';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
const sh = (cmd: string) => execSync(cmd, { shell: 'cmd.exe' });

function req(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const r = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
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

before(async () => {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin888' }),
  });
  adminToken = ((await login.json()) as any).token;
});

test('fix-drift：本地引擎按本地配置重建并消除漂移', async () => {
  const content = 'services:\n  e2e-fix-svc:\n    image: alpine\n    command: sleep 600\n';
  await req('POST', '/api/compose', { name: 'e2e-fix', content });
  const fix = await req('POST', '/api/compose/e2e-fix/fix-drift', { services: ['e2e-fix-svc'] });
  assert.equal(fix.status, 200);
  assert.equal(fix.data.ok, true);
  assert.equal(fix.data.mode, 'local');
  const running = sh('docker inspect -f {{.State.Running}} e2e-fix-e2e-fix-svc-1').toString().trim();
  assert.equal(running, 'true', '修复后容器运行中');
  const drift = await req('GET', '/api/compose/e2e-fix/drift');
  const svc = (drift.data.services || []).find((x: any) => x.service === 'e2e-fix-svc');
  assert.ok(svc, '漂移检测包含 e2e-fix-svc');
  assert.equal(svc.status, 'match', '修复后漂移为 match');
  sh('docker rm -f e2e-fix-e2e-fix-svc-1');
  await req('DELETE', '/api/compose/e2e-fix');
});

test('fix-drift：项目不存在返回 404，空 services 返回 400', async () => {
  const noProj = await req('POST', '/api/compose/e2e-fix-not-exist/fix-drift', { services: ['x'] });
  assert.equal(noProj.status, 404);
  // 先建项目使 composeFile 校验通过，再验证缺 services → 400
  const content = 'services:\n  e2e-fix-svc:\n    image: alpine\n    command: sleep 600\n';
  await req('POST', '/api/compose', { name: 'e2e-fix', content });
  const r = await req('POST', '/api/compose/e2e-fix/fix-drift', {});
  assert.equal(r.status, 400);
  await req('DELETE', '/api/compose/e2e-fix');
});

test('drift：labels 比对维度（1.43.0）', async () => {
  // 本地配置：带自定义标签 + healthcheck
  const content =
    'services:\n' +
    '  e2e-dim-svc:\n' +
    '    image: alpine\n' +
    '    command: sleep 600\n' +
    '    labels:\n' +
    '      e2e.dim: "v1"\n' +
    '    healthcheck:\n' +
    '      test: ["CMD-SHELL", "true"]\n';
  await req('POST', '/api/compose', { name: 'e2e-dim', content });
  const fix = await req('POST', '/api/compose/e2e-dim/fix-drift', { services: ['e2e-dim-svc'] });
  assert.equal(fix.status, 200);
  // 部署后远端与本地一致 → match
  let drift = await req('GET', '/api/compose/e2e-dim/drift');
  let svc = (drift.data.services || []).find((x: any) => x.service === 'e2e-dim-svc');
  assert.ok(svc, '漂移检测包含 e2e-dim-svc');
  assert.equal(svc.status, 'match', '部署后一致');
  // 修改本地标签值 → 检出 labels 漂移
  const content2 = content.replace('e2e.dim: "v1"', 'e2e.dim: "v2"');
  await req('POST', '/api/compose', { name: 'e2e-dim', content: content2 });
  drift = await req('GET', '/api/compose/e2e-dim/drift');
  svc = (drift.data.services || []).find((x: any) => x.service === 'e2e-dim-svc');
  assert.equal(svc.status, 'drift', '标签修改后应检出漂移');
  assert.ok((svc.diffs || []).includes('labels'), '差异项包含 labels');
  // 清理
  sh('docker rm -f e2e-dim-e2e-dim-svc-1');
  await req('DELETE', '/api/compose/e2e-dim');
});
