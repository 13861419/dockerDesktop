import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 9528;

let AUTH_TOKEN = '';
let TASK_ID = '';
let FAIL_ID = '';

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

describe('1.66.0 任务步骤化输出', () => {
  it('command 任务执行后历史记录携带步骤化输出', async () => {
    const created = await req('POST', '/api/tasks', {
      name: 'e2e-steps-166',
      type: 'command',
      cron: '0 3 * * *',
      enabled: false,
      config: { command: 'echo hello-steps-166' },
    });
    assert.equal(created.status, 200);
    TASK_ID = created.data?.id;
    assert.ok(TASK_ID, 'task id returned');

    const run = await req('POST', `/api/tasks/${TASK_ID}/run`, {});
    assert.equal(run.status, 200);
    assert.equal(run.data.ok, true);

    // 等落库（run 同步写历史，但留一点缓冲）
    await new Promise((r) => setTimeout(r, 300));
    const logs = await req('GET', `/api/tasks/logs?taskId=${TASK_ID}`);
    assert.equal(logs.status, 200);
    const item = (logs.data?.items || [])[0];
    assert.ok(item, 'log row exists');
    assert.ok(Array.isArray(item.steps) && item.steps.length > 0, 'steps array present');
    assert.equal(item.steps[0].name, '执行命令');
    assert.equal(item.steps[0].status, 'ok');
    assert.ok(String(item.steps[0].output).includes('hello-steps-166'));
    assert.ok(typeof item.steps[0].durationMs === 'number');
  });

  it('失败命令产生 fail 节点', async () => {
    const created = await req('POST', '/api/tasks', {
      name: 'e2e-steps-fail-166',
      type: 'command',
      cron: '0 3 * * *',
      enabled: false,
      config: { command: 'exit 7' },
    });
    FAIL_ID = created.data?.id;
    await req('POST', `/api/tasks/${FAIL_ID}/run`, {});
    await new Promise((r) => setTimeout(r, 300));
    const logs = await req('GET', `/api/tasks/logs?taskId=${FAIL_ID}`);
    const item = (logs.data?.items || [])[0];
    assert.ok(Array.isArray(item.steps));
    assert.equal(item.steps[0].status, 'fail');
  });
});

after(async () => {
  if (TASK_ID) await req('DELETE', `/api/tasks/${TASK_ID}`);
  if (FAIL_ID) await req('DELETE', `/api/tasks/${FAIL_ID}`);
});
