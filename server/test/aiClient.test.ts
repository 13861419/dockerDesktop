/**
 * AI 客户端（aiClient）纯函数单元测试（node:test）
 * 覆盖：buildSystemPrompt / buildChatBody / parseChatResponse（不触 DB，纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { buildSystemPrompt, buildChatBody, parseChatResponse, profileToAiConfig } from '../src/aiClient';

const cfg = {
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  systemPrompt: '',
  timeoutMs: 60000,
};

test('buildSystemPrompt 组装 system + 上下文 + user', () => {
  const msgs = buildSystemPrompt(cfg, '容器上下文', '为什么 OOM？');
  assert.ok(msgs.length >= 2);
  assert.strictEqual(msgs[0].role, 'system');
  // 有上下文时第二个消息也是 system（环境上下文）
  if (msgs.length === 3) assert.strictEqual(msgs[1].role, 'system');
  const last = msgs[msgs.length - 1];
  assert.strictEqual(last.role, 'user');
  assert.ok(last.content.includes('为什么 OOM？'));
});

test('buildChatBody 生成 OpenAI 兼容请求体', () => {
  const body = buildChatBody('gpt-4o-mini', [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(body.model, 'gpt-4o-mini');
  assert.strictEqual(body.stream, false);
  assert.strictEqual(body.messages.length, 1);
});

test('parseChatResponse 提取 assistant 文本', () => {
  const reply = parseChatResponse({ choices: [{ message: { role: 'assistant', content: '你好' } }] });
  assert.strictEqual(reply, '你好');
  // 空 choices
  assert.strictEqual(parseChatResponse({ choices: [] }), '');
  // 非法结构
  assert.strictEqual(parseChatResponse(null), '');
  assert.strictEqual(parseChatResponse('oops'), '');
});

// 合成一个 profilePublic 对象（不依赖 DB）
const prof = {
  id: 1, name: 'P', kind: 'local' as const, provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', hasKey: true,
  isDefault: true, timeoutMs: 60000, systemPrompt: '',
};

test('profileToAiConfig 正确映射', () => {
  const c = profileToAiConfig(prof as any);
  assert.strictEqual(c.baseUrl, 'http://localhost:11434/v1');
  assert.strictEqual(c.model, 'llama3.1');
  assert.strictEqual(c.enabled, true);
});
