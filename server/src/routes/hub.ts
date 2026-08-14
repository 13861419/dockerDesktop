/**
 * Docker Hub 镜像中心 API 路由
 *
 * 通过 Docker Hub 开放 API 提供镜像搜索、标签浏览与拉取功能。
 * 所有对外请求均使用 Node 内置 fetch，网络不可达时返回友好错误。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { logOperation } from '../operationLog';
import {
  listSources,
  addSource,
  removeSource,
  setSourceEnabled,
  buildPullRef,
  searchHubRepos,
  getSearchSource,
  setSearchSource,
} from '../hubConfig';
import { requireAdmin } from '../auth';

const router = Router();

/** Docker Hub 开放 API 的基础地址 */
const HUB_BASE = 'https://hub.docker.com/v2';

/**
 * 统一兜底错误处理
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 发起对 Docker Hub 的 GET 请求并解析 JSON
 * @param url 完整请求地址
 * @returns 解析后的 JSON 数据
 * @throws 网络错误时抛出带友好提示的错误
 */
async function hubGet<T>(url: string): Promise<T> {
  let res: Response & { ok: boolean };
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      throw new Error(`Docker Hub 请求失败 (${resp.status})`);
    }
    return (await resp.json()) as T;
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      const e = new Error('访问 Docker Hub 超时，请稍后重试');
      (e as any).statusCode = 502;
      throw e;
    }
    const e = new Error('无法访问 Docker Hub，请检查网络连接');
    (e as any).statusCode = 502;
    throw e;
  }
}

/**
 * 移除仓库名中的 library/ 前缀，展示更友好的镜像名
 * @param name 原始仓库名（如 library/nginx）
 * @returns 友好名称（如 nginx）
 */
function friendlyName(name: string): string {
  return name.startsWith('library/') ? name.slice('library/'.length) : name;
}

/**
 * GET /api/hub/search?q=xxx&page=1
 * 搜索 Docker Hub 镜像仓库（优先通过已配置的镜像源，失败回退官方 Docker Hub）
 */
router.get(
  '/search',
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q || '');
    const page = Number(req.query.page || '1') || 1;
    if (!q.trim()) {
      return res.status(400).json({ error: '缺少搜索关键字 q' });
    }
    // 优先走镜像源（如 docker.xuanyuan.me），失败自动回退官方 hub.docker.com
    const { results, total } = await searchHubRepos(q.trim(), page);
    res.json({ results, total });
  }),
);

/**
 * GET /api/hub/repositories/:name/tags?page_size=100
 * 获取指定镜像仓库的标签列表（name 形如 library/nginx）
 */
router.get(
  '/repositories/:name/tags',
  asyncHandler(async (req: Request, res: Response) => {
    const name = req.params.name;
    const data = await hubGet<any>(
      `${HUB_BASE}/repositories/${encodeURIComponent(name)}/tags?page_size=100`,
    );
    const tags = (data?.results || []).map((t: any) => ({
      name: friendlyName(t?.name || ''),
      size: t?.full_size ?? 0,
      last_updated: t?.last_updated || '',
      digest: t?.digest || '',
    }));
    res.json({ name: friendlyName(name), tags });
  }),
);

/**
 * POST /api/hub/pull
 * 拉取指定镜像引用（复用 docker.pull + followProgress 完成等待）
 * body: { ref: "library/nginx:latest", source?: "https://docker.xuanyuan.me" }
 * 当指定镜像源 source 时，会把镜像引用加上该源的主机前缀后再拉取，
 * 即请求发往镜像加速源（由源反代到 Docker Hub），适用于官方 Docker Hub 访问不稳的场景。
 */
router.post(
  '/pull',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const { ref } = req.body || {};
    if (!ref) {
      return res.status(400).json({ error: '缺少镜像引用 ref' });
    }
    const auth = req.body?.auth || {};

    // 计算实际拉取引用：若指定镜像源则拼上源主机前缀（共享 buildPullRef 处理素材/官方前缀）
    const source = req.body?.source;
    const pullRef = buildPullRef(ref, source);

    const stream = await docker.pull(pullRef, {
      authconfig:
        !source && (auth.username || auth.password) ? auth : undefined,
    });
    // 收集拉取进度，等待完成
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: any) => (err ? reject(err) : resolve()));
    });
    res.json({ ok: true, ref: pullRef });
  }),
);

// ============ 镜像源配置 ============

/**
 * GET /api/hub/sources
 * 获取已配置的镜像源列表
 */
router.get(
  '/sources',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ sources: listSources() });
  }),
);

/**
 * POST /api/hub/sources
 * 新增一个镜像源
 * body: { host, name? }
 */
router.post(
  '/sources',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { host, name } = req.body || {};
    const source = addSource(host, name);
    logOperation(res.locals.username, '新增镜像源', 'hubSource', source.name || source.host, source.host);
    res.json({ ok: true, source });
  }),
);

/**
 * DELETE /api/hub/sources/:id
 * 删除一个自定义镜像源
 */
router.delete(
  '/sources/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    removeSource(req.params.id);
    logOperation(res.locals.username, '删除镜像源', 'hubSource', req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/hub/sources/:id/enabled
 * 设置镜像源启用/停用状态
 * body: { enabled: boolean }
 */
router.post(
  '/sources/:id/enabled',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const enabled = req.body?.enabled === true;
    setSourceEnabled(req.params.id, enabled);
    logOperation(res.locals.username, enabled ? '启用镜像源' : '停用镜像源', 'hubSource', req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * GET /api/hub/search-source
 * 获取自定义搜索源基址
 */
router.get(
  '/search-source',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ host: getSearchSource() });
  }),
);

/**
 * POST /api/hub/search-source
 * 设置自定义搜索源基址（留空则清除）
 * body: { host?: string }
 */
router.post(
  '/search-source',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const host = String(req.body?.host || '');
    setSearchSource(host);
    logOperation(res.locals.username, host ? '设置镜像搜索源' : '清除镜像搜索源', 'hubSource', host || 'default');
    res.json({ ok: true });
  }),
);

export default router;
