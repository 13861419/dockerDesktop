/**
 * 系统 / Docker 引擎信息 API 路由
 *
 * 提供引擎版本、系统信息（System Info）等基础信息，供前端仪表盘使用。
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { getDockerClient } from '../docker/client';
import {
  listUsers,
  addUser,
  deleteUser,
  changePassword,
  userExists,
} from '../users';
import { exportDatabase, importDatabaseBuffer, getDataDir } from '../storage';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/** 当前监听端口（来自环境变量，缺省 9528） */
const SERVICE_PORT = Number(process.env.PORT) || 9528;

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
 * GET /api/system/info
 * 获取 Docker 引擎系统信息（用于健康检查与总览）
 */
router.get(
  '/info',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const info = await docker.info();
    res.json(info);
  }),
);

/**
 * GET /api/system/version
 * 获取 Docker 版本信息
 */
router.get(
  '/version',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const version = await docker.version();
    res.json(version);
  }),
);

/**
 * GET /api/system/ping
 * 探测引擎是否可连接（轻量健康检查）
 */
router.get(
  '/ping',
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const docker = await getDockerClient();
      await docker.ping();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  }),
);

// ============ 系统存储管理（df 统计 + 一键清理） ============

/**
 * 安全转数字：将任意值转为数字，非有限数返回 0
 * @param v 待转换的值
 */
function toNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * POST /api/system/prune
 * 按类别清理 Docker 未使用资源（镜像 / 容器 / 卷 / 网络 / build cache）
 * body: { images?: boolean, containers?: boolean, volumes?: boolean, networks?: boolean, buildCache?: boolean }
 * 返回各项删除的对象与回收空间，以及总回收空间
 */
router.post(
  '/prune',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const b = req.body || {};
    const want = (flag: any) => flag === true;

    // 各类别清理结果汇总：object = 被删除对象的可读描述，space = 回收字节数
    const results: Record<string, { objects: string[]; space: number }> = {
      images: { objects: [], space: 0 },
      containers: { objects: [], space: 0 },
      volumes: { objects: [], space: 0 },
      networks: { objects: [], space: 0 },
      buildCache: { objects: [], space: 0 },
    };

    // 清理悬空镜像（仅删除无标签/未被引用的镜像）
    if (want(b.images)) {
      const r = await docker.pruneImages({ dangling: true });
      const names = (r?.ImagesDeleted || []).map((d: any) => d?.Untagged || d?.Deleted || '').filter(Boolean);
      results.images = { objects: names, space: toNum(r?.SpaceReclaimed) };
    }

    // 清理已停止的容器
    if (want(b.containers)) {
      const r = await docker.pruneContainers();
      results.containers = { objects: r?.ContainersDeleted || [], space: toNum(r?.SpaceReclaimed) };
    }

    // 清理未使用的数据卷
    if (want(b.volumes)) {
      const r = await docker.pruneVolumes();
      results.volumes = { objects: r?.VolumesDeleted || [], space: toNum(r?.SpaceReclaimed) };
    }

    // 清理未使用的网络
    if (want(b.networks)) {
      const r = await docker.pruneNetworks();
      results.networks = { objects: (r as any)?.NetworksDeleted || [], space: toNum((r as any)?.SpaceReclaimed) };
    }

    // 清理 build cache（全部）
    if (want(b.buildCache)) {
      // dockerode 4.0.x 的 pruneBuilder 实现有缺陷（未把 opts 拼进 query string，
      // 等价于不带 --all 的 builder prune，只会清理悬空构建缓存，回收不了正在使用的构建缓存）。
      // 改用底层 modem 直接 POST /build/prune?all=true，确保全量清理。
      const r: any = await new Promise((resolve, reject) => {
        (docker as any).modem.dial(
          {
            path: '/build/prune?',
            method: 'POST',
            options: { all: true },
            statusCodes: { 200: true, 500: 'server error' },
          },
          (err: any, data: any) => (err ? reject(err) : resolve(data)),
        );
      });
      // pruneBuilder 仅返回回收空间，无对象名
      results.buildCache = { objects: [], space: toNum(r?.SpaceReclaimed) };
    }

    // 汇总总回收空间
    const totalSpace = Object.values(results).reduce((sum, item) => sum + item.space, 0);
    res.json({ ok: true, results, totalSpace });
  }),
);

