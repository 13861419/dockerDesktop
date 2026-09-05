/**
 * 系统更新（1.26.0）
 *
 * 通过 GitHub Releases API 检查最新版本，并按当前平台给出更新方式指引。
 * - 支持 update.githubMirror 系统参数配置镜像前缀（国内网络可达性）；
 * - 结果缓存 10 分钟，避免频繁外呼；
 * - 版本比较为纯函数，便于单测。
 */
import { getSetting } from './settings';

const REPO_API = 'https://api.github.com/repos/13861419/dockerDesktop/releases/latest';
const CACHE_MS = 10 * 60 * 1000;

/** 内存缓存（进程内） */
let cache: { ts: number; data: UpdateCheckResult } | null = null;

export interface UpdateCheckResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl: string;
  notes: string;
  publishedAt: number | null;
  assets: Array<{ name: string; url: string; size: number; platform: string }>;
}

/** 语义化版本比较：返回 true 当 b > a */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((x) => parseInt(x, 10) || 0);
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

/** 按资产名匹配当前平台 */
export function platformOf(assetName: string): string {
  const n = assetName.toLowerCase();
  if (n.includes('win')) return 'windows';
  if (n.includes('macos') || n.includes('darwin')) return 'macos';
  if (n.includes('aarch64') || n.includes('arm64')) return 'linux-arm64';
  if (n.includes('x86_64') || n.includes('amd64')) return 'linux';
  if (n.includes('sha256')) return 'checksums';
  return 'other';
}

/** 检查更新（带 10 分钟缓存） */
export async function checkUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  if (cache && Date.now() - cache.ts < CACHE_MS) {
    return { ...cache.data, current: currentVersion, hasUpdate: isNewerVersion(currentVersion, cache.data.latest) };
  }
  const mirror = String(getSetting('update.githubMirror') || '').trim();
  const base = mirror ? `${mirror.replace(/\/+$/, '')}/api.github.com/repos/13861419/dockerDesktop/releases/latest` : REPO_API;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const resp = await fetch(base, {
      headers: { 'User-Agent': 'dockermanager', Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    const data = (await resp.json()) as any;
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    const result: UpdateCheckResult = {
      current: currentVersion,
      latest,
      hasUpdate: isNewerVersion(currentVersion, latest),
      releaseUrl: String(data.html_url || ''),
      notes: String(data.body || '').slice(0, 2000),
      publishedAt: data.published_at ? new Date(data.published_at).getTime() : null,
      assets: (data.assets || []).map((a: any) => {
        const url = String(a.browser_download_url || '');
        return {
          name: String(a.name || ''),
          url: mirror ? url.replace('https://github.com', mirror.replace(/\/+$/, '')) : url,
          size: Number(a.size || 0),
          platform: platformOf(a.name || ''),
        };
      }),
    };
    cache = { ts: Date.now(), data: result };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function clearUpdateCache(): void {
  cache = null as any;
}
