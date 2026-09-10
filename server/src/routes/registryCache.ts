/**
 * 统一镜像仓库缓存（1.34.0）
 *
 * 在当前引擎上部署一个 registry:2 拉透缓存（REGISTRY_PROXY_REMOTEURL 指向 Docker Hub），
 * 其他节点在 daemon.json 配置 registry-mirrors 指向该缓存后，重复拉取的公共镜像
 * 只会从 Hub 下载一次，后续全部命中本地缓存，加速多节点分发。
 *
 * - GET  /status   查询缓存容器状态
 * - POST /deploy   部署缓存容器（默认端口 5060）
 * - POST /remove   移除缓存容器
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { requireAdmin, requireAuth } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();
const CACHE_NAME = 'dm-registry-cache';
const HOST_PORT = 5060;

function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      res.status(status).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/** 查询缓存容器（不存在返回 null） */
async function findCache(docker: any): Promise<{ id: string; running: boolean } | null> {
  const all = await docker.listContainers({ all: true });
  const hit = all.find((c: any) => c.Names?.[0] === `/${CACHE_NAME}`);
  if (!hit) return null;
  return { id: hit.Id, running: hit.State === 'running' };
}

router.get(
  '/status',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const docker = await getDockerClient();
      const cache = await findCache(docker);
      res.json({
        deployed: Boolean(cache),
        running: cache?.running || false,
        port: HOST_PORT,
        mirrorSnippet: `{ "registry-mirrors": ["http://<本机IP>:${HOST_PORT}"] }`,
      });
    } catch (err: any) {
      res.json({ deployed: false, running: false, port: HOST_PORT, error: err?.message });
    }
  }),
);

router.post(
  '/deploy',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const existing = await findCache(docker);
    if (existing?.running) {
      return res.json({ ok: true, alreadyRunning: true, port: HOST_PORT });
    }
    if (existing) await docker.getContainer(existing.id).remove({ force: true });
    const remote = String(req.body?.remoteUrl || 'https://registry-1.docker.io');
    const stream = await docker.pull('registry:2');
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      stream.resume();
    });
    await docker.createContainer({
      name: CACHE_NAME,
      Image: 'registry:2',
      Env: [`REGISTRY_PROXY_REMOTEURL=${remote}`],
      HostConfig: {
        RestartPolicy: { Name: 'always' },
        PortBindings: { '5000/tcp': [{ HostPort: String(HOST_PORT) }] },
      },
    });
    const container = docker.getContainer(CACHE_NAME);
    await container.start();
    logOperation(res.locals.username, '部署镜像缓存', 'container', CACHE_NAME, `remote: ${remote}`);
    res.json({ ok: true, port: HOST_PORT, mirrorSnippet: `{ "registry-mirrors": ["http://<本机IP>:${HOST_PORT}"] }` });
  }),
);

router.post(
  '/remove',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const existing = await findCache(docker);
    if (!existing) return res.json({ ok: true, removed: false });
    await docker.getContainer(existing.id).remove({ force: true });
    logOperation(res.locals.username, '移除镜像缓存', 'container', CACHE_NAME, '');
    res.json({ ok: true, removed: true });
  }),
);

export default router;
