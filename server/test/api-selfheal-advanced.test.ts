/**
 * 自愈执行留档与增强规则 API 集成测试（1.39.0/1.40.0/1.41.0）
 *
 * 覆盖：
 *  1. 手动巡检触发自愈并留档（GET /api/selfheal/events）
 *  2. 标签匹配规则 + 触发次数上限（maxTriggers）
 *
 * 依赖：后端运行于 localhost:9528，Docker 可用（创建/删除临时容器）
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

test('selfheal：exited 规则触发 + 执行记录留档', async () => {
  sh('docker rm -f e2e-ev 2>nul & docker run -d --name e2e-ev alpine sleep 60 & docker stop e2e-ev');
  const rule = await req('POST', '/api/selfheal/rules', {
    containerName: 'e2e-ev', watchType: 'exited', action: 'start', cooldownSec: 10, enabled: true,
  });
  assert.equal(rule.status, 201, '创建规则成功');
  const run = await req('POST', '/api/selfheal/run');
  assert.equal(run.status, 200);
  const ev = await req('GET', '/api/selfheal/events?limit=10');
  assert.equal(ev.status, 200);
  const hit = (ev.data.events || []).find((e: any) => e.containerName === 'e2e-ev');
  assert.ok(hit, '执行记录包含 e2e-ev');
  assert.equal(hit.success, true);
  assert.ok(hit.createdAt > Date.now() - 60000, 'createdAt 为刚刚');
  await req('DELETE', '/api/selfheal/rules/' + rule.data.rule.id);
  sh('docker rm -f e2e-ev');
});

test('selfheal：标签匹配 + 触发次数上限', async () => {
  sh('docker rm -f e2e-lbl 2>nul & docker run -d --name e2e-lbl --label e2e-selfheal=true alpine sleep 60 & docker stop e2e-lbl');
  const rule = await req('POST', '/api/selfheal/rules', {
    containerName: '', matchLabel: 'e2e-selfheal=true', watchType: 'exited', action: 'start', cooldownSec: 10, maxTriggers: 1, triggerWindowSec: 60, enabled: true,
  });
  assert.equal(rule.status, 201, '创建标签规则成功');
  const ruleId = rule.data.rule.id;
  const run1 = await req('POST', '/api/selfheal/run');
  assert.equal(run1.data.triggered >= 1, true, '第 1 次触发');
  sh('docker stop e2e-lbl');
  const run2 = await req('POST', '/api/selfheal/run');
  assert.equal(run2.data.triggered, 0, '达到上限不再触发');
  await req('DELETE', '/api/selfheal/rules/' + ruleId);
  sh('docker rm -f e2e-lbl');
});

test('selfheal：监控范围 engineScope 全部引擎（1.42.0）', async () => {
  sh('docker rm -f e2e-scope 2>nul & docker run -d --name e2e-scope alpine sleep 60 & docker stop e2e-scope');
  const bad = await req('POST', '/api/selfheal/rules', {
    containerName: 'e2e-scope', watchType: 'exited', action: 'start', cooldownSec: 10, engineScope: 'invalid', enabled: true,
  });
  assert.equal(bad.status, 400, '非法 engineScope 应 400');
  const rule = await req('POST', '/api/selfheal/rules', {
    containerName: 'e2e-scope', watchType: 'exited', action: 'start', cooldownSec: 10, engineScope: 'all', enabled: true,
  });
  assert.equal(rule.status, 201, '创建 all 范围规则成功');
  assert.equal(rule.data.rule.engineScope, 'all');
  const upd = await req('PUT', '/api/selfheal/rules/' + rule.data.rule.id, { engineScope: 'local' });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.rule.engineScope, 'local', 'engineScope 可更新为 local');
  await req('DELETE', '/api/selfheal/rules/' + rule.data.rule.id);
  sh('docker rm -f e2e-scope');
});

test('selfheal：执行记录筛选 + CSV 导出（1.42.0）', async () => {
  // 先制造一条记录
  sh('docker rm -f e2e-ev2 2>nul & docker run -d --name e2e-ev2 alpine sleep 60 & docker stop e2e-ev2');
  const rule = await req('POST', '/api/selfheal/rules', {
    containerName: 'e2e-ev2', watchType: 'exited', action: 'start', cooldownSec: 10, enabled: true,
  });
  assert.equal(rule.status, 201);
  await req('POST', '/api/selfheal/run');
  const filtered = await req('GET', '/api/selfheal/events?limit=50&container=e2e-ev2&success=true');
  assert.equal(filtered.status, 200);
  assert.ok((filtered.data.events || []).length >= 1, '容器名筛选命中');
  assert.ok((filtered.data.events || []).every((e: any) => e.containerName === 'e2e-ev2'), '筛选结果只含目标容器');
  const none = await req('GET', '/api/selfheal/events?limit=50&container=e2e-no-such-container-xyz');
  assert.equal(none.data.events.length, 0, '不存在的容器名筛选为空');
  const exp = await fetch(BASE + '/api/selfheal/events/export?container=e2e-ev2', {
    headers: { Authorization: 'Bearer ' + adminToken },
  });
  assert.equal(exp.status, 200);
  const csv = await exp.text();
  assert.ok(csv.includes('e2e-ev2'), 'CSV 含目标容器');
  assert.ok(csv.includes('ID,容器,监控类型'), 'CSV 表头存在');
  await req('DELETE', '/api/selfheal/rules/' + rule.data.rule.id);
  sh('docker rm -f e2e-ev2');
});
