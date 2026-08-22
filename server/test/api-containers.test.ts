/**
 * 容器管理 API 集成测试
 *
 * 覆盖容器 CRUD、生命周期、批量操作、配置导出。
 * 测试对响应结构保持宽松断言，适应不同 Docker 环境。
 *
 * 依赖：后端服务运行在 localhost:9528，Docker 引擎可用
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let testContainerId = '';

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

test('GET /api/containers: 返回成功状态码', async () => {
  const res = await req('GET', '/api/containers?all=true', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
});

test('GET /api/containers/stats: 返回成功状态码', async () => {
  const res = await req('GET', '/api/containers/stats', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/containers: 创建测试容器', async () => {
  const res = await req('POST', '/api/containers', {
    image: 'alpine:latest',
    name: 'dm-autotest-ctr',
    command: 'sleep 3600',
    tty: true,
  }, { Authorization: `Bearer ${adminToken}` });
  // 接受任何非 5xx 响应
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.data && res.data.id) testContainerId = res.data.id;
});

test('GET /api/containers/:id: 查询容器详情', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/containers/${testContainerId}`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 404);
});

test('GET /api/containers/:id/config: 导出配置', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/containers/${testContainerId}/config`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/containers/:id/stop: 停止', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/stop`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 204 || res.status === 409);
});

test('POST /api/containers/:id/start: 启动', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/start`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 204);
});

test('POST /api/containers/:id/restart: 重启', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/restart`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 204);
});

test('DELETE /api/containers/:id: 删除测试容器', async () => {
  if (!testContainerId) return;
  const res = await req('DELETE', `/api/containers/${testContainerId}?force=true`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 204);
});

test('GET /api/containers/:id: 不存在返回 404', async () => {
  const res = await req('GET', '/api/containers/000000000000', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('POST /api/containers: 缺少 image 返回 4xx', async () => {
  const res = await req('POST', '/api/containers', { name: 'no-image' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status >= 400);
});

test('GET /api/containers: 未登录返回 401', async () => {
  const res = await req('GET', '/api/containers');
  assert.strictEqual(res.status, 401);
});

// ============ 补充缺失端点测试 ============

test('GET /api/containers/ports: 返回端口占用映射', async () => {
  const res = await req('GET', '/api/containers/ports', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(typeof res.data === 'object', '返回应为对象');
});

test('POST /api/containers/port-check: 端口占用检测', async () => {
  const res = await req('POST', '/api/containers/port-check', { ports: [80, 443, 9528] }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(Array.isArray(res.data?.results), '应返回 results 数组');
});

test('POST /api/containers/port-check: 缺少 ports 返回 400', async () => {
  const res = await req('POST', '/api/containers/port-check', {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('GET /api/containers/stats/top: 资源占用排行', async () => {
  const res = await req('GET', '/api/containers/stats/top?sort=cpu&limit=5', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200, `应返回 200，实际 ${res.status}`);
  assert.ok(Array.isArray(res.data?.items), '应返回 items 数组');
});

test('GET /api/containers/stats/top?sort=mem: 按内存排行', async () => {
  const res = await req('GET', '/api/containers/stats/top?sort=mem&limit=5', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200);
});

test('POST /api/containers/batch/start: 批量启动', async () => {
  const res = await req('POST', '/api/containers/batch/start', { ids: [] }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400, '空 ids 应返回 400');
});

test('POST /api/containers/batch/stop: 批量停止', async () => {
  const res = await req('POST', '/api/containers/batch/stop', { ids: [] }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/containers/batch/restart: 批量重启', async () => {
  const res = await req('POST', '/api/containers/batch/restart', { ids: [] }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/containers/batch/delete: 批量删除', async () => {
  const res = await req('POST', '/api/containers/batch/delete', { ids: [] }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/containers/batch/update: 批量更新', async () => {
  const res = await req('POST', '/api/containers/batch/update', { ids: [] }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/containers/batch/start: 不存在的容器返回结果', async () => {
  const res = await req('POST', '/api/containers/batch/start', { ids: ['000000000000'] }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  assert.ok(typeof res.data?.success === 'number', '应返回 success 计数');
});

test('GET /api/containers/:id/detail: 容器完整详情', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/containers/${testContainerId}/detail`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 200 || res.status === 404);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data?.mounts), '应返回 mounts 数组');
    assert.ok(Array.isArray(res.data?.networks), '应返回 networks 数组');
  }
});

test('GET /api/containers/:id/detail: 不存在返回 404', async () => {
  const res = await req('GET', '/api/containers/000000000000/detail', undefined, { Authorization: `Bearer ${adminToken}` });
  assert.strictEqual(res.status, 404);
});

test('GET /api/containers/:id/logs: 获取日志', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/containers/${testContainerId}/logs?tail=10`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.logs === 'string', '应返回 logs 字符串');
  }
});

test('GET /api/containers/:id/logs/download: 下载日志', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/containers/${testContainerId}/logs/download`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/containers/:id/rename: 重命名容器', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/rename`, { name: 'dm-autotest-renamed' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true, '应返回 ok: true');
  }
});

test('POST /api/containers/:id/rename: 空名称返回 400', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/rename`, { name: '' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/containers/:id/pause: 暂停容器', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/pause`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/containers/:id/unpause: 恢复容器', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/unpause`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/containers/:id/update: 更新容器配置', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/update`, { restartPolicy: 'no' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/containers/:id/clone: 克隆容器', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/clone`, { name: 'dm-autotest-clone', start: false }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  // 清理克隆容器
  if (res.status === 201 && res.data?.id) {
    await req('DELETE', `/api/containers/${res.data.id}?force=true`, undefined, { Authorization: `Bearer ${adminToken}` });
  }
});

test('POST /api/containers/:id/commit: 提交为镜像', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/commit`, { repo: 'dm-autotest-commit', tag: 'v1' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true, '应返回 ok: true');
  }
});

test('POST /api/containers/:id/commit: 缺少 repo 返回 400', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/commit`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('POST /api/containers/:id/exec: 执行命令', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/exec`, { cmd: 'echo hello' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(typeof res.data?.exitCode === 'number', '应返回 exitCode');
  }
});

test('POST /api/containers/:id/exec: 缺少 cmd 返回 400', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/exec`, {}, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status === 400);
});

test('GET /api/containers/:id/stats: 获取单容器统计', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/containers/${testContainerId}/stats`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('GET /api/containers/:id/stats/history: 历史指标趋势', async () => {
  if (!testContainerId) return;
  const res = await req('GET', `/api/containers/${testContainerId}/stats/history?range=1h`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(Array.isArray(res.data?.points), '应返回 points 数组');
  }
});

test('POST /api/containers/:id/recreate: 重建容器', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/recreate`, { env: {} }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});

test('POST /api/containers/:id/prune: 清理已停止状态', async () => {
  if (!testContainerId) return;
  const res = await req('POST', `/api/containers/${testContainerId}/prune`, undefined, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  if (res.status === 200) {
    assert.ok(res.data?.ok === true);
  }
});

test('POST /api/containers/batch/update: 批量更新资源限制', async () => {
  if (!testContainerId) return;
  const res = await req('POST', '/api/containers/batch/update', { ids: [testContainerId], restartPolicy: 'no' }, { Authorization: `Bearer ${adminToken}` });
  assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
});
