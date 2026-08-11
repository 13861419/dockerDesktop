/**
 * 镜像源（registry mirror）配置存储模块（SQLite 持久化）
 *
 * 镜像加速源列表存储在 SQLite 的 hub_sources 表中，自定义搜索源存储在 setting 表中，
 * 替代原有 JSON/文本文件存储。首次运行时预置几个常用国内镜像加速源。
 * 数据文件位于 <项目根>/data/docker-manager.db（单一 SQLite 文件）。
 */
import { getDb } from './storage';

/** 单个镜像源条目 */
export interface HubSource {
  /** 源唯一 id */
  id: string;
  /** 镜像源主机地址，形如 https://docker.xuanyuan.me 或 docker.xuanyuan.me */
  host: string;
  /** 源名称（可选） */
  name?: string;
  /** 是否内置默认源（不可删除但可停用） */
  builtin?: boolean;
  /** 是否启用 */
  enabled?: boolean;
}

/** 数据库行结构（builtin/enabled 为 0/1 整数） */
interface SourceRow {
  id: string;
  host: string;
  name: string | null;
  builtin: number;
  enabled: number;
}

/** 内置默认镜像源列表 */
const DEFAULT_SOURCES: HubSource[] = [
  { id: 'xuyuan', host: 'https://docker.xuanyuan.me', name: '轩辕镜像源', builtin: true, enabled: true },
  { id: '1ms', host: 'https://docker.1ms.run', name: '1ms 镜像源', builtin: true, enabled: true },
];

/**
 * 重命名主机（供容器镜像引用使用时不带协议前缀）
 * @param host 源主机地址（可能带 https:// 前缀）
 * @returns 去掉协议前缀的主机名
 */
