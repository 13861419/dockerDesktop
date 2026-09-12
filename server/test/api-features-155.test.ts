import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOST = '127.0.0.1';
const PORT = 9528;
/** git daemon 端口（避免与常用端口冲突） */
const GIT_PORT = 9419;

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

/** 本地 git daemon 进程句柄与临时目录 */
let daemonProc: ReturnType<typeof spawn> | null = null;
let tmpDir = '';

before(async () => {
  const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  AUTH_TOKEN = r.data?.token || '';
  assert.ok(AUTH_TOKEN, 'login should return a token');

  // 准备应用源仓库：1 个合法应用 + 1 个非法条目（应被跳过）
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-appsrc-'));
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  const manifest = [
    {
      id: 'myapp',
      name: 'My App',
      description: '来自应用源的应用',
      category: '测试',
      image: 'busybox:latest',
      icon: '📗',
      ports: [{ container: 80 }],
    },
    { id: 'bad!!', name: '坏条目' },
    { id: 'noimg', name: '无镜像' },
  ];
  fs.writeFileSync(path.join(repoDir, 'apps.json'), JSON.stringify(manifest));
  execSync(`git init`, { cwd: repoDir });
  execSync(`git add .`, { cwd: repoDir });
  execSync(`git -c user.email=t@t -c user.name=t commit -m init`, { cwd: repoDir });
  // 启动本地 git daemon 模拟远端仓库
  daemonProc = spawn('git', [
    'daemon',
    `--base-path=${tmpDir}`,
    '--export-all',
    '--reuseaddr',
    `--listen=127.0.0.1`,
    `--port=${GIT_PORT}`,
  ]);
  daemonProc.on('error', () => {});
  // 等待 daemon 就绪（clone 重试由首次 POST 体现）
  await new Promise((r) => setTimeout(r, 1200));
});

after(() => {
  if (daemonProc?.pid) {
    try {
      execSync(`taskkill /pid ${daemonProc.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // 进程可能已退出
    }
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 清理失败不阻塞
  }
});

describe('1.55.0 Git 应用源', () => {
  let sourceId = '';

  it('新增应用源并立即同步（非法条目被跳过）', async () => {
    const create = await req('POST', '/api/appstore/sources', {
      name: '测试源',
      url: `git://127.0.0.1:${GIT_PORT}/repo`,
    });
    assert.equal(create.status, 201);
    assert.equal(create.data?.warning, undefined);
    sourceId = create.data?.source?.id || '';
    assert.ok(sourceId, 'source id should exist');
    assert.equal(create.data.source.appCount, 1);
    assert.equal(create.data.source.enabled, true);
  });

  it('应用源应用出现在商店列表且带来源标记', async () => {
    const list = await req('GET', '/api/appstore');
    assert.equal(list.status, 200);
    const app = (list.data?.apps || []).find((a: any) => a.id === `src-${sourceId}-myapp`);
    assert.ok(app, 'source app should be listed');
    assert.equal(app.sourceName, '测试源');
    assert.equal(app.name, 'My App');
  });

  it('来源应用可通过 findApp 解析（详情接口）', async () => {
    const detail = await req('GET', `/api/appstore/src-${sourceId}-myapp/detail`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data?.app?.name, 'My App');
  });

  it('禁用应用源后列表隐藏，重新启用恢复', async () => {
    const off = await req('PUT', `/api/appstore/sources/${sourceId}`, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.data?.source?.enabled, false);
    let list = await req('GET', '/api/appstore');
    let app = (list.data?.apps || []).find((a: any) => a.id === `src-${sourceId}-myapp`);
    assert.equal(app, undefined);
    const on = await req('PUT', `/api/appstore/sources/${sourceId}`, { enabled: true });
    assert.equal(on.data?.source?.enabled, true);
    list = await req('GET', '/api/appstore');
    app = (list.data?.apps || []).find((a: any) => a.id === `src-${sourceId}-myapp`);
    assert.ok(app, 'source app should be listed again');
  });

  it('手动同步返回最新应用数', async () => {
    const sync = await req('POST', `/api/appstore/sources/${sourceId}/sync`, {});
    assert.equal(sync.status, 200);
    assert.equal(sync.data?.count, 1);
  });

  it('空名称 / 空 URL 创建被拒绝', async () => {
    const noName = await req('POST', '/api/appstore/sources', { name: '', url: 'https://example.com/x.git' });
    assert.equal(noName.status, 400);
    const noUrl = await req('POST', '/api/appstore/sources', { name: 'x' });
    assert.equal(noUrl.status, 400);
  });

  it('非法仓库 URL 创建保留记录但带同步警告', async () => {
    const bad = await req('POST', '/api/appstore/sources', { name: '坏源', url: 'ftp://127.0.0.1/x' });
    assert.equal(bad.status, 201);
    assert.ok(bad.data?.warning, 'sync warning should be set');
    const id = bad.data?.source?.id;
    const del = await req('DELETE', `/api/appstore/sources/${id}`);
    assert.equal(del.status, 200);
  });

  it('删除应用源后应用从列表消失', async () => {
    const del = await req('DELETE', `/api/appstore/sources/${sourceId}`);
    assert.equal(del.status, 200);
    const list = await req('GET', '/api/appstore');
    const app = (list.data?.apps || []).find((a: any) => a.id === `src-${sourceId}-myapp`);
    assert.equal(app, undefined);
    const sources = await req('GET', '/api/appstore/sources');
    assert.equal((sources.data?.sources || []).length, 0);
  });
});
