/**
 * 镜像管理 API 路由
 *
 * 提供镜像的列表、拉取、删除、详情、标签等接口。
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import { Readable } from 'stream';
import { getDockerClient } from '../docker/client';
import { buildPullRef, listSources, searchHubRepos } from '../hubConfig';
import { getPullTime, recordPullTime } from '../imagePullHistory';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/**
 * 根据镜像名生成导出文件的默认文件名
 * 将仓库名中的非法字符替换为下划线，并追加 .tar 后缀
 * @param name 镜像名（如 nginx:latest 或 myrepo/myimage:v1）
 */
function saveFileName(name: string): string {
  const base = name.split('@')[0];
  const sanitized = base.replace(/[^\w.\-]/g, '_');
  return sanitized ? sanitized + '.tar' : 'image.tar';
}

/**
 * 将字节数格式化为可读的单位字符串（B/KB/MB/GB/TB）
 * @param bytes 字节数
 * @returns 格式化后的字符串
 */
function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * 解析 docker load 返回的响应流，提取“Loaded image: xxx”信息
 * @param stream docker load 输出的可读流（每行一个 JSON 对象）
 * @returns 提取到的已加载镜像引用列表
 */
function collectLoadedImages(stream: NodeJS.ReadableStream): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const loaded: string[] = [];
    let buffer = '';
    let settled = false;
    // 结束时的兜底回调，保证只结算一次
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(loaded);
    };
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      // 按换行切分 JSON 行
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const json = JSON.parse(line);
          const text = json?.stream || json?.status || json?.aux?.Digest || '';
          if (typeof text === 'string' && /Loaded image:/i.test(text)) {
            const m = text.match(/Loaded image:\s*(.+)/i);
            if (m?.[1]) loaded.push(m[1].trim());
          }
        } catch {
          /* 忽略非 JSON 行（如纯文本提示） */
        }
      }
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * 统一兜底错误处理
 *
 * @param fn 业务处理函数
 * @param onFail 可选：操作失败时记录失败审计日志的参数构造器（返回 null 则跳过记录）
 *   在 catch 分支调用，让"操作失败"也能落在 operation_logs 中（此前只记成功）。
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<any>,
  onFail?: (req: Request, err: any) => { action: string; targetType: string; targetName?: string | null; detail?: string | null } | null,
) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      // 操作失败：若提供了 onFail，则记录一条失败审计日志
      if (onFail) {
        try {
          const meta = onFail(req, err);
          if (meta) {
            logOperation(
              res.locals.username,
              meta.action,
              meta.targetType,
              meta.targetName ?? null,
              `失败: ${meta.detail || err?.message || '未知错误'}`,
              false,
            );
          }
        } catch {
          // 记录日志失败不影响错误响应
        }
      }
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
 * 计算镜像优化建议数据
 *
 * 汇总 Top 大镜像、长期未使用镜像、重复标签镜像、总大小与悬空镜像数量，
 * 供前端"优化建议"卡片展示。判定镜像是否被使用时，综合容器 ImageID 与
 * 容器 Image 字段（镜像名）两方面匹配。
 * @param docker dockerode 客户端
 * @returns 建议数据对象
 */
