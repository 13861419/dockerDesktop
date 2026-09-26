/**
 * 容器回收站 API 集成测试
 *
 * 全链路：创建容器 → 删除（自动入回收站）→ 列表校验 → 恢复 → 容器存在 →
 * 清理（再删 + 删记录）。
 *
 * 依赖：后端服务运行在 localhost:9528，Docker 引擎可用（api-containers 同款前提）
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let createdName = '';
let createdId = '';

function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed: any;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode || 0, data: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

before(async () => {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin888' });
  adminToken = login.data.token;
  createdName = 'recycle-demo-' + Date.now();
});

test('全链路：创建 → 删除入站 → 恢复 → 清理', async (t) => {
  // 创建前尝试确保镜像存在：缺失（404）时经面板 API 拉取一次再重试；
  // CI 环境可能无外网镜像源或拉取到带镜像源前缀的标签，仍失败则跳过
  const createBody = { name: createdName, image: 'alpine:latest', start: false };
  let createRes = await req('POST', '/api/containers', createBody, { Authorization: `Bearer ${adminToken}` });
  if (createRes.status === 404) {
    await req('POST', '/api/images/pull', { ref: 'alpine:latest' }, { Authorization: `Bearer ${adminToken}` });
    createRes = await req('POST', '/api/containers', { ...createBody, name: createdName + '-r2' }, { Authorization: `Bearer ${adminToken}` });
  }
  if (createRes.status !== 201) return t.skip(`测试镜像不可用（创建返回 ${createRes.status}）`);
  createdName = (createRes.data as { name?: string }).name || createdName;
  createdId = (createRes.data as { id: string }).id;

  // 2. 删除（应自动捕获快照入回收站）
  const delRes = await req('DELETE', `/api/containers/${createdId}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(delRes.status, 200);

  // 3. 回收站列表应包含该容器
  const listRes = await req('GET', '/api/recycle', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(listRes.status, 200);
  const record = (listRes.data as Array<{ id: number; name: string; image: string | null }>).find(
    (r) => r.name === createdName,
  );
  assert.ok(record, '回收站应包含刚删除的容器');
  assert.strictEqual(record.image, 'alpine:latest');

  // 4. 恢复（换一个新名字，避免后续重跑冲突）
  const restoredName = createdName + '-restored';
  const restoreRes = await req(
    'POST',
    `/api/recycle/${record.id}/restore`,
    { name: restoredName },
    { Authorization: `Bearer ${adminToken}` },
  );
  assert.ok(restoreRes.status === 201, `恢复应 201，实际 ${restoreRes.status}: ${JSON.stringify(restoreRes.data)}`);

  // 5. 恢复后的容器应存在于容器列表（列表项为 docker 原始结构，名称在 Names[0]）
  const listAfter = await req('GET', '/api/containers?all=true', undefined, { Authorization: `Bearer ${adminToken}` });
  const restored = (listAfter.data as Array<{ name?: string; Names?: string[] }>).find(
    (c) => (c.name || (c.Names?.[0] || '').replace(/^\//, '')) === restoredName,
  );
  assert.ok(restored, '恢复后的容器应出现在容器列表');

  // 6. 清理：删除恢复出的容器（再次入站）并删除新记录，保持环境干净
  // 恢复默认启动且 alpine 挂 TTY 常驻，必须 force 才能删除运行中容器
  const restoredId = (restoreRes.data as { id: string }).id;
  await req('DELETE', `/api/containers/${restoredId}?force=true`, undefined, { Authorization: `Bearer ${adminToken}` });
  const listAgain = await req('GET', '/api/recycle', undefined, { Authorization: `Bearer ${adminToken}` });
  const newRecord = (listAgain.data as Array<{ id: number; name: string }>).find((r) => r.name === restoredName);
  assert.ok(newRecord, '恢复出的容器删除后应再次入站');
  const delRecord = await req('DELETE', `/api/recycle/${newRecord.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(delRecord.status, 200);
});

test('恢复不存在的记录返回 404', async () => {
  const res = await req('POST', '/api/recycle/99999999/restore', {}, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});
