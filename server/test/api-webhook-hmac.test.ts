import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

const HOST = '127.0.0.1';
const PORT = 9528;

let AUTH_TOKEN = '';
let APP_ID = 0;
let WEBHOOK_TOKEN = '';
const SECRET = 'test-hmac-secret-123';
const APP_NAME = `hmac-webhook-app-${Date.now()}`;

function req(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
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
          ...extraHeaders,
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

/** 发送签名 Webhook 请求（对固定原始字节计算签名） */
function webhookReq(token: string, rawBody: string, signature?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: `/api/webhook/${token}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
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
    r.write(rawBody);
    r.end();
  });
}

describe('deploy webhook HMAC', () => {
  before(async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
    AUTH_TOKEN = r.data?.token || '';
    assert.ok(AUTH_TOKEN, 'login should return a token');
    // 创建测试部署应用（仓库地址故意不可达，部署动作会快速失败不影响断言）
    const created = await req('POST', '/api/deploys', {
      name: APP_NAME,
      repoUrl: 'https://127.0.0.1:1/x.git',
    });
    assert.ok([200, 201].includes(created.status), `create deploy app failed: ${created.status}`);
    const list = await req('GET', '/api/deploys');
    const app = (list.data?.items || []).find((i: any) => i.name === APP_NAME);
    assert.ok(app, 'created app should appear in list');
    APP_ID = app.id;
    WEBHOOK_TOKEN = app.webhook_token;
    assert.ok(WEBHOOK_TOKEN, 'app should have a webhook token');
  });

  after(async () => {
    if (APP_ID) {
      await req('DELETE', `/api/deploys/${APP_ID}`);
    }
  });

  it('未配置密钥时无需签名即可触发', async () => {
    const r = await webhookReq(WEBHOOK_TOKEN, JSON.stringify({ test: 1 }));
    // 409 = 签名已通过但部署锁被占用（前一次触发的异步部署尚未结束），同样证明请求被放行
    assert.ok([200, 409].includes(r.status));
    if (r.status === 200) assert.equal(r.data?.ok, true);
  });

  it('设置密钥成功且列表返回 webhook_secret_set', async () => {
    const r = await req('POST', `/api/deploys/${APP_ID}/webhook-secret`, { secret: SECRET });
    assert.equal(r.status, 200);
    assert.equal(r.data?.enabled, true);
    const list = await req('GET', '/api/deploys');
    const app = (list.data?.items || []).find((i: any) => i.id === APP_ID);
    assert.equal(app?.webhook_secret_set, 1);
  });

  it('配置密钥后缺少签名返回 401', async () => {
    const r = await webhookReq(WEBHOOK_TOKEN, JSON.stringify({ test: 1 }));
    assert.equal(r.status, 401);
  });

  it('配置密钥后错误签名返回 401', async () => {
    const bad = 'sha256=' + createHmac('sha256', 'wrong-secret').update('{"test":1}').digest('hex');
    const r = await webhookReq(WEBHOOK_TOKEN, JSON.stringify({ test: 1 }), bad);
    assert.equal(r.status, 401);
  });

  it('配置密钥后正确签名触发成功', async () => {
    const raw = JSON.stringify({ test: 2 });
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    const r = await webhookReq(WEBHOOK_TOKEN, raw, sig);
    // 409 = 签名校验已通过但部署锁被占用；只有签名失败才会 401
    assert.ok([200, 409].includes(r.status));
    if (r.status === 200) assert.equal(r.data?.ok, true);
  });

  it('清除密钥后恢复免签触发', async () => {
    const r = await req('POST', `/api/deploys/${APP_ID}/webhook-secret`, { secret: '' });
    assert.equal(r.status, 200);
    assert.equal(r.data?.enabled, false);
    const list = await req('GET', '/api/deploys');
    const app = (list.data?.items || []).find((i: any) => i.id === APP_ID);
    assert.equal(app?.webhook_secret_set, 0);
    const trig = await webhookReq(WEBHOOK_TOKEN, JSON.stringify({ test: 3 }));
    assert.ok([200, 409].includes(trig.status));
  });

  it('过长的密钥返回 400', async () => {
    const r = await req('POST', `/api/deploys/${APP_ID}/webhook-secret`, { secret: 'x'.repeat(300) });
    assert.equal(r.status, 400);
  });
});