function hostnameOf(host: string): string {
  return host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/**
 * 确保内置默认源存在于表中（新增内置源时自动补充，与旧 JSON 方案语义一致）
 * 幂等：已存在则跳过。
 */
function ensureBuiltinSources(): void {
  const d = getDb();
  for (const s of DEFAULT_SOURCES) {
    const exists = d.prepare('SELECT 1 AS x FROM hub_sources WHERE id = ?').get(s.id);
    if (!exists) {
      d.prepare('INSERT INTO hub_sources (id, host, name, builtin, enabled) VALUES (?, ?, ?, ?, ?)').run(
        s.id,
        s.host,
        s.name || null,
        s.builtin ? 1 : 0,
        s.enabled ? 1 : 0,
      );
    }
  }
}

/**
 * 读取镜像源列表（含内置默认源）
 * @returns 镜像源列表
 */
function loadSources(): HubSource[] {
  ensureBuiltinSources();
  const rows = getDb()
    .prepare('SELECT id, host, name, builtin, enabled FROM hub_sources ORDER BY builtin DESC, rowid')
    .all() as unknown as SourceRow[];
  return rows.map((r) => ({
    id: r.id,
    host: r.host,
    name: r.name ?? undefined,
    builtin: r.builtin === 1,
    enabled: r.enabled === 1,
  }));
}

/**
 * 列出全部镜像源
 * @returns 镜像源列表
 */
export function listSources(): HubSource[] {
  return loadSources();
}

/**
 * 添加自定义镜像源
 * @param host 源主机地址
 * @param name 源名称（可选）
 * @returns 新建的镜像源条目
 * @throws 主机地址非法或重复时抛错
 */
export function addSource(host: string, name?: string): HubSource {
  const h = (host || '').trim();
  if (!h) throw new Error('镜像源地址不能为空');
  // 校验是否为合法 http(s) URL 或主机名
  if (!/^https?:\/\//i.test(h) && !/^[\w.-]+$/.test(h)) {
    throw new Error('镜像源地址格式不正确');
  }
  const exists = getDb().prepare('SELECT 1 AS x FROM hub_sources WHERE host = ?').get(h.replace(/\/+$/, ''));
  if (exists) throw new Error('该镜像源已存在');
  const item: HubSource = {
    id: 'src_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    host: h,
    name: name?.trim() || undefined,
    builtin: false,
    enabled: true,
  };
  getDb()
    .prepare('INSERT INTO hub_sources (id, host, name, builtin, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(item.id, item.host, item.name || null, 0, 1);
  return { ...item };
}

/**
 * 删除镜像源（内置源不可删除，仅允许删除自定义源）
 * @param id 镜像源 id
 */
export function removeSource(id: string): void {
  getDb().prepare('DELETE FROM hub_sources WHERE id = ? AND builtin = 0').run(id);
}

/**
 * 设置镜像源启用/停用状态
 * @param id 镜像源 id
 * @param enabled 是否启用
 */
export function setSourceEnabled(id: string, enabled: boolean): void {
  getDb().prepare('UPDATE hub_sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

/**
 * 根据主机地址解析出裸主机名（拉取时用于拼接镜像引用前缀）
 * @param host 源主机地址
 * @returns 裸主机名
 */
export function getSourceHost(host: string): string {
  return hostnameOf(host);
}

/**
 * 构建实际拉取引用
 *
 * 当指定镜像源 source 时，将镜像引用加上该源的主机前缀，使请求发往镜像加速源（由源反代到 Docker Hub）。
 * 官方镜像（无命名空间，不含 `/`）会自动补 `library/` 前缀。
 * @param ref 原始镜像引用，如 nginx:latest 或 alpine/curl:1.0
 * @param source 镜像源主机地址（可带 https:// 前缀），为空则返回原始引用
 * @returns 实际拉取引用
 */
export function buildPullRef(ref: string, source?: string): string {
  if (!source) return ref;
  const host = hostnameOf(source);
  if (!host) return ref;
  const str = String(ref);
  const name = str.split(':')[0];
  const tag = str.includes(':') ? ':' + str.split(':').slice(1).join(':') : '';
  const normName = name.includes('/') ? name : 'library/' + name;
  return `${host}/${normName}${tag}`;
}

/**
 * 获取第一个启用镜像源的主机地址（无则返回空串）
 * @returns 默认镜像源裸主机名，无启用源时返回 ''
 */
export function getDefaultSourceHost(): string {
  return loadSources().find((s) => s.enabled)?.host || '';
}

/** 自定义搜索源在 setting 表中的 key */
const SEARCH_SOURCE_KEY = 'searchSource';

/**
 * 获取自定义搜索源基址（可选）
 *
 * 国内镜像加速源普遍不提供 Docker Hub 的在线搜索接口，因此允许用户显式配置一个
 * 支持返回 Docker Hub 搜索结果的 API 基址（如内网 registry 或可用的代理站）。
 * 为空表示未配置，搜索时使用内置候选源。
 * @returns 搜索源基址，如 https://hub.docker.com
 */
export function getSearchSource(): string {
  const row = getDb().prepare('SELECT value FROM setting WHERE key = ?').get(SEARCH_SOURCE_KEY) as
    | { value: string | null }
    | undefined;
  return (row?.value || '').trim();
}

/**
 * 设置自定义搜索源基址
 * @param host 搜索源基址（留空则清除配置）
 */
export function setSearchSource(host: string): void {
  const value = (host || '').trim();
  const d = getDb();
  const exists = d.prepare('SELECT 1 AS x FROM setting WHERE key = ?').get(SEARCH_SOURCE_KEY);
  if (exists) {
    d.prepare('UPDATE setting SET value = ? WHERE key = ?').run(value, SEARCH_SOURCE_KEY);
  } else {
    d.prepare('INSERT INTO setting (key, value) VALUES (?, ?)').run(SEARCH_SOURCE_KEY, value);
  }
}

/**
 * 获取启用的镜像源中的第一个（作为默认拉取源）
 * @returns 第一个启用的源，若无则返回 undefined
 */
export function getDefaultSource(): HubSource | undefined {
  return loadSources().find((s) => s.enabled);
}

/**
 * 重置镜像源缓存（SQLite 无内存缓存，保留空实现以兼容旧调用方）
 */
export function resetSourceCache(): void {
  // no-op：SQLite 直接读写，无需清缓存
}

/** 规范的镜像搜索条目 */
export interface HubSearchResult {
  name: string;
  description: string;
  star_count: number;
  pull_count: number;
  last_updated: string;
  is_official: boolean;
  full_name: string;
}

/**
 * 移除仓库名中的 library/ 前缀，展示更友好的镜像名
 * @param name 原始仓库名（如 library/nginx）
 * @returns 友好名称（如 nginx）
 */
function friendlyName(name: string): string {
  return name.startsWith('library/') ? name.slice('library/'.length) : name;
}

/** 内置的第三方 Docker 镜像/搜索代理源的基础域名（官方 Hub 之后按顺序尝试，尽量保留可达站点） */
const SEARCH_PROXY_BASES = [
  'https://docker.m.daocloud.io', // DaoCloud 镜像站（完整代理 Docker Hub）
  'https://docker-proxy.daocloud.io',
  'https://hub.rat.dev', // LinuxDo 社区 Docker 代理
  'https://docker.1panel.live', // 1Panel 镜像源
];

/**
 * 将一条镜像搜索结果规范化为统一的 HubSearchResult
 * @param r 原始搜索条目（registry 或 Web 两种结构）
 * @returns 规范化结果
 */
function toHubResult(r: any): HubSearchResult {
  return {
    name: friendlyName(r?.repo_name || r?.name || ''),
    description: r?.short_description || r?.description || '',
    star_count: r?.star_count ?? 0,
    pull_count: r?.pull_count ?? 0,
    last_updated: r?.last_updated || '',
    is_official: !!r?.is_official,
    full_name: r?.repo_name || r?.name || '',
  };
}

/**
 * 通过 Docker Hub 开放接口搜索镜像仓库。
 *
 * 为兼容不同形态的镜像站，对每个候选源尝试两条路径：
 *  - registry 传统搜索：GET {base}/v2/search?term=xxx  （docker search 底层协议，镜像加速源最可能支持）
 *  - Hub Web 搜索：     GET {base}/v2/search/repositories/?query=xxx （Docker Hub 网页/API 协议）
 * 候选源优先级：用户已配置的启用镜像源 → 官方 hub.docker.com → 内置搜索代理源。
 * 所有（源 × 路径）并发请求，按候选顺序取第一个返回“合法搜索结果”的源。
 * @param term 搜索关键字
 * @param page 页码（从 1 起，Web 路径生效）
 * @returns 规范化后的搜索结果
 * @throws 全部失败时抛出错误
 */
export async function searchHubRepos(
  term: string,
  page = 1,
): Promise<{ results: HubSearchResult[]; total: number }> {
  // 组装候选基址：用户自定义搜索源 → 用户镜像源 → 官方 Hub → 内置搜索代理源
  const candidates: string[] = [];
  const searchSrc = getSearchSource();
  if (searchSrc) {
    candidates.push(searchSrc.replace(/\/+$/, ''));
  }
  const sourceHost = getDefaultSourceHost();
  if (sourceHost) {
    candidates.push(`https://${sourceHost}`);
  }
  candidates.push('https://hub.docker.com');
  candidates.push(...SEARCH_PROXY_BASES);

  // 去重，保持顺序
  const seen = new Set<string>();
  const bases = candidates.filter((b) => {
    if (seen.has(b)) return false;
    seen.add(b);
    return true;
  });

  // 为每个候选源生成「registry + web」两条请求 URL（registry 优先）
  const jobs: { url: string; label: string; kind: 'registry' | 'web' }[] = [];
  for (const base of bases) {
    jobs.push({
      url: `${base}/v2/search?term=${encodeURIComponent(term)}`,
      label: base,
      kind: 'registry',
    });
    jobs.push({
      url: `${base}/v2/search/repositories/?query=${encodeURIComponent(
        term,
      )}&page=${page}&page_size=20`,
      label: base,
      kind: 'web',
    });
  }

  // 并发发起所有请求，缩短整体等待时间
  const settled = await Promise.allSettled(
    jobs.map(async (job) => {
      let resp: Response;
      try {
        resp = await fetch(job.url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        throw new Error('网络不可达');
      }
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data: any = await resp.json();
      // 校验返回结构：必须是数组才视为“真正的搜索结果”，
      // 避免镜像源对不支持路径返回 200 的 HTML/错误 JSON 被误判为空结果
      if (!Array.isArray(data?.results)) {
        throw new Error('返回结构非法');
      }
      const results = (data.results || []).map(toHubResult);
      // registry 路径用 num_results，Web 路径用 count
      const total =
        job.kind === 'registry'
          ? data?.num_results ?? results.length
          : data?.count ?? results.length;
      return { results, total };
    }),
  );

  // 按 job 原始顺序（源优先级 + registry 优先）取第一个成功的搜索结果
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      return (settled[i] as PromiseFulfilledResult<{
        results: HubSearchResult[];
        total: number;
      }>).value;
    }
  }
  // 全部候选均失败：抛出带候选清单的中文提示，便于排查
  const e = new Error(
    `搜索失败：已尝试 ${bases.length} 个搜索源，均无法返回搜索结果。` +
      '国内镜像加速站大多不支持在线搜索 Docker Hub（通常只代理拉取）。' +
      '建议：在镜像中心点选"常用镜像"，或直接输入已知镜像名在"拉取镜像"拉取（走镜像源可靠）；' +
      '若您有可用的搜索 API，可在 镜像中心 → 镜像源 → 搜索源 中填写。',
  );
  (e as any).statusCode = 502;
  throw e;
}
