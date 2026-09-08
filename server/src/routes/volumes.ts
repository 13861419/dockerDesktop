/**
 * 数据卷（Volumes）管理 API 路由
 *
 * 提供数据卷的列表、创建、删除、详情等接口。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { logOperation } from '../operationLog';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { maybeGateOrForbidden } from '../approvals';

const router = Router();

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
 * GET /api/volumes
 * 获取数据卷列表
 * listVolumes / volume inspect 均不返回 UsageData（RefCount），
 * 改用 docker system df 获取各卷引用数，供前端展示「使用中 / 未使用」状态。
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const data = await docker.listVolumes();
    const volumes = data.Volumes || [];
    // 从 system df 提取卷引用数（RefCount）与占用大小（Size）
    const refCount: Record<string, number> = {};
    const sizeMap: Record<string, number> = {};
    try {
      const df: any = await docker.df();
      (df?.Volumes || []).forEach((v: any) => {
        if (v?.Name && v.UsageData?.RefCount != null) {
          refCount[v.Name] = v.UsageData.RefCount;
          if (v.UsageData.Size != null) {
            sizeMap[v.Name] = v.UsageData.Size;
          }
        }
      });
    } catch {
      // df 失败时回落为不带 UsageData
    }
    const enriched = volumes.map((v: any) => ({
      ...v,
      UsageData:
        refCount[v.Name] != null
          ? { RefCount: refCount[v.Name], Size: sizeMap[v.Name] ?? (v as any)?.UsageData?.Size ?? null }
          : null,
    }));
    res.json({ volumes: enriched });
  }),
);

/**
 * GET /api/volumes/:name
 * 获取单个数据卷详情
 */
router.get(
  '/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const volume = await docker.getVolume(req.params.name).inspect();
    res.json(volume);
  }),
);

/**
 * POST /api/volumes
 * 创建数据卷
 * body: { name, driver, driverOpts, labels }
 */
router.post(
  '/',
  requirePermission('volumes.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const b = req.body || {};
    const volume = await docker.createVolume({
      Name: b.name,
      Driver: b.driver || 'local',
      DriverOpts: b.driverOpts || undefined,
      Labels: b.labels || undefined,
    });
    logOperation(res.locals.username, '创建数据卷', 'volume', b.name, `驱动: ${b.driver || 'local'}`);
    res.status(201).json(volume);
  }),
);

/**
 * DELETE /api/volumes/:name?force=true
 * 删除数据卷，force 忽略使用中的卷
 */
router.delete(
  '/:name',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    if (maybeGateOrForbidden(req, res, 'volume.delete', req.params.name, { force: req.query.force === 'true' })) return;
    const docker = await getDockerClient();
    const force = req.query.force === 'true';
    const volume = docker.getVolume(req.params.name);
    try {
      await volume.remove();
    } catch (err: any) {
      // 若卷正在使用且未强制，返回 409 冲突
      if (err?.statusCode === 409 && force) {
        // 已忽略冲突
      } else {
        throw err;
      }
    }
    res.json({ ok: true });
    logOperation(res.locals.username, '删除数据卷', 'volume', req.params.name, force ? '强制删除' : undefined);
  }),
);

/**
 * 执行数据卷清理（路由与审批执行器共用）
 *
 * Docker 默认的 volume prune 仅清理匿名卷（名称为 64 位哈希的未命名卷），
 * 命名卷（如 compose 创建的 deploy_pgdata）即使未被引用也不会被删——
 * 这是 Docker 的防误删设计，命名卷通常保存数据库等重要数据。
 * all=true 时通过 filters={"all":["1"]} 同时清理未被引用的命名卷
 * （需 Docker API ≥ 1.42；旧引擎不支持该过滤器时回退为默认口径）。
 *
 * @param all 是否同时清理未使用的命名卷
 * @returns result: Docker prune 原始返回；unusedNamed: 清理前未被引用的命名卷名列表
 */
export async function pruneVolumesInternal(
  all: boolean,
): Promise<{ result: any; unusedNamed: string[] }> {
  const docker = await getDockerClient();
  const [volumesRes, containers] = await Promise.all([
    docker.listVolumes(),
    docker.listContainers({ all: true }),
  ]);
  const used = new Set<string>();
  for (const c of containers || []) {
    for (const m of c.Mounts || []) {
      if (m.Type === 'volume' && m.Name) used.add(m.Name);
    }
  }
  const isAnonymous = (name: string) => /^[0-9a-f]{64}$/.test(name);
  const unusedNamed = (volumesRes?.Volumes || [])
    .map((v: any) => v.Name as string)
    .filter((n: string) => !isAnonymous(n) && !used.has(n));

  let result: any;
  if (all && unusedNamed.length > 0) {
    try {
      result = await new Promise((resolve, reject) => {
        (docker as any).modem.dial(
          {
            path: '/volumes/prune?',
            method: 'POST',
            options: { filters: JSON.stringify({ all: ['1'] }) },
            statusCodes: { 200: true, 500: 'server error' },
          },
          (err: any, data: any) => (err ? reject(err) : resolve(data)),
        );
      });
    } catch {
      // 旧版引擎不认识 all 过滤器时回退默认口径（仅匿名卷）
      result = await docker.pruneVolumes();
    }
  } else {
    result = await docker.pruneVolumes();
  }
  return { result, unusedNamed };
}

