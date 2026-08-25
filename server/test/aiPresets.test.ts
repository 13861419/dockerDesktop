import { test } from 'node:test';
import assert from 'node:assert';
import { AI_PRESETS, getPresetById } from '../src/aiPresets';

test('预置清单完整：本地 3 + 三方 5', () => {
  const ids = AI_PRESETS.map((p) => p.id);
  assert.deepStrictEqual(ids.sort(), [
    'custom', 'dashscope', 'deepseek', 'gateway', 'lmstudio', 'moonshot', 'ollama', 'openai', 'zhipu',
  ].sort());
});

test('预置 baseUrl 全部通过 SSRF 白名单', () => {
  const ok = (u: string) => u.startsWith('https://') || u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1') || u.startsWith('http://[::1]');
  for (const p of AI_PRESETS) {
    if (p.id === 'custom') continue;
    assert.ok(ok(p.baseUrl), `${p.id} 的 baseUrl 非法: ${p.baseUrl}`);
  }
});

test('local/cloud 分组正确', () => {
  const local = AI_PRESETS.filter((p) => p.kind === 'local');
  assert.deepStrictEqual(local.map((p) => p.id).sort(), ['gateway', 'lmstudio', 'ollama']);
});

test('getPresetById 命中与未命中', () => {
  assert.strictEqual(getPresetById('openai')?.name, 'OpenAI');
  assert.strictEqual(getPresetById('nope'), undefined);
});
