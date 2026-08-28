/**
 * 数据保留自动清理 API 集成测试
 *
 * 覆盖：
 *  1. operation_logs 超过 logs.retentionDays（默认 90 天）自动清理
 *  2. ai_usage 超过 ai.usage.retentionDays（默认 30 天）自动清理
 *  3. ai_inspections 超过 ai.inspection.retentionDays（默认 30 天）自动清理
 *  4. 保留天数设为 0 时永久保留（不过期）
 *
 * 依赖：后端服务运行在 localhost:9528；测试直接改写 dev 库（backdate + 重置节流键）。
 * 注意：套件并行运行时，configTransfer 导入会把导出文件中的 settings 键值整表写回，
 * 可能覆盖本测试写入的保留天数 —— 因此关键断言前都用直接 DB 写入重申期望值。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const BASE = process.env.API_BASE || 'http://localhost:9528';
let adminToken = '';

const DB_PATH = path.join(__dirname, '../../data/docker-manager.db');
const db = new DatabaseSync(DB_PATH);
// busy_timeout 默认 0，并行测试多连接写入会瞬时锁冲突 —— 显式放宽
db.exec('PRAGMA busy_timeout = 30000;');

const OLD_TS = Date.now() - 400 * 86400_000; // 400 天前，任何默认保留策略下都应被清理

// 表 -> (保留天数设置键, 节流键, 默认保留天数)
const TARGETS: Record<string, { settingKey: string; throttleKey: string; defaultDays: number }> = {
  operation_logs: { settingKey: 'logs.retentionDays', throttleKey: 'logs.lastPurgeAt', defaultDays: 90 },
  ai_usage: { settingKey: 'ai.usage.retentionDays', throttleKey: 'ai.usage.lastPurgeAt', defaultDays: 30 },
  ai_inspections: { settingKey: 'ai.inspection.retentionDays', throttleKey: 'ai.inspection.lastPurgeAt', defaultDays: 30 },
};

const TRIGGERS: Record<string, string> = {
  operation_logs: '/api/operation-logs',
  ai_usage: '/api/ai/usage',
  ai_inspections: '/api/ai/inspection/list',
};

function resetThrottle(throttleKey: string): void {
  db.prepare('DELETE FROM setting WHERE key = ?').run(throttleKey);
}

/** 直接写保留天数（绕过设置 API，避免与并行文件的导入/删除竞争） */
function setRetentionDays(settingKey: string, days: number): void {
  db.prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)').run(settingKey, String(days));
}

function countById(table: string, id: number): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE id = ?`).get(id) as { c: number }).c;
}

/** 插入一条 400 天前的旧行，返回自增 id */
function insertOld(table: string): number {
  if (table === 'operation_logs') {
    const r = db
      .prepare(
        `INSERT INTO operation_logs (username, action, target_type, target_name, detail, success, created_at)
         VALUES ('retention-test', 'test.purge', 'test', 'retention-old', NULL, 1, ?)`,
      )
      .run(OLD_TS);
    return Number(r.lastInsertRowid);
  }
  if (table === 'ai_usage') {
    const r = db
      .prepare(
        `INSERT INTO ai_usage
         (profile_id, provider, model, tool, prompt_tokens, completion_tokens, total_tokens,
          prompt_chars, completion_chars, duration_ms, success, error_message, username, created_at)
         VALUES (NULL, 'retention-test', 'retention-test', 'test', 1, 1, 2, 1, 1, 0, 1, '', 'retention-test', ?)`,
      )
      .run(OLD_TS);
    return Number(r.lastInsertRowid);
  }
  const r = db
    .prepare(`INSERT INTO ai_inspections (status, summary, snapshot, created_at) VALUES (0, 'retention-test', '', ?)`)
    .run(OLD_TS);
  return Number(r.lastInsertRowid);
}

function cleanLeftovers(): void {
  db.prepare("DELETE FROM operation_logs WHERE username = 'retention-test'").run();
  db.prepare("DELETE FROM ai_usage WHERE username = 'retention-test'").run();
  db.prepare("DELETE FROM ai_inspections WHERE summary = 'retention-test'").run();
  for (const t of Object.values(TARGETS)) {
    db.prepare('DELETE FROM setting WHERE key = ?').run(t.throttleKey);
    db.prepare('DELETE FROM setting WHERE key = ?').run(t.settingKey);
  }
}

/**
 * 触发清理并等待旧行消失。
 * 套件并行运行时，其它测试文件对同一端点的请求可能先消耗掉节流窗口，
 * configTransfer 导入也可能覆盖保留天数设置 —— 每轮重试前重置节流键并重申保留天数。
 */
async function purgeAndAssert(table: string, attempts = 6): Promise<void> {
  const t = TARGETS[table];
  for (let i = 0; i < attempts; i++) {
    setRetentionDays(t.settingKey, t.defaultDays);
    resetThrottle(t.throttleKey);
    const r = await req('GET', TRIGGERS[table]);
    assert.strictEqual(r.status, 200);
    if (lastRowCount(table) === 0) return;
  }
  assert.fail(`保留清理未生效（${table}，重试 ${attempts} 次）`);
}

/** 该表内是否还有本次测试的旧行 */
function lastRowCount(table: string): number {
  return countById(table, lastId[table]);
}

const lastId: Record<string, number> = {};

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
  // 预清理：治愈此前异常中断的运行留下的残留数据
  cleanLeftovers();
});

after(() => {
  // �条清理独立容错，确保尽量多清理成功
  try { cleanLeftovers(); } catch { /* ignore */ }
});

test('operation_logs 超过保留天数（默认 90 天）自动清理', async () => {
  const id = insertOld('operation_logs');
  lastId.operation_logs = id;
  await purgeAndAssert('operation_logs');
});

test('ai_usage 超过保留天数（默认 30 天）自动清理', async () => {
  const id = insertOld('ai_usage');
  lastId.ai_usage = id;
  await purgeAndAssert('ai_usage');
});

test('ai_inspections 超过保留天数（默认 30 天）自动清理', async () => {
  const id = insertOld('ai_inspections');
  lastId.ai_inspections = id;
  await purgeAndAssert('ai_inspections');
});

test('保留天数设为 0 时永久保留（不过期）', async () => {
  setRetentionDays('logs.retentionDays', 0);
  try {
    const id = insertOld('operation_logs');
    lastId.operation_logs = id;
    resetThrottle('logs.lastPurgeAt');
    const r = await req('GET', TRIGGERS.operation_logs);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(countById('operation_logs', id), 1, '保留天数为 0 时不应清理');
    // 恢复默认并清掉本条测试数据
    db.prepare('DELETE FROM setting WHERE key = ?').run('logs.retentionDays');
    db.prepare('DELETE FROM operation_logs WHERE id = ?').run(id);
    delete lastId.operation_logs;
  } finally {
    db.prepare('DELETE FROM setting WHERE key = ?').run('logs.retentionDays');
  }
});