/**
 * POST /api/volumes/prune
 * 清理未被使用的数据卷
 * body: { all?: boolean } —— all=true 时同时清理未使用的命名卷（默认仅匿名卷）
 */
router.post(
  '/prune',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const all = req.body?.all === true;
    if (maybeGateOrForbidden(req, res, 'volume.prune', all ? '全部未使用（含命名卷）' : '匿名卷', { all })) return;
    const { result, unusedNamed } = await pruneVolumesInternal(all);
    const deleted = (result?.VolumesDeleted || []).join(', ');
    logOperation(res.locals.username, '清理未使用卷', 'volume', null, deleted || undefined);
    res.json({ ...result, namedKept: all ? 0 : unusedNamed.length, namedTotal: unusedNamed.length });
  }),
);

// ============ 卷精细管理：克隆 / 导出 ============

/** 卷克隆/导出使用的辅助镜像 */
const HELPER_IMAGE = 'alpine:latest';

/**
 * 保证辅助镜像存在（不存在则拉取）
 * @param docker dockerode 实例
 */
async function ensureHelperImage(docker: any): Promise<void> {
  const images = await docker.listImages();
  const has = images.some((i: any) =>
    (i.RepoTags || []).some((t: string) => t.split(':')[0].toLowerCase() === 'alpine'),
  );
  if (!has) {
    await new Promise<void>((resolve, reject) => {
      docker.pull(HELPER_IMAGE, (err: any, stream: any) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (perr: any) => (perr ? reject(perr) : resolve()), () => {});
      });
    });
  }
}

/**
 * 清理辅助容器（静默，避免清理失败掩盖主流程结果）
 * @param container 辅助容器
 */
async function removeHelper(container: { remove: (opts?: any) => Promise<void> }): Promise<void> {
  try {
    await container.remove({ force: true });
  } catch {
    // ignore
  }
}

/**
 * POST /api/volumes/:name/clone
 * 克隆数据卷：创建同名规则 <源卷>-clone（或 body.name）的新卷，并用 alpine 辅助容器复制全部数据。
 * body: { name?: string } —— 目标卷名，缺省 <源卷名>-clone
 */
router.post(
  '/:name/clone',
  requirePermission('volumes.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const srcName = String(req.params.name || '').trim();
    if (!srcName) {
      return res.status(400).json({ error: '缺少源卷名' });
    }
    const dstName = String(req.body?.name || '').trim() || `${srcName}-clone`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(dstName)) {
      return res.status(400).json({ error: '目标卷名包含非法字符' });
    }
    // 校验源卷存在
    const src = await docker.getVolume(srcName).inspect();
    // 目标卷已存在时拒绝（避免静默覆盖）
    try {
      await docker.getVolume(dstName).inspect();
      return res.status(409).json({ error: `目标卷 "${dstName}" 已存在` });
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
    // 创建目标卷（沿用源卷驱动与标签；DriverOpts 可能绑定特定环境，克隆时不携带）
    await docker.createVolume({ Name: dstName, Driver: src.Driver || 'local', Labels: src.Labels || undefined });
    // 辅助容器复制数据
    await ensureHelperImage(docker);
    const helper = await docker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ['sh', '-c', 'cp -a /from/. /to/'],
      HostConfig: { Binds: [`${srcName}:/from:ro`, `${dstName}:/to`], AutoRemove: false },
    });
    try {
      await helper.start();
      await helper.wait();
    } finally {
      await removeHelper(helper);
    }
    logOperation(res.locals.username, '克隆数据卷', 'volume', srcName, `目标: ${dstName}`);
    res.json({ ok: true, source: srcName, target: dstName });
  }),
);

/**
 * GET /api/volumes/:name/export
 * 将数据卷内容打包为 tar 流式下载。
 * 采用与卷文件浏览器一致的辅助容器模式：创建挂载目标卷的 alpine 容器（无需启动），
 * 通过 getArchive('/data/.') 获取 tar 流（daemon 侧打包，含卷内全部数据）。
 */
router.get(
  '/:name/export',
  requirePermission('volumes.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const srcName = String(req.params.name || '').trim();
    if (!srcName) {
      return res.status(400).json({ error: '缺少卷名' });
    }
    await docker.getVolume(srcName).inspect();
    await ensureHelperImage(docker);
    // 挂载目标卷（只读）；getArchive 由 daemon 读取挂载路径，容器无需启动
    const helper = await docker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ['sleep', 'infinity'],
      HostConfig: { Binds: [`${srcName}:/data:ro`], AutoRemove: false },
    });
    let finished = false;
    const cleanup = async () => {
      if (finished) return;
      finished = true;
      await removeHelper(helper);
    };
    req.on('close', () => {
      if (!finished) cleanup();
    });
    try {
      // dockerode v4：getArchive 直接解析为 tar 可读流
      const tarStream = (await helper.getArchive({ path: '/data/.' })) as NodeJS.ReadableStream;
      res.setHeader('Content-Type', 'application/x-tar');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(srcName)}.tar"`);
      tarStream.pipe(res);
      await new Promise<void>((resolve, reject) => {
        tarStream.on('end', () => resolve());
        tarStream.on('error', reject);
        res.on('close', () => resolve());
      });
      finished = true;
      await removeHelper(helper);
    } catch (err: any) {
      await cleanup();
      throw err;
    }
    logOperation(res.locals.username, '导出数据卷', 'volume', srcName);
  }),
);

export default router;