/**
 * GET /api/system/df
 * 获取磁盘使用统计（docker system df），并附加概要字段供展示
 */
router.get(
  '/df',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const df: any = await docker.df();

    // 从原始 df 对象中汇总各资源类别的大小与数量
    const images = df?.Images || [];
    const containers = df?.Containers || [];
    const volumes = df?.Volumes || [];
    const buildCache = df?.BuildCache || [];

    // 镜像占用 = 各镜像 Size 之和（仅统计非共享层大小由下层承担，此处累加 Size）
    const imagesSize = images.reduce((sum: number, img: any) => sum + toNum(img?.Size), 0);
    // 容器可写层大小（SizeRw）
    const containersSizeRw = containers.reduce((sum: number, c: any) => sum + toNum(c?.SizeRw), 0);
    // 卷占用 = 各卷 UsageData.Size 之和
    const volumesSize = volumes.reduce((sum: number, v: any) => sum + toNum(v?.UsageData?.Size), 0);
    // build cache 占用 = 各缓存 Size 之和
    const buildCacheSize = buildCache.reduce((sum: number, c: any) => sum + toNum(c?.Size), 0);

    // 粗略估算可回收空间：悬空镜像层 + 已停止容器可写层 + 未使用卷 + build cache
    const danglingImagesSize = images
      .filter((img: any) => Array.isArray(img?.RepoTags) && img.RepoTags.length === 0)
      .reduce((sum: number, img: any) => sum + toNum(img?.Size), 0);
    const stoppedContainersSize = containers
      .filter((c: any) => c?.State !== 'running' && c?.State !== 'paused')
      .reduce((sum: number, c: any) => sum + toNum(c?.SizeRw), 0);
    // totalReclaimable 采用各类型可回收字段更精确求和；字段缺失时回退到估算值
    const sumOf = (arr: any[], key: string, fallback: number): number => {
      const vals = arr.map((x: any) => toNum(x?.[key])).filter((v) => v > 0);
      return vals.length === arr.length ? vals.reduce((a, b) => a + b, 0) : fallback;
    };
    const imagesReclaimable = sumOf(images, 'Reclaimable', danglingImagesSize);
    const containersReclaimable = sumOf(containers, 'Reclaimable', stoppedContainersSize);
    // 卷的可回收 = 未被任何容器引用的卷占用（RefCount===0）
    const volumesReclaimable = volumes
      .filter((v: any) => toNum(v?.UsageData?.RefCount) === 0)
      .reduce((sum: number, v: any) => sum + toNum(v?.UsageData?.Size), 0);
    const buildCacheReclaimable = sumOf(buildCache, 'Reclaimable', buildCacheSize);
    const totalReclaimable =
      imagesReclaimable + containersReclaimable + volumesReclaimable + buildCacheReclaimable;

    res.json({
      df,
      summary: {
        layersSize: toNum(df?.LayersSize),
        buildCacheCount: buildCache.length,
        buildCacheSize,
        imagesCount: images.length,
        imagesSize,
        containersCount: containers.length,
        containersSizeRw,
        volumesCount: volumes.length,
        volumesSize,
        totalReclaimable,
        // 各类型精确可回收空间（供清理页展示真实可回收量）
        imagesReclaimable,
        containersReclaimable,
        volumesReclaimable,
        buildCacheReclaimable,
      },
    });
  }),
);

// ============ 系统设置 / 账号管理 ============

/**
 * GET /api/system/settings
 * 获取本服务运行配置摘要（端口、版本）+ Docker 引擎信息（供设置页"关于"使用）
 */
router.get(
  '/settings',
  asyncHandler(async (_req: Request, res: Response) => {
    let engine: any = null;
    try {
      const docker = await getDockerClient();
      const [info, version] = await Promise.all([docker.info(), docker.version()]);
      engine = {
        name: info.Name,
        os: info.OperatingSystem,
        arch: info.Architecture,
        cpu: info.NCPU,
        mem: info.MemTotal,
        dockerVersion: version.Version,
        apiVersion: version.ApiVersion,
        containers: info.Containers,
        running: info.ContainersRunning,
        images: info.Images,
        serverVersion: info.ServerVersion,
      };
    } catch {
      engine = null;
    }
    // 面板自身版本：读取 package.json
    let version = '0.1.0';
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
      version = pkg.version || version;
    } catch {
      // ignore
    }
    res.json({ port: SERVICE_PORT, version, engine });
  }),
);

