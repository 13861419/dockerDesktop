/** 内置 AI 提供商预设（只读常量） */
export interface AiPreset {
  id: string;
  name: string;
  kind: 'local' | 'cloud';
  baseUrl: string;
  models: string[];
  keyHint?: string;
}

export const AI_PRESETS: AiPreset[] = [
  { id: 'ollama', name: 'Ollama', kind: 'local', baseUrl: 'http://localhost:11434/v1', models: ['llama3.1', 'qwen2.5', 'mistral'] },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', baseUrl: 'http://localhost:1234/v1', models: [] },
  { id: 'gateway', name: '本地网关', kind: 'local', baseUrl: 'http://127.0.0.1:8000/v1', models: [] },
  { id: 'openai', name: 'OpenAI', kind: 'cloud', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'], keyHint: 'sk-...' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'cloud', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], keyHint: 'sk-...' },
  { id: 'moonshot', name: 'Kimi (Moonshot)', kind: 'cloud', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], keyHint: 'sk-...' },
  { id: 'dashscope', name: '通义千问', kind: 'cloud', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], keyHint: 'sk-...' },
  { id: 'zhipu', name: '智谱 GLM', kind: 'cloud', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-flash'], keyHint: 'api key' },
  { id: 'custom', name: '自定义', kind: 'cloud', baseUrl: '', models: [] },
];

export function getPresetById(id: string): AiPreset | undefined {
  return AI_PRESETS.find((p) => p.id === id);
}