async function computeImageSuggestions(docker: Awaited<ReturnType<typeof getDockerClient>>) {
  // 列出镜像（含悬空镜像，不含中间层）与全部容器（含已停止），用于判断镜像是否被使用
  const images = (await docker.listImages({ all: false })) as any[];
  const containers = (await docker.listContainers({ all: true })) as any[];

  // 收集所有容器引用的镜像 Id 与镜像名，用于判断镜像是否被使用
  const usedImageIds = new Set<string>();
  const usedImageNames = new Set<string>();
  for (const c of containers) {
    if (c.ImageID) usedImageIds.add(c.ImageID);
    if (c.Image) usedImageNames.add(c.Image);
  }

  const now = Math.floor(Date.now() / 1000);
  let totalSize = 0;
  let danglingCount = 0;
  // 按 image Id 分组（listImages 通常每 Id 一条，分组以兼容边界情况）
  const byId = new Map<string, any[]>();
  for (const img of images) {
    const id = img.Id;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(img);
    totalSize += img.Size || 0;
    // 无仓库标签的镜像即为悬空（dangling）镜像
    if (!img.RepoTags || img.RepoTags.length === 0) danglingCount++;
  }

  // 重复镜像：同一 image Id 指向多个 RepoTags
  const duplicates: { id: string; tags: string[] }[] = [];
  for (const [id, group] of byId) {
    const tags = group.flatMap((img) => img.RepoTags || []);
    const uniqueTags = Array.from(new Set(tags));
    if (uniqueTags.length > 1) {
      duplicates.push({ id, tags: uniqueTags });
    }
  }

  /**
   * 判断镜像是否被任意容器使用
   * @param img 镜像条目
   */
  const isUsed = (img: any): boolean => {
    if (img.Id && usedImageIds.has(img.Id)) return true;
    const tags = img.RepoTags || [];
    return tags.some((t: string) => usedImageNames.has(t));
  };

  // Top 10 大镜像（按 Size 降序）
  const topLarge = [...images]
    .sort((a, b) => (b.Size || 0) - (a.Size || 0))
    .slice(0, 10)
    .map((img) => ({
      id: img.Id,
      tags: img.RepoTags || [],
      size: img.Size || 0,
      created: img.Created || 0,
    }));

  // 长期未使用镜像：无容器使用 + 超过 30 天未拉取（无拉取记录时回退到构建时间）
  const unused = images
    .filter((img) => !isUsed(img))
    .map((img) => {
      const lastPullAt = img.Id ? getPullTime(img.Id) : undefined;
      // 拉取时间缺失时以镜像构建时间作为最近活动时间
      const reference = lastPullAt != null ? lastPullAt : img.Created || 0;
      const daysSincePull = reference ? Math.floor((now - reference) / 86400) : 0;
      return {
        id: img.Id,
        tags: img.RepoTags || [],
        size: img.Size || 0,
        lastPullAt,
        daysSincePull,
      };
    })
    .filter((item) => item.daysSincePull > 30)
    .sort((a, b) => b.daysSincePull - a.daysSincePull);

  return {
    topLarge,
    unused,
    duplicates,
    totalSize,
    danglingCount,
    totalCount: images.length,
  };
}

/**
 * GET /api/images
 * 获取镜像列表，可通过 all=true 包含中间层镜像
 * 返回时合并每个镜像的本地拉取时间（pullTime，秒），供前端展示"拉取时间"列。
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const all = req.query.all === 'true';
    const images = await docker.listImages({ all });
    // 为每个镜像补充本地拉取时间（无记录则省略）
    const withPullTime = (images as any[]).map((img) => {
      const pullTime = img?.Id ? getPullTime(img.Id) : undefined;
      return pullTime ? { ...img, pullTime } : img;
    });
    res.json(withPullTime);
  }),
);

/**
 * GET /api/images/suggestions
 * 返回镜像优化建议：Top 大镜像、长期未使用镜像、重复标签镜像、总大小、悬空镜像数量
 * 注意：需在 /:name 之前定义，避免 suggestions 被 :name 捕获
 */
router.get(
  '/suggestions',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const data = await computeImageSuggestions(docker);
    res.json(data);
  }),
);

/**
 * GET /api/images/:name/impact
 * 返回指定镜像被哪些容器使用（relatedContainers），复用镜像详情页的关联容器判定逻辑
 * 注意：需在 /:name 之前定义，避免 impact 被 :name 捕获
 */
