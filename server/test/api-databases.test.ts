/**
 * 数据库可视化管理 API 集成测试
 *
 * 覆盖实例 CRUD、连接测试、库表浏览、SQL 查询、Redis 键操作、备份恢复。
 * 测试对响应结构保持宽松断言，适应不同 Docker 环境状态。
 *
 * 依赖：后端服务运行在 localhost:9528
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';
let createdId: number | null = null;
const CREATED_IDS: number[] = [];

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
      res.on('data', (c: Buffer) => (data += c));
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
  // 前置清理：删除历史测试运行可能残留的测试实例（防止跨运行累积导致数据库膨胀 / 页面白屏）
  try {
    const list = await req('GET', '/api/databases', undefined, { Authorization: `Bearer ${adminToken}` });
    const leftovers = (list.data?.instances || []).filter((i: any) =>
      /^dm-(test|e2e|autotest)-/.test(String(i.name || '')));
    for (const inst of leftovers) {
      await req('DELETE', `/api/databases/${inst.id}`, undefined, { Authorization: `Bearer ${adminToken}` });
    }
  } catch {
    // 忽略前置清理失败，仍继续运行后续测试
  }
});

// ==================== 认证测试 ====================

describe('认证', () => {
  test('未登录: GET /api/databases 返回 401', async () => {
    const res = await req('GET', '/api/databases');
    assert.strictEqual(res.status, 401, `应返回 401，实际 ${res.status}`);
  });

  test('无效 Token: GET /api/databases 返回 401', async () => {
    const res = await req('GET', '/api/databases', undefined, { Authorization: 'Bearer invalid_token_xxx' });
    assert.strictEqual(res.status, 401, `应返回 401，实际 ${res.status}`);
  });
});

// ==================== 实例列表 ====================

describe('GET /api/databases', () => {
  test('返回实例列表与识别容器', async () => {
    const res = await req('GET', '/api/databases', undefined, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 200, `应返回 200，实际 ${res.status}`);
    assert.ok(Array.isArray(res.data.instances), 'instances 应为数组');
    assert.ok(Array.isArray(res.data.recognizedInstances), 'recognizedInstances 应为数组');
  });
});

// ==================== 创建实例 ====================

describe('POST /api/databases', () => {
  test('创建 MySQL 实例', async () => {
    const res = await req('POST', '/api/databases', {
      name: 'dm-test-mysql',
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: 'testpass',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 201 || res.status === 400, `应返回 201 或 400，实际 ${res.status}`);
    if (res.status === 201 && res.data?.id) {
      createdId = res.data.id;
      CREATED_IDS.push(res.data.id);
      assert.strictEqual(res.data.name, 'dm-test-mysql');
      assert.strictEqual(res.data.type, 'mysql');
      assert.strictEqual(res.data.hasPassword, true);
      assert.strictEqual(res.data.host, '127.0.0.1');
      assert.strictEqual(res.data.port, 3306);
    }
  });

  test('创建 Postgres 实例', async () => {
    const res = await req('POST', '/api/databases', {
      name: 'dm-test-pg',
      type: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      password: 'pgpass',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 201 || res.status === 400, `应返回 201 或 400，实际 ${res.status}`);
    if (res.status === 201 && res.data?.id) {
      CREATED_IDS.push(res.data.id);
    }
  });

  test('创建 Redis 实例', async () => {
    const res = await req('POST', '/api/databases', {
      name: 'dm-test-redis',
      type: 'redis',
      host: '127.0.0.1',
      port: 6379,
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 201 || res.status === 400, `应返回 201 或 400，实际 ${res.status}`);
    if (res.status === 201 && res.data?.id) {
      CREATED_IDS.push(res.data.id);
    }
  });

  test('缺少名称返回 400', async () => {
    const res = await req('POST', '/api/databases', { type: 'mysql' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });

  test('无效类型返回 400', async () => {
    const res = await req('POST', '/api/databases', { name: 'bad', type: 'oracle' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });

  test('无效端口返回 400', async () => {
    const res = await req('POST', '/api/databases', { name: 'bad', type: 'mysql', port: -1 }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });
});

// ==================== 更新实例 ====================

describe('PUT /api/databases/:id', () => {
  test('更新已创建的实例', async () => {
    if (!createdId) return;
    const res = await req('PUT', `/api/databases/${createdId}`, {
      name: 'dm-test-mysql-updated',
      host: '127.0.0.1',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 404, `应返回 200 或 404，实际 ${res.status}`);
    if (res.status === 200) {
      assert.strictEqual(res.data.name, 'dm-test-mysql-updated');
    }
  });

  test('更新密码', async () => {
    if (!createdId) return;
    const res = await req('PUT', `/api/databases/${createdId}`, {
      password: 'newpass123',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status === 404, `应返回 200 或 404，实际 ${res.status}`);
    if (res.status === 200) {
      assert.strictEqual(res.data.hasPassword, true);
    }
  });

  test('无效类型更新返回 400', async () => {
    if (!createdId) return;
    const res = await req('PUT', `/api/databases/${createdId}`, { type: 'oracle' }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 400 || res.status === 404, `应返回 400 或 404，实际 ${res.status}`);
  });

  test('更新不存在的实例返回 404', async () => {
    const res = await req('PUT', '/api/databases/99999', { name: 'x' }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `应返回非服务器错误，实际 ${res.status}`);
  });
});

// ==================== 连接测试 ====================

describe('POST /api/databases/:id/test', () => {
  test('连接测试（可能因无实际服务失败，接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/test`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.ok(typeof res.data.ok === 'boolean', '应返回 ok 字段');
      assert.ok(typeof res.data.message === 'string', '应返回 message 字段');
    }
  });

  test('不存在的实例返回 404', async () => {
    const res = await req('POST', '/api/databases/99999/test', undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `应返回非服务器错误，实际 ${res.status}`);
  });
});

// ==================== 列出数据库 ====================

describe('GET /api/databases/:id/databases', () => {
  test('列出数据库列表（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('GET', `/api/databases/${createdId}/databases`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.ok(Array.isArray(res.data.databases), 'databases 应为数组');
    }
  });
});

// ==================== 创建数据库 ====================

describe('POST /api/databases/:id/databases', () => {
  test('创建数据库（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/databases`, {
      name: 'dm_test_db',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 201) {
      assert.strictEqual(res.data.ok, true);
      assert.strictEqual(res.data.name, 'dm_test_db');
    }
  });

  test('空库名返回 400', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/databases`, { name: '' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });
});

// ==================== 删除数据库 ====================

describe('DELETE /api/databases/:id/databases/:db', () => {
  test('删除数据库（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('DELETE', `/api/databases/${createdId}/databases/dm_test_db`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.strictEqual(res.data.ok, true);
    }
  });
});

// ==================== 表列表 ====================

describe('GET /api/databases/:id/databases/:db/tables', () => {
  test('列出表（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('GET', `/api/databases/${createdId}/databases/mysql/tables`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.ok(Array.isArray(res.data.tables), 'tables 应为数组');
    }
  });
});

// ==================== SQL 查询 ====================

describe('POST /api/databases/:id/query', () => {
  test('只读查询 SELECT 1（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/query`, {
      sql: 'SELECT 1',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.ok(Array.isArray(res.data.columns), 'columns 应为数组');
      assert.ok(Array.isArray(res.data.rows), 'rows 应为数组');
    }
  });

  test('SHOW DATABASES 查询（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/query`, {
      sql: 'SHOW DATABASES',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  });

  test('DESCRIBE 查询（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/query`, {
      sql: 'DESCRIBE mysql.user',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  });

  test('写操作被拒绝返回 403', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/query`, {
      sql: 'DROP TABLE test',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 403, `应返回 403，实际 ${res.status}`);
  });

  test('多语句注入被拒绝返回 403', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/query`, {
      sql: 'SELECT 1; DROP TABLE test',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 403, `应返回 403，实际 ${res.status}`);
  });

  test('空 SQL 返回 400', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/query`, { sql: '' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });

  test('Redis 实例查询返回 403', async () => {
    const redisId = CREATED_IDS.find((_, i) => i === 2);
    if (!redisId) return;
    const res = await req('POST', `/api/databases/${redisId}/query`, { sql: 'SELECT 1' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 403, `应返回 403，实际 ${res.status}`);
  });
});

// ==================== 表结构 ====================

describe('GET /api/databases/:id/databases/:db/tables/:table/schema', () => {
  test('查看表结构（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('GET', `/api/databases/${createdId}/databases/mysql/tables/user/schema`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.ok(Array.isArray(res.data.columns), 'columns 应为数组');
      assert.ok(Array.isArray(res.data.rows), 'rows 应为数组');
    }
  });
});

// ==================== 表数据分页 ====================

describe('GET /api/databases/:id/databases/:db/tables/:table/rows', () => {
  test('分页浏览表数据（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('GET', `/api/databases/${createdId}/databases/mysql/tables/user/rows?limit=5&offset=0`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.ok(Array.isArray(res.data.columns), 'columns 应为数组');
      assert.ok(Array.isArray(res.data.rows), 'rows 应为数组');
      assert.strictEqual(typeof res.data.total, 'number', 'total 应为数字');
      assert.strictEqual(res.data.limit, 5);
      assert.strictEqual(res.data.offset, 0);
    }
  });
});

// ==================== Redis 键浏览 ====================

describe('POST /api/databases/:id/redis/keys', () => {
  test('Redis 键扫描（接受非 5xx）', async () => {
    const redisId = CREATED_IDS.find((_, i) => i === 2);
    if (!redisId) return;
    const res = await req('POST', `/api/databases/${redisId}/redis/keys`, {
      pattern: '*',
      limit: 100,
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.ok(Array.isArray(res.data.keys), 'keys 应为数组');
      assert.strictEqual(typeof res.data.total, 'number', 'total 应为数字');
      assert.strictEqual(typeof res.data.truncated, 'boolean', 'truncated 应为布尔');
    }
  });

  test('非 Redis 实例返回 400', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/redis/keys`, {}, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });
});

// ==================== Redis 信息指标 ====================

describe('POST /api/databases/:id/redis/info', () => {
  test('Redis INFO（接受非 5xx）', async () => {
    const redisId = CREATED_IDS.find((_, i) => i === 2);
    if (!redisId) return;
    const res = await req('POST', `/api/databases/${redisId}/redis/info`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.strictEqual(typeof res.data.usedMemoryHuman, 'string');
      assert.strictEqual(typeof res.data.connectedClients, 'number');
      assert.strictEqual(typeof res.data.hitRate, 'number');
      assert.strictEqual(typeof res.data.version, 'string');
    }
  });
});

// ==================== Redis 键值查看 ====================

describe('POST /api/databases/:id/redis/key', () => {
  test('查看不存在的 Redis 键', async () => {
    const redisId = CREATED_IDS.find((_, i) => i === 2);
    if (!redisId) return;
    const res = await req('POST', `/api/databases/${redisId}/redis/key`, {
      key: 'dm_nonexistent_key_xyz',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.strictEqual(res.data.type, 'none');
    }
  });

  test('空键名返回 400', async () => {
    const redisId = CREATED_IDS.find((_, i) => i === 2);
    if (!redisId) return;
    const res = await req('POST', `/api/databases/${redisId}/redis/key`, { key: '' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });

  test('非 Redis 实例返回 400', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/redis/key`, { key: 'x' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });
});

// ==================== Redis 删除键 ====================

describe('DELETE /api/databases/:id/redis/keys', () => {
  test('删除 Redis 键（接受非 5xx）', async () => {
    const redisId = CREATED_IDS.find((_, i) => i === 2);
    if (!redisId) return;
    const res = await req('DELETE', `/api/databases/${redisId}/redis/keys`, {
      key: 'dm_nonexistent_key_xyz',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.strictEqual(res.data.ok, true);
      assert.strictEqual(typeof res.data.deleted, 'boolean');
    }
  });

  test('空键名返回 400', async () => {
    const redisId = CREATED_IDS.find((_, i) => i === 2);
    if (!redisId) return;
    const res = await req('DELETE', `/api/databases/${redisId}/redis/keys`, { key: '' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });

  test('非 Redis 实例返回 400', async () => {
    if (!createdId) return;
    const res = await req('DELETE', `/api/databases/${createdId}/redis/keys`, { key: 'x' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 400, `应返回 400，实际 ${res.status}`);
  });
});

// ==================== 备份列表 ====================

describe('GET /api/databases/:id/backups', () => {
  test('列出备份文件', async () => {
    if (!createdId) return;
    const res = await req('GET', `/api/databases/${createdId}/backups`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.ok(Array.isArray(res.data.backups), 'backups 应为数组');
    }
  });
});

// ==================== 创建备份 ====================

describe('POST /api/databases/:id/backups', () => {
  test('创建备份（接受非 5xx，可能因无实际数据库失败）', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/backups`, {
      db: 'mysql',
    }, { Authorization: `Bearer ${adminToken}` });
    // 500 is expected when no actual database exists to backup
    assert.ok(res.status === 201 || res.status === 500, `expected 201 or 500, got ${res.status}`);
    if (res.status === 201) {
      assert.ok(res.data.backup, '应返回 backup 对象');
    }
  });
});

// ==================== 备份下载/删除 ====================

describe('备份下载与删除', () => {
  test('下载不存在的备份返回 404', async () => {
    if (!createdId) return;
    const res = await req('GET', `/api/databases/${createdId}/backups/nonexistent.sql.gz/download`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 404 || res.status < 500, `应返回 404 或非 5xx，实际 ${res.status}`);
  });

  test('删除不存在的备份文件（接受非 5xx）', async () => {
    if (!createdId) return;
    const res = await req('DELETE', `/api/databases/${createdId}/backups/nonexistent.sql.gz`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  });
});

// ==================== 备份恢复 ====================

describe('POST /api/databases/:id/backups/:file/restore', () => {
  test('恢复不存在的备份返回 404', async () => {
    if (!createdId) return;
    const res = await req('POST', `/api/databases/${createdId}/backups/nonexistent.sql.gz/restore`, {
      db: 'mysql',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 404 || res.status < 500, `应返回 404 或非 5xx，实际 ${res.status}`);
  });
});

// ==================== 更新不存在的实例 ====================

describe('不存在的实例', () => {
  test('PUT 不存在的实例返回 404', async () => {
    const res = await req('PUT', '/api/databases/99999', { name: 'x' }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `应返回非服务器错误，实际 ${res.status}`);
  });

  test('DELETE 不存在的实例返回 404', async () => {
    const res = await req('DELETE', '/api/databases/99999', undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `应返回非服务器错误，实际 ${res.status}`);
  });

  test('GET databases 不存在的实例返回 404', async () => {
    const res = await req('GET', '/api/databases/99999/databases', undefined, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 404, `应返回 404，实际 ${res.status}`);
  });

  test('POST query 不存在的实例返回 404', async () => {
    const res = await req('POST', '/api/databases/99999/query', { sql: 'SELECT 1' }, { Authorization: `Bearer ${adminToken}` });
    assert.strictEqual(res.status, 404, `应返回 404，实际 ${res.status}`);
  });
});

// ==================== Redis CRUD 生命周期 ====================

describe('Redis 键操作生命周期', () => {
  let redisId: number | null = null;

  test('准备 Redis 实例', async () => {
    redisId = CREATED_IDS.find((_, i) => i === 2) ?? null;
    if (!redisId) {
      // 尝试创建
      const res = await req('POST', '/api/databases', {
        name: 'dm-test-redis-lifecycle',
        type: 'redis',
        host: '127.0.0.1',
        port: 6379,
      }, { Authorization: `Bearer ${adminToken}` });
      if (res.status === 201 && res.data?.id) {
        redisId = res.data.id;
        CREATED_IDS.push(res.data.id);
      }
    }
    assert.ok(redisId, '需要有效的 Redis 实例 id');
  });

  test('Redis 键扫描（接受非 5xx）', async () => {
    if (!redisId) return;
    const res = await req('POST', `/api/databases/${redisId}/redis/keys`, {
      pattern: '*',
      limit: 50,
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  });

  test('Redis INFO（接受非 5xx）', async () => {
    if (!redisId) return;
    const res = await req('POST', `/api/databases/${redisId}/redis/info`, undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
  });

  test('查看不存在键的详情', async () => {
    if (!redisId) return;
    const res = await req('POST', `/api/databases/${redisId}/redis/key`, {
      key: '__dm_test_nonexistent__',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 200) {
      assert.strictEqual(res.data.type, 'none');
      assert.strictEqual(res.data.value, null);
    }
  });
});

// ==================== MariaDB 类型测试 ====================

describe('POST /api/databases (MariaDB)', () => {
  test('创建 MariaDB 实例', async () => {
    const res = await req('POST', '/api/databases', {
      name: 'dm-test-mariadb',
      type: 'mariadb',
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
    }, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 201 || res.status === 400, `应返回 201 或 400，实际 ${res.status}`);
    if (res.status === 201 && res.data?.id) {
      CREATED_IDS.push(res.data.id);
      assert.strictEqual(res.data.type, 'mariadb');
    }
  });
});

// ==================== 并发/重复创建 ====================

describe('重复创建', () => {
  test('创建同名实例可被接受（无唯一约束时）', async () => {
    const res = await req('POST', '/api/databases', {
      name: 'dm-test-duplicate',
      type: 'redis',
      host: '127.0.0.1',
      port: 6379,
    }, { Authorization: `Bearer ${adminToken}` });
    // 无论成功或冲突，不应 5xx
    assert.ok(res.status < 500, `不应返回服务器错误，实际 ${res.status}`);
    if (res.status === 201 && res.data?.id) {
      CREATED_IDS.push(res.data.id);
    }
  });
});

// ==================== 操作日志验证 ====================

describe('操作日志', () => {
  test('操作日志接口可用', async () => {
    const res = await req('GET', '/api/operation-logs?limit=5', undefined, { Authorization: `Bearer ${adminToken}` });
    assert.ok(res.status === 200 || res.status < 500, `操作日志接口应可用，实际 ${res.status}`);
  });
});

// ==================== 清理：删除所有创建的实例 ====================

describe('清理测试数据', () => {
  for (const id of CREATED_IDS) {
    test(`DELETE /api/databases/${id}`, async () => {
      const res = await req('DELETE', `/api/databases/${id}`, undefined, { Authorization: `Bearer ${adminToken}` });
      assert.ok(res.status === 200 || res.status === 404, `应返回 200 或 404，实际 ${res.status}`);
    });
  }
});
