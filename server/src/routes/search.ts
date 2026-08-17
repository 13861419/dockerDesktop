/**
 * 全局搜索 API 路由（挂载路径 /api/search）
 *
 * 提供跨资源的一次性聚合搜索：按关键字在 容器 / 镜像 / 数据卷 / 网络 / Compose 项目
 * 中模糊匹配（名称/ID/镜像名等），返回分组结果，供前端顶栏全局搜索框展示并跳转。
 *
 * 容错：单类资源拉取失败不影响其它类别（返回的 each group 独立处理）。
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDockerClient } from '../docker/client';

const router = Router();

/** Compose 项目根目录（与 tasks.ts / compose.ts 保持一致，支持环境变量覆盖） */
const COMPOSE_ROOT = process.env.COMPOSE_ROOT
  ? process.env.COMPOSE_ROOT
  : path.join(os.tmpdir(), 'docker-compose-projects');

/** 统一兜底错误处理 */
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
 * 大小写不敏感的包含匹配
 * @param q 关键字（小写）
 * @param value 待匹配文本
 * @returns 是否命中
 */
function hit(q: string, value: string | undefined | null): boolean {
  if (!value) return false;
  return value.toLowerCase().indexOf(q) !== -1;
}

/**
 * 扫描 COMPOSE_ROOT 下所有项目目录名并做模糊匹配
 * @param q 关键字（小写）
 * @returns 匹配到的项目名数组
 */
function searchComposeProjects(q: string): string[] {
  if (!fs.existsSync(COMPOSE_ROOT)) return [];
  return fs
    .readdirSync(COMPOSE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && hit(q, d.name))
    .map((d) => d.name);
}

/**
 * 从容器 Names 中提取首个显示名（去前导斜杠）
 * @param names 容器 Names 数组
 * @returns 显示名，无则返回 ID 前 12 位
 */
function containerName(names: string[] | undefined, id: string): string {
  if (names && names.length && names[0]) return names[0].replace(/^\//, '');
  return id.slice(0, 12);
}

/**
 * GET /api/search?q=
 * 聚合搜索容器 / 镜像 / 数据卷 / 网络 / Compose 项目。
 * q 为空返回空分组。每类返回 [] 表示无命中；各字段 name/id 供前端展示与跳转。
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) {
      res.json({ containers: [], images: [], volumes: [], networks: [], compose: [] });
      return;
    }

    const docker = await getDockerClient();
    const resp: Record<string, any[]> = { containers: [], images: [], volumes: [], networks: [], compose: [] };

    // 容器：按名称 / ID / 镜像名 匹配
    try {
      const list = (await docker.listContainers({ all: true })) as any[];
      resp.containers = list
        .filter(
          (c) =>
            hit(q, containerName(c.Names, c.Id)) ||
            hit(q, c.Id) ||
            hit(q, c.Image) ||
            (c.Names || []).some((n: string) => hit(q, n)),
        )
        .slice(0, 20)
        .map((c) => ({
          id: c.Id,
          name: containerName(c.Names, c.Id),
          image: c.Image,
          state: c.State,
        }));
    } catch {
      resp.containers = [];
    }

    // 镜像：按 RepoTag / ID 匹配
    try {
      const imgs = (await docker.listImages()) as any[];
      resp.images = imgs
        .filter(
          (i) =>
            (i.RepoTags || []).some((t: string) => hit(q, t)) || hit(q, i.Id),
        )
        .slice(0, 20)
        .map((i) => ({
          id: i.Id,
          name: (i.RepoTags && i.RepoTags[0]) || (i.Id && i.Id.slice(0, 12)) || '(未命名)',
        }));
    } catch {
      resp.images = [];
    }

    // 数据卷：按名称匹配
    try {
      const vols = (await docker.listVolumes()) as any;
      const volumes = vols?.Volumes || [];
      resp.volumes = volumes
        .filter((v: any) => hit(q, v.Name) || hit(q, v.Driver || ''))
        .slice(0, 20)
        .map((v: any) => ({ id: v.Name, name: v.Name, driver: v.Driver || '' }));
    } catch {
      resp.volumes = [];
    }

    // 网络：按名称 / ID 匹配
    try {
      const nets = (await docker.listNetworks()) as any[];
      resp.networks = nets
        .filter((n) => hit(q, n.Name) || hit(q, n.Id))
        .slice(0, 20)
        .map((n) => ({ id: n.Id, name: n.Name, driver: n.Driver || '' }));
    } catch {
      resp.networks = [];
    }

    // Compose 项目
    resp.compose = searchComposeProjects(q).slice(0, 20).map((name) => ({ id: name, name }));

    res.json(resp);
  }),
);

export default router;