router.get(
  '/:name/impact',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const name = req.params.name;
    // 先 inspect 拿到镜像的 Id 与 RepoTags，用于和容器匹配
    const info: any = await docker.getImage(name).inspect();
    const imageId = info?.Id;
    const repoTags: string[] = Array.isArray(info?.RepoTags) ? info.RepoTags : [];
    const containers = (await docker.listContainers({ all: true })) as any[];
    // 容器使用该镜像的判定：ImageID 相等，或 Image 字段命中某个 RepoTag
    const relatedContainers = containers
      .filter((c) => {
        if (imageId && c.ImageID === imageId) return true;
        return repoTags.some((t) => c.Image === t);
      })
      .map((c) => ({
        id: c.Id,
        name: (c.Names && c.Names[0]?.replace(/^\//, '')) || (c.Id || '').slice(0, 12),
        state: c.State,
      }));
    res.json({ id: imageId, tags: repoTags, relatedContainers });
  }),
);

/**
 * GET /api/images/:name/history
 * 获取单个镜像的构建历史（docker history 原始数组）
 * 注意：需在 /:name 之前定义，避免 history 被 :name 捕获
 */
router.get(
  '/:name/history',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const image = docker.getImage(req.params.name);
    const history = await image.history();
    res.json(history);
  }),
);

/**
 * GET /api/images/:name/save
 * 导出镜像为 tar 文件（docker save），以流式方式传递给前端下载
 * 注意：需在 /:name 之前定义，避免 save 被 :name 捕获
 */
router.get(
  '/:name/save',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const name = req.params.name;
    // dockerode 的 Image.get() 对应 docker save，返回可读流（大文件不会被读入内存）
    const stream = await docker.getImage(name).get();
    // 设置下载相关的响应头
    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${saveFileName(name)}"`);
    // 将 docker save 返回的可读流以管道方式写入响应，完成后结束响应
    stream.pipe(res);
    stream.on('error', (err: any) => {
      // 若响应尚未结束，则尝试返回错误；否则只能终止响应
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || '镜像导出失败' });
      } else {
        res.end();
      }
    });
  }),
);

/**
 * GET /api/images/:name
 * 获取单个镜像的详细信息
 */
router.get(
  '/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const image = docker.getImage(req.params.name);
    const info = await image.inspect();
    res.json(info);
  }),
);

/**
 * POST /api/images/pull
 * 拉取镜像
 * body: { ref: "nginx:latest", source?: "https://docker.xuanyuan.me", auth?: {username,password,serveraddress} }
 * 未传 source 时，若配置了默认启用镜像源，则自动使用该镜像源加速拉取。
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
    const explicit = req.body?.source;

    // 候选镜像源顺序：显式指定的源优先，其后追加其余启用镜像源；
    // 未指定时则遍历全部启用镜像源。这样单个源被限流(429)或不可用时，
    // 自动切换下一个启用镜像源重试，显著提升拉取成功率。
    const enabledHosts = (listSources() || [])
      .filter((s) => s.enabled)
      .map((s) => s.host)
      .filter(Boolean) as string[];
    const rawCands = explicit ? [explicit, ...enabledHosts] : enabledHosts;
    if (rawCands.length === 0) {
      rawCands.push(''); // 无任何启用镜像源时，回退官方 Docker 仓库
    }
    const seen = new Set<string>();
    const cands = rawCands.filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });

    let lastErr: any = null;
    for (const src of cands) {
      const pullRef = buildPullRef(ref, src);
      try {
        const stream = await docker.pull(pullRef, {
          authconfig: !src && (auth.username || auth.password) ? auth : undefined,
        });
        const progress: any[] = [];
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(
            stream,
            (err: any) => (err ? reject(err) : resolve()),
            (event: any) => {
              progress.push(event);
            },
          );
        });
        // 拉取成功后，记录该镜像的本地拉取时间（用于"拉取时间"列展示）
        // pullRef 可能带镜像源主机前缀或 library/ 前缀，借助 engine 解析出本地镜像 Id
        try {
          const inspected: any = await docker.getImage(pullRef).inspect();
          if (inspected?.Id) recordPullTime(inspected.Id);
        } catch {
          // 获取镜像 Id 失败不影响拉取结果
        }
        logOperation(res.locals.username, '拉取镜像', 'image', ref, `源: ${src || 'docker.io'}`);
        return res.json({ ok: true, ref: pullRef, source: src || 'docker.io', progress });
      } catch (e: any) {
        // 当前镜像源失败（如 429 限流/网络/镜像不存在），尝试下一个启用源
        lastErr = e;
      }
    }
    const msg =
      typeof lastErr?.message === 'string'
        ? lastErr.message.replace(/\s+/g, ' ')
        : '镜像拉取失败';
    logOperation(res.locals.username, '拉取镜像', 'image', ref, `失败: ${msg}`, false);
    return res.status(500).json({
      error: `镜像拉取失败（已尝试 ${cands.length} 个镜像源）：${msg}`,
    });
  }),
);

/**
 * POST /api/images/search
 * 搜索镜像。优先通过已配置的镜像源（或官方 Docker Hub）HTTP 搜索，失败时回退引擎侧 docker search。
 * body: { term: string }
 */
