import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'node:child_process';

const HOST = '127.0.0.1';
const PORT = 9528;
const PROJECT = 'dm-ext-test';

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

/** 在面板管理目录之外创建一个真实的 compose 项目（供外部发现用） */
function setupExternalProject(): { dir: string; file: string } | null {
  try {
    execSync('docker version', { stdio: 'ignore' });
  } catch {
    return null; // 无 docker 环境则跳过
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ext-test-'));
  const file = path.join(dir, 'docker-compose.yml');
  fs.writeFileSync(
    file,
    'services:\n  test:\n    image: busybox:latest\n    command: sleep 300\n',
    'utf8',
  );
  try {
    execSync(`docker compose -p ${PROJECT} -f "${file}" up -d --quiet-pull`, { stdio: 'ignore', timeout: 120000 });
    return { dir, file };
  } catch {
    return null;
  }
}

function teardownExternalProject(dir: string) {
  try {
    execSync(`docker compose -p ${PROJECT} -f "${path.join(dir, 'docker-compose.yml')}" down -v`, { stdio: 'ignore', timeout: 60000 });
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

describe('1.51.0 外部 Compose 项目纳管', () => {
  let ext: { dir: string; file: string } | null = null;

  it('外部项目被发现、可读可编辑', async () => {
    ext = setupExternalProject();
    if (!ext) {
      return;
    }
    try {
      // 列表中出现且来源为 external
      const list = await req('GET', '/api/compose');
      assert.equal(list.status, 200);
      const found = (Array.isArray(list.data) ? list.data : []).find((p: any) => p.name === PROJECT);
      assert.ok(found, 'external project should be listed');
      assert.equal(found.source, 'external');

      // 读取 compose 文件
      const file = await req('GET', `/api/compose/${PROJECT}/file`);
      assert.equal(file.status, 200);
      assert.ok(String(file.data?.content || '').includes('busybox'));

      // 保存（覆写外部文件）
      const newYaml = 'services:\n  test:\n    image: busybox:latest\n    command: sleep 600\n    environment:\n      FOO: bar\n';
      const save = await req('POST', '/api/compose', { name: PROJECT, content: newYaml });
      assert.equal(save.status, 201);
      assert.equal(save.data?.external, true);
      const reread = await req('GET', `/api/compose/${PROJECT}/file`);
      assert.ok(String(reread.data?.content || '').includes('FOO'), 'edited content should persist');
      // 外部目录中保存（不是在面板目录新建）
      assert.ok(fs.readFileSync(ext.file, 'utf8').includes('FOO'));

      // 项目详情可读（服务状态）
      const detail = await req('GET', `/api/compose/${PROJECT}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.data?.source, 'external');
    } finally {
      teardownExternalProject(ext.dir);
    }
  });

  it('不存在的项目返回 404', async () => {
    const r = await req('GET', '/api/compose/no-such-project-xyz');
    assert.equal(r.status, 404);
  });
});
