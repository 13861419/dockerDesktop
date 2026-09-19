/**
 * agent 文件读取（1.86.0）
 *
 * 面板内置 agent.js 的版本解析与路径定位：
 * routes/edge.ts（下发文件 / 手动升级）与 edge/tunnel.ts（hello 握手回传最新版本）
 * 共用，避免 route → tunnel 反向依赖。
 */
import fs from 'fs';
import path from 'path';

export const AGENT_DIR = path.resolve(__dirname, '../../agent');

let agentVersionCache = '';

/** 从 agent.js 头部常量解析内置 agent 版本（文件缺失返回空串） */
export function readAgentVersion(): string {
  if (!agentVersionCache) {
    try {
      const code = fs.readFileSync(path.join(AGENT_DIR, 'agent.js'), 'utf8');
      agentVersionCache = parseAgentVersion(code);
    } catch {
      // 文件缺失时返回空
    }
  }
  return agentVersionCache;
}

/** 纯函数版本解析（供单测）：匹配 AGENT_VERSION = 'x.y.z' */
export function parseAgentVersion(code: string): string {
  const m = code.match(/AGENT_VERSION\s*=\s*'([\d.]+)'/);
  return m ? m[1] : '';
}