router.post(
  '/search',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const term = String(req.body?.term || '').trim();
    // term 必填，缺失或为空时返回 400
    if (!term) {
      return res.status(400).json({ error: '缺少搜索关键字 term' });
    }

    // 优先走镜像源 / 官方 Hub 的 HTTP 搜索（在配置了可用镜像源时更可靠）
    try {
      const { results, total } = await searchHubRepos(term, 1);
      res.json({ ok: true, source: 'hub', results, total });
      return;
    } catch {
      // HTTP 搜索失败（无网络/镜像源不可用），回退到引擎侧 docker search
    }

    // 回退：引擎侧 docker search（dockerode 的 searchImages）
    const anyDocker = docker as any;
    const searchFn: ((opts: any, cb?: any) => any) | undefined =
      typeof anyDocker?.searchImages === 'function'
        ? anyDocker.searchImages.bind(anyDocker)
        : typeof anyDocker?.search === 'function'
          ? anyDocker.search.bind(anyDocker)
          : undefined;
    if (!searchFn) {
      return res.status(500).json({ error: '当前 Docker 客户端不支持镜像搜索' });
    }
    // 给引擎搜索加超时，避免连不上 registry 时长时间挂起
    const results = await new Promise<any[]>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('引擎搜索超时，请检查网络或 registry 可用性'));
      }, 15000);
      (timer as any).unref?.();
      const done = (err: any, list: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(Array.isArray(list) ? list : []);
      };
      const maybePromise = searchFn({ term }, (err: any, list: any) => done(err, list));
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((r: any) => done(null, r)).catch((e: any) => done(e, undefined));
      }
    });
    res.json({ ok: true, source: 'docker', results });
  }),
);

/**
 * POST /api/images/import
 * 导入镜像（docker load），接收 application/octet-stream 的 tar 数据流
 * 使用 express.raw 将请求体解析为 Buffer（无需额外依赖 multer），支持最大 1GB；
 * 将 Buffer 包装为可读流交给 docker.loadImage，并解析输出中的“Loaded image”信息
 */
router.post(
  '/import',
  requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: '1gb' }),
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const raw = req.body as Buffer | undefined;
      if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) {
        return res.status(400).json({ error: '请求体为空，请上传有效的镜像 tar 文件（application/octet-stream）' });
      }
      // 将 Buffer 以可读流方式交给 docker.loadImage（loadImage 仅接受 string 或 ReadableStream）
      const input = Readable.from(raw);
      const stream = await docker.loadImage(input);
      // 收集 docker load 输出的“Loaded image”信息并等待完成
      const loaded = await collectLoadedImages(stream);
      const msg = loaded.length ? `已加载镜像：${loaded.join(', ')}` : '镜像导入成功';
      logOperation(res.locals.username, '导入镜像', 'image', loaded.join(', ') || null, 'docker load');
      res.json({ ok: true, msg, loaded });
    },
    () => ({ action: '导入镜像', targetType: 'image', detail: 'docker load' }),
  ),
);