/**
 * GET /api/system/update-check
 * 查询 GitHub Releases 获取最新版本号（用于前端更新提示）
 */
router.get(
  '/update-check',
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch('https://api.github.com/repos/13861419/dockerDesktop/releases/latest', {
        signal: controller.signal,
        headers: { 'User-Agent': 'docker-manager' },
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        return res.json({ available: false, error: `GitHub API ${resp.status}` });
      }
      const data = await resp.json() as { tag_name?: string; html_url?: string };
      const latest = (data.tag_name || '').replace(/^v/, '');
      // 读取当前版本
      let current = '0.1.0';
      try {
        const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
        current = pkg.version || current;
      } catch { /* ignore */ }
      res.json({
        available: latest && latest !== current,
        current,
        latest: latest || current,
        url: data.html_url || '',
      });
    } catch (e: any) {
      res.json({ available: false, error: e?.message || '检查更新失败' });
    }
  }),
);

/**
 * GET /api/system/users
 * 获取全部用户
 */
router.get(
  '/users',
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(listUsers());
  }),
);

/**
 * POST /api/system/users
 * 新增用户
 * body: { username, password, role? }
 */
router.post(
  '/users',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { username, password, role } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '需要用户名和密码' });
    }
    if (userExists(String(username))) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' });
    }
    try {
      // 角色白名单：管理员 / 运维 / 普通用户 / 审计员（只读）四选一，非法值按普通用户处理
      const normalizedRole: 'admin' | 'operator' | 'user' | 'auditor' =
        role === 'operator' ? 'operator' : role === 'admin' ? 'admin' : role === 'auditor' ? 'auditor' : 'user';
      addUser(String(username), String(password), normalizedRole);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || '新增用户失败' });
    }
  }),
);

/**
 * DELETE /api/system/users/:name
 * 删除用户
 */
router.delete(
  '/users/:name',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    try {
      deleteUser(req.params.name);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || '删除用户失败' });
    }
  }),
);

/**
 * POST /api/system/password
 * 修改密码
 * body: { username, oldPassword, newPassword }
 * 校验原密码后更新，防止任意登录用户篡改他人密码。
 */
router.post(
  '/password',
  asyncHandler(async (req: Request, res: Response) => {
    const { username, oldPassword, newPassword } = req.body || {};
    if (!username || !newPassword) {
      return res.status(400).json({ error: '需要用户名和新密码' });
    }
    if (!oldPassword) {
      return res.status(400).json({ error: '请输入原密码' });
    }
    try {
      changePassword(String(username), String(oldPassword), String(newPassword));
      // 修改的是自己的密码时，使现有会话保持有效即可；这里直接返回成功
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || '修改密码失败' });
    }
  }),
);

/**
 * GET /api/system/backup
 * 导出面板数据库备份（下载 SQLite 文件）
 */
router.get(
  '/backup',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const backupPath = exportDatabase();
    res.download(backupPath, `docker-manager-backup-${Date.now()}.db`, (err) => {
      // 下载完成后清理临时备份文件
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {
        // ignore
      }
      if (err && !res.headersSent) {
        res.status(500).json({ error: '备份文件下载失败' });
      }
    });
  }),
);

/**
 * POST /api/system/restore
 * 恢复面板数据库（上传 SQLite 备份文件，application/octet-stream）
 */
router.post(
  '/restore',
  requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  asyncHandler(async (req: Request, res: Response) => {
      const raw = req.body as Buffer | undefined;
      if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) {
        return res.status(400).json({ error: '请求体为空，请上传有效的数据库备份文件' });
      }
      try {
        const result = importDatabaseBuffer(raw);
        logOperation(res.locals.username, '恢复数据库', 'system', null, '上传备份文件');
        res.json({ ok: true, users: result.users });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || '数据库恢复失败' });
      }
    },
  ),
);

export default router;
