/**
 * CI 状态门禁单元测试（1.75.0）：仓库解析、SHA 校验、GitHub 聚合与回退逻辑
 */
import { test } from 'node:test';
import assert = require('node:assert');
import { parseCiTarget, isCommitSha, fetchCiState } from '../src/ciGate';

test('parseCiTarget: github.com 自动识别为 GitHub 并指向 api.github.com', () => {
  const t = parseCiTarget('https://github.com/acme/app.git', null, null)!;
  assert.strictEqual(t.provider, 'github');
  assert.strictEqual(t.apiBase, 'https://api.github.com');
  assert.strictEqual(t.owner, 'acme');
  assert.strictEqual(t.repo, 'app');
});

test('parseCiTarget: ssh 形式的自建 Gitea 按 gitea 解析并携带 /api/v1', () => {
  const t = parseCiTarget('git@git.example.com:acme/app.git', null, null)!;
  assert.strictEqual(t.provider, 'gitea');
  assert.strictEqual(t.apiBase, 'https://git.example.com/api/v1');
  assert.strictEqual(t.owner, 'acme');
  assert.strictEqual(t.repo, 'app');
});

test('parseCiTarget: 显式 provider 与 API 地址覆盖', () => {
  const t = parseCiTarget('https://git.corp.cn/acme/app', 'gitlab', 'https://git.corp.cn/api/v4')!;
  assert.strictEqual(t.provider, 'gitlab');
  assert.strictEqual(t.apiBase, 'https://git.corp.cn/api/v4');
});

test('parseCiTarget: 无法解析的 URL 返回 null', () => {
  assert.strictEqual(parseCiTarget('not a url', null, null), null);
});

test('isCommitSha: 仅接受 hex 7-40 位', () => {
  assert.strictEqual(isCommitSha('a1b2c3d'), true);
  assert.strictEqual(isCommitSha('A1B2C3D4E5'), true);
  assert.strictEqual(isCommitSha('abc'), false);
  assert.strictEqual(isCommitSha('xyz!'), false);
  assert.strictEqual(isCommitSha('a1b2c3d; rm -rf /'), false);
});

test('fetchCiState: GitHub check-runs 聚合——全部 success → success', async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ check_runs: [{ conclusion: 'success' }, { conclusion: 'success' }] }) };
  }) as any;
  try {
    const state = await fetchCiState({ provider: 'github', apiBase: 'https://api.github.com', owner: 'a', repo: 'b', fullPath: 'a/b' }, 'a1b2c3d', 'tk');
    assert.strictEqual(state, 'success');
    assert.ok(calls[0].includes('/check-runs'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchCiState: GitHub check-runs 任一失败 → failure', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ check_runs: [{ conclusion: 'success' }, { conclusion: 'failure' }] }) })) as any;
  try {
    const state = await fetchCiState({ provider: 'github', apiBase: 'https://api.github.com', owner: 'a', repo: 'b', fullPath: 'a/b' }, 'a1b2c3d', '');
    assert.strictEqual(state, 'failure');
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchCiState: GitHub check-runs 404 时回退 combined status', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith('/check-runs')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ state: 'failure' }) };
  }) as any;
  try {
    const state = await fetchCiState({ provider: 'github', apiBase: 'https://api.github.com', owner: 'a', repo: 'b', fullPath: 'a/b' }, 'a1b2c3d', '');
    assert.strictEqual(state, 'failure');
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchCiState: Gitea commit status 映射', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ status: 'success' }) })) as any;
  try {
    const state = await fetchCiState({ provider: 'gitea', apiBase: 'https://git.example.com/api/v1', owner: 'a', repo: 'b', fullPath: 'a/b' }, 'a1b2c3d', 'tk');
    assert.strictEqual(state, 'success');
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchCiState: GitLab statuses 聚合——任一 failed → failure', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => [{ status: 'success' }, { status: 'failed' }] })) as any;
  try {
    const state = await fetchCiState({ provider: 'gitlab', apiBase: 'https://git.example.com/api/v4', owner: 'a', repo: 'b', fullPath: 'a/b' }, 'a1b2c3d', 'tk');
    assert.strictEqual(state, 'failure');
  } finally {
    globalThis.fetch = orig;
  }
});
