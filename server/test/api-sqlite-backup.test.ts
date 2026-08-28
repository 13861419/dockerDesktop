/**
 * 面板数据库备份 API 集成测试
 *
 * 覆盖：
 *  1. 列表接口返回 items 数组
 *  2. 创建备份 → 出现在列表且文件非空
 *  3. 文件名路径穿越 → 400
 *  4. 下载备份 → 200
 *  5. 删除备份 → 从列表消失
 *
 * 恢复（restore）不做集成测试 —— 会把共享 dev 库整库回滚，抹掉其他并行
 * 测试文件期间新建的行；恢复逻辑由隔离单测 sqlite-backup-restore.test.ts 覆盖。
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

function req(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
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
  assert.ok(adminToken, '管理员登录失败');
});

let createdFile = '';

test('创建备份：201 且出现在列表中', async () => {
  const create = await req('POST', '/api/sqlite-backups', { reason: 'apitest' });
  assert.strictEqual(create.status, 201);
  assert.ok(create.data.file.length > 0);
  assert.ok(create.data.size > 0);
  createdFile = create.data.file;

  const list = await req('GET', '/api/sqlite-backups');
  assert.strictEqual(list.status, 200);
  assert.ok(Array.isArray(list.data.items));
  assert.ok(list.data.items.some((x: any) => x.file === createdFile));
});

test('路径穿越的文件名返回 400', async () => {
  const r = await req('DELETE', `/api/sqlite-backups/${encodeURIComponent('../secrets.db')}`);
  assert.strictEqual(r.status, 400);
});

test('下载备份返回 200', async () => {
  const r = await req('GET', `/api/sqlite-backups/${encodeURIComponent(createdFile)}/download`);
  assert.strictEqual(r.status, 200);
});

test('删除备份：从列表消失', async () => {
  const r = await req('DELETE', `/api/sqlite-backups/${encodeURIComponent(createdFile)}`);
  assert.strictEqual(r.status, 200);
  const list = await req('GET', '/api/sqlite-backups');
  assert.ok(!list.data.items.some((x: any) => x.file === createdFile));
});

after(async () => {
  // 清理本测试产生的全部 apitest 备份
  const list = await req('GET', '/api/sqlite-backups');
  for (const it of list.data.items || []) {
    if (String(it.file).includes('apitest')) await req('DELETE', `/api/sqlite-backups/${encodeURIComponent(it.file)}`);
  }
});
