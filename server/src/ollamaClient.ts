/**
 * Ollama 本地模型管理模块
 *
 * 对接 Ollama REST API（默认端口 11434），提供模型拉取、删除、列表、状态查询。
 * Docker Model Runner 兼容 Ollama API（端口 12434），可通过 baseUrl 切换。
 */
import { decryptSecret } from './storage';

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: Record<string, unknown>;
}

export interface OllamaStatus {
  ok: boolean;
  message: string;
  models: OllamaModel[];
  version?: string;
}

/**
 * 获取 Ollama 服务地址（从环境变量或默认值）
 */
export function getOllamaHost(): string {
  return process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
}

/**
 * 获取 Ollama 服务状态 + 已安装模型列表
 */
export async function getOllamaStatus(host?: string): Promise<OllamaStatus> {
  const base = host || getOllamaHost();
  try {
    // 获取模型列表
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}`, models: [] };
    const data = await resp.json() as any;
    const models: OllamaModel[] = (data.models || []).map((m: any) => ({
      name: m.name,
      size: m.size || 0,
      digest: m.digest || '',
      modified_at: m.modified_at || '',
      details: m.details || {},
    }));
    // 尝试获取版本
    let version: string | undefined;
    try {
      const vResp = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2000) });
      if (vResp.ok) {
        const vData = await vResp.json() as any;
        version = vData.version;
      }
    } catch { /* 忽略 */ }
    return { ok: true, message: `发现 ${models.length} 个模型`, models, version };
  } catch (err: any) {
    return { ok: false, message: err?.message || '无法连接 Ollama 服务', models: [] };
  }
}

/**
 * 获取运行中的模型列表
 */
export async function getOllamaRunning(host?: string): Promise<{ ok: boolean; models: Array<{ name: string; size: number; size_vram: number }> }> {
  const base = host || getOllamaHost();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(`${base}/api/ps`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, models: [] };
    const data = await resp.json() as any;
    return {
      ok: true,
      models: (data.models || []).map((m: any) => ({
        name: m.name,
        size: m.size || 0,
        size_vram: m.size_vram || 0,
      })),
    };
  } catch {
    return { ok: false, models: [] };
  }
}

/**
 * 拉取模型（同步阻塞直到完成）
 */
export async function pullOllamaModel(modelName: string, host?: string): Promise<{ ok: boolean; message: string }> {
  const base = host || getOllamaHost();
  try {
    const resp = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(300000), // 5 分钟超时
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, message: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, message: `模型 ${modelName} 拉取完成` };
  } catch (err: any) {
    return { ok: false, message: err?.message || '拉取失败' };
  }
}

/**
 * 删除模型
 */
export async function deleteOllamaModel(modelName: string, host?: string): Promise<{ ok: boolean; message: string }> {
  const base = host || getOllamaHost();
  try {
    const resp = await fetch(`${base}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, message: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, message: `模型 ${modelName} 已删除` };
  } catch (err: any) {
    return { ok: false, message: err?.message || '删除失败' };
  }
}

/**
 * 生成 embeddings（用于 RAG）
 */
export async function ollamaEmbeddings(modelName: string, text: string, host?: string): Promise<{ ok: boolean; embedding?: number[]; error?: string }> {
  const base = host || getOllamaHost();
  try {
    const resp = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt: text }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json() as any;
    return { ok: true, embedding: data.embedding };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'embedding 失败' };
  }
}