/**
 * POST /api/images/push
 * 推送镜像到远程 registry（docker push），等待推送完成后返回进度
 * body: { name, auth?: { username?, password?, serveraddress? } }
 */
router.post(
  '/push',
  requireAdmin,
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const { name } = req.body || {};
      if (!name) {
        return res.status(400).json({ error: '缺少镜像名称 name' });
      }
      const auth = req.body?.auth || {};
      const authconfig = auth.username || auth.password ? auth : undefined;
      const image = docker.getImage(name);
      // dockerode 的 push 支持回调式或返回流，这里统一收集进度并等待完成
      const stream: any = await new Promise((resolve, reject) => {
        image.push({ authconfig }, (err: any, s: any) => (err ? reject(err) : resolve(s)));
      });
      // 收集推送进度，等待完成
      const progress: any[] = [];
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: any) => (err ? reject(err) : resolve()), (event: any) => {
          progress.push(event);
        });
      });
      logOperation(res.locals.username, '推送镜像', 'image', name);
      res.json({ ok: true, progress });
    },
    (req: Request) => ({ action: '推送镜像', targetType: 'image', targetName: req.body?.name || null }),
  ),
);

/**
 * DELETE /api/images/:name?force=true
 * 删除镜像，force 强制删除
 */
router.delete(
  '/:name',
  requireAdmin,
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const force = req.query.force === 'true';
      const result = await docker.getImage(req.params.name).remove({ force });
      logOperation(res.locals.username, '删除镜像', 'image', req.params.name, force ? '强制删除' : '');
      res.json(Array.isArray(result) ? result : { ok: true, result });
    },
    (req: Request) => ({ action: '删除镜像', targetType: 'image', targetName: req.params.name }),
  ),
);

/**
 * POST /api/images/tag
 * 给镜像打标签
 * body: { name, repo, tag }
 */
router.post(
  '/tag',
  requireAdmin,
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const { name, repo, tag } = req.body || {};
      if (!name || !repo) {
        return res.status(400).json({ error: '需要 name 和 repo 参数' });
      }
      await docker.getImage(name).tag({ repo, tag: tag || 'latest' });
      logOperation(res.locals.username, '镜像打标签', 'image', name, `新标签: ${repo}:${tag || 'latest'}`);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '镜像打标签', targetType: 'image', targetName: req.body?.name || null }),
  ),
);

/**
 * POST /api/images/prune
 * 清理未被使用的镜像
 * body: { all?: boolean }
 *   - all=true：清理所有未被容器使用的镜像（dangling=false，含非悬空未使用镜像）
 *   - all=false 或默认：仅清理悬空镜像（dangling=true，无标签镜像）
 * 返回 { ok, deleted, spaceReclaimed }
 */
router.post(
  '/prune',
  requireAdmin,
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const all = req.body?.all === true;
      // all=true 时 dangling=false（清理所有未使用镜像）；否则保持 dangling=true
      const dangling = !all;
      const result = await docker.pruneImages({ dangling });
      // 汇总清理详情：列出被清理的镜像（Untagged/Deleted）与释放空间
      const deleted: string[] = [];
      for (const item of result.ImagesDeleted || []) {
        const name = item.Untagged || item.Deleted || '';
        if (name && !deleted.includes(name)) deleted.push(name);
      }
      const spaceReclaimed = result.SpaceReclaimed || 0;
      const spaceText = spaceReclaimed > 0 ? `释放空间: ${fmtBytes(spaceReclaimed)}` : '无空间回收';
      const listText = deleted.length
        ? `清理镜像(${deleted.length}个): ${deleted.join(', ')}`
        : '未找到可清理的镜像';
      logOperation(
        res.locals.username,
        '清理镜像',
        'image',
        null,
        `${all ? '全部未使用' : '悬空'}; ${listText}; ${spaceText}`,
      );
      res.json({ ok: true, deleted, spaceReclaimed });
    },
    () => ({ action: '清理镜像', targetType: 'image', detail: 'docker image prune' }),
  ),
);

export default router;
