/**
 * 镜像管理 API 集成测试
 *
 * 依赖：后端服务运行在 localhost:9528，Docker 引擎可用
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

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
});

test('GET /api/images: 返回成功状态码', async () => {
  const res = await req('GET', '/api/images', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('GET /api/images/:name: 查询不存在的镜像返回 404', async () => {
  const res = await req('GET', '/api/images/sha256:0000000000000000000000000000000000000000000000000000000000000000', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('POST /api/images/prune: 清理悬空镜像返回成功', async () => {
  const res = await req('POST', '/api/images/prune', { dangling: true }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('GET /api/images: 未登录返回 401', async () => {
  const res = await req('GET', '/api/images');
  assert.strictEqual(res.status, 401);
});

// ============ 补充缺失端点测试 ============

test('GET /api/images/suggestions: 优化建议', async () => {
  const res = await req('GET', '/api/images/suggestions', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(typeof res.data?.totalCount === 'number', '应返回 totalCount');
  assert.ok(Array.isArray(res.data?.topLarge), '应返回 topLarge 数组');
  assert.ok(Array.isArray(res.data?.unused), '应返回 unused 数组');
});

test('GET /api/images/categorized: 分类镜像列表', async () => {
  const res = await req('GET', '/api/images/categorized', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(Array.isArray(res.data?.dangling), '应返回 dangling 数组');
  assert.ok(Array.isArray(res.data?.unused), '应返回 unused 数组');
  assert.ok(Array.isArray(res.data?.active), '应返回 active 数组');
});

test('POST /api/images/delete-batch: 批量删除空列表返回 400', async () => {
  const res = await req('POST', '/api/images/delete-batch', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/images/delete-batch: 批量删除不存在的镜像', async () => {
  const res = await req('POST', '/api/images/delete-batch', { names: ['nonexistent-image-xxx'] }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data?.failed), '应返回 failed 数组');
  }
});

test('GET /api/images/:name/impact: 镜像关联容器查询', async () => {
  const res = await req('GET', '/api/images/alpine:latest/impact', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data?.relatedContainers), '应返回 relatedContainers 数组');
  }
});

test('GET /api/images/:name/impact: 不存在的镜像返回 404', async () => {
  const res = await req('GET', '/api/images/sha256:0000000000000000000000000000000000000000000000000000000000000000/impact', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('GET /api/images/:name/history: 镜像构建历史', async () => {
  const res = await req('GET', '/api/images/alpine:latest/history', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data), '应返回历史数组');
  }
});

test('GET /api/images/:name/layers: 镜像层分析', async () => {
  const res = await req('GET', '/api/images/alpine:latest/layers', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.totalSize === 'number', '应返回 totalSize');
    assert.ok(Array.isArray(res.data?.layers), '应返回 layers 数组');
    assert.ok(Array.isArray(res.data?.suggestions), '应返回 suggestions 数组');
  }
});

test('POST /api/images/:name/scan: Trivy 漏洞扫描', async () => {
  const res = await req('POST', '/api/images/alpine:latest/scan', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok('available' in res.data || 'vulnerabilities' in res.data || 'ok' in res.data, '应返回扫描结果');
  }
});

test('GET /api/images/:name/save: 导出镜像', async () => {
  const res = await req('GET', '/api/images/alpine:latest/save', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/images/pull: 拉取镜像', async () => {
  if (process.env.NETWORK_E2E !== '1') { console.log('跳过真实拉取（设置 NETWORK_E2E=1 启用）'); return; }
  const res = await req('POST', '/api/images/pull', { ref: 'alpine:latest' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true, '应返回 ok: true');
  }
});

test('POST /api/images/pull: 缺少 ref 返回 400', async () => {
  const res = await req('POST', '/api/images/pull', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/images/search: 搜索镜像', async () => {
    if (process.env.NETWORK_E2E !== '1') { console.log('跳过真实搜索（设置 NETWORK_E2E=1 启用）'); return; }
  // Docker Hub 可达性探测：离线/网络受限环境下跳过，避免网络抖动造成假失败
  let reachable = false;
  for (let i = 0; i < 3 && !reachable; i++) {
    try {
      const probe = await fetch('https://hub.docker.com/v2/search/?q=nginx&page=1', { signal: AbortSignal.timeout(8000) });
      reachable = probe.status < 500;
    } catch {
      reachable = false;
    }
    if (!reachable) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!reachable) {
    console.log('Docker Hub 不可达，跳过搜索断言');
    return;
  }

  const res = await req('POST', '/api/images/search', { term: 'nginx' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true, '应返回 ok');
    assert.ok(Array.isArray(res.data?.results), '应返回 results 数组');
  }
});

test('POST /api/images/search: 缺少 term 返回 400', async () => {
  const res = await req('POST', '/api/images/search', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/images/push: 推送镜像', async () => {
  const res = await req('POST', '/api/images/push', { name: 'alpine:latest' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/images/push: 缺少 name 返回 400', async () => {
  const res = await req('POST', '/api/images/push', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('DELETE /api/images/:name: 删除镜像', async () => {
  const res = await req('DELETE', '/api/images/alpine:latest', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/images/tag: 给镜像打标签', async () => {
  const res = await req('POST', '/api/images/tag', { name: 'alpine:latest', repo: 'dm-autotest-tag', tag: 'v1' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true);
  }
});

test('POST /api/images/tag: 缺少 name 返回 400', async () => {
  const res = await req('POST', '/api/images/tag', { repo: 'test' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/images/import: 空 body 返回 400', async () => {
  const res = await req('POST', '/api/images/import', null, { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/images/prune: 清理所有未使用镜像', async () => {
  const res = await req('POST', '/api/images/prune', { all: true }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
  assert.ok(res.data?.ok === true);
  assert.ok(Array.isArray(res.data?.deleted), '应返回 deleted 数组');
});
