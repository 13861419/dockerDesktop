/**
 * GitOps 定时同步单元测试（1.77.0）：三种平台的最新 commit API 解析
 */
import { test } from 'node:test';
import assert = require('node:assert');
import { fetchLatestCommit } from '../src/gitops';

const TARGET = { provider: 'github' as const, apiBase: 'https://api.github.com', owner: 'a', repo: 'b', fullPath: 'a/b' };

test('fetchLatestCommit: GitHub commit 对象解析（sha + 首行 message）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    assert.ok(String(url).includes('/repos/a/b/commits/main'));
    return { ok: true, status: 200, json: async () => ({ sha: 'a1b2c3d4e5f6a7b8', commit: { message: 'fix: 端口冲突\n\n详细说明' } }) };
  }) as any;
  try {
    const c = await fetchLatestCommit(TARGET, 'main', 'tk');
    assert.strictEqual(c.sha, 'a1b2c3d4e5f6a7b8');
    assert.strictEqual(c.message, 'fix: 端口冲突');
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchLatestCommit: GitLab 返回 id + title', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ id: '0f1e2d3c4b5a6978', title: 'feat: 新增导出' }) })) as any;
  try {
    const c = await fetchLatestCommit({ ...TARGET, provider: 'gitlab', apiBase: 'https://git.example.com/api/v4' }, 'main', '');
    assert.strictEqual(c.sha, '0f1e2d3c4b5a6978');
    assert.strictEqual(c.message, 'feat: 新增导出');
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchLatestCommit: HTTP 非 2xx 抛出', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as any;
  try {
    await assert.rejects(fetchLatestCommit(TARGET, 'main', 'tk'), /403/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchLatestCommit: 无效 SHA 抛出（防注入）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ sha: 'not-a-sha; rm -rf /', commit: { message: 'x' } }) })) as any;
  try {
    await assert.rejects(fetchLatestCommit(TARGET, 'main', ''), /无效/);
  } finally {
    globalThis.fetch = orig;
  }
});
