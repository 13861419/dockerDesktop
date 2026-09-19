/**
 * CI 运行记录只读看板单元测试（1.79.0）：三种平台的 runs 解析与状态归一
 */
import { test } from 'node:test';
import assert = require('node:assert');
import { fetchCiRuns } from '../src/ciGate';

const TARGET = { provider: 'github' as const, apiBase: 'https://api.github.com', owner: 'a', repo: 'b', fullPath: 'a/b' };

test('fetchCiRuns: GitHub workflow_runs 解析（conclusion → 状态）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    assert.ok(String(url).includes('/actions/runs?per_page=10'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        workflow_runs: [
          { id: 1, name: 'Build', head_sha: 'a1b2c3d4e5f6', conclusion: 'success', html_url: 'https://x/1', run_started_at: '2026-09-19T00:00:00Z' },
          { id: 2, name: 'Build', head_sha: 'b2c3d4e5f6a7', conclusion: null, status: 'in_progress', html_url: 'https://x/2' },
          { id: 3, name: 'Build', head_sha: 'c3d4e5f6a7b8', conclusion: 'failure', html_url: 'https://x/3' },
        ],
      }),
    };
  }) as any;
  try {
    const runs = await fetchCiRuns(TARGET, 'tk');
    assert.strictEqual(runs.length, 3);
    assert.strictEqual(runs[0].status, 'success');
    assert.strictEqual(runs[1].status, 'pending');
    assert.strictEqual(runs[2].status, 'failure');
    assert.strictEqual(runs[0].sha, 'a1b2c3d4e5f6');
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchCiRuns: GitLab pipelines 解析（status 直读）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: 9, sha: 'd4e5f6a7b8c9', ref: 'main', status: 'failed', web_url: 'https://gl/9', created_at: '2026-09-19T01:00:00Z' }],
  })) as any;
  try {
    const runs = await fetchCiRuns({ ...TARGET, provider: 'gitlab', apiBase: 'https://git.example.com/api/v4' }, '');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].status, 'failure');
    assert.strictEqual(runs[0].title, '#9 main');
    assert.strictEqual(runs[0].url, 'https://gl/9');
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchCiRuns: HTTP 非 2xx 抛出', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any;
  try {
    await assert.rejects(fetchCiRuns(TARGET, 'bad'), /401/);
  } finally {
    globalThis.fetch = orig;
  }
});
