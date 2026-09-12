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
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataDir } from '../storage';

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

/** 从 docker 多路复用流中解出文本输出（stdout/stderr 合并） */
function demuxToString(buf: Buffer): string {
  let out = '';
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset + 4);
    out += buf.slice(offset + 8, offset + 8 + len).toString('utf8');
    offset += 8 + len;
  }
  if (offset === 0 && buf.length) out = buf.toString('utf8');
  return out;
}

/** 在运行中的容器内执行命令并返回合并输出 */
async function execOutput(docker: any, containerId: string, cmd: string[], timeoutMs = 8000): Promise<string> {
  const exec = await docker.getContainer(containerId).exec.create({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', resolve);
    setTimeout(resolve, timeoutMs);
  });
  return demuxToString(Buffer.concat(chunks));
}

/**
 * 用 registry:2 镜像一次性容器生成 htpasswd bcrypt 哈希
 * （registry:2 自带 htpasswd 工具，官方推荐用法）
 */
async function generateHtpasswd(user: string, password: string): Promise<string> {
  const docker = await getDockerClient();
  const container = await docker.createContainer({
    Image: 'registry:2',
    Entrypoint: ['htpasswd'],
    Cmd: ['-Bbn', user, password],
    HostConfig: {},
  });
  try {
    await container.start();
    await container.wait();
    const logs = await container.logs({ stdout: true, stderr: false, follow: false });
    const buf = Buffer.isBuffer(logs) ? logs : Buffer.concat((logs as any).chunks || []);
    const out = demuxToString(buf).trim();
    // 输出格式：user:$2y$05$...（bcrypt）
    const hashLine = out.split('\n').find((l) => l.trim().startsWith('$2') || l.includes(':$2'));
    const hash = hashLine?.includes(':') ? hashLine.split(':').slice(1).join(':').trim() : hashLine?.trim() || '';
    if (!hash.startsWith('$2')) throw new Error('htpasswd 输出异常: ' + out.slice(0, 80));
    return hash;
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

router.get(
  '/status',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const docker = await getDockerClient();
      const cache = await findCache(docker);
      let authEnabled = false;
      let diskUsageMb: number | null = null;
      if (cache?.running) {
        // 从容器环境变量识别认证状态
        const insp = await docker.getContainer(cache.id).inspect();
        authEnabled = (insp.Config?.Env || []).some((e: string) => e === 'REGISTRY_AUTH=htpasswd');
        // 缓存磁盘占用（MB，du -sm /var/lib/registry）
        try {
          const out = await execOutput(docker, cache.id, ['du', '-sm', '/var/lib/registry']);
          const mb = parseInt(out.trim().split(/\s+/)[0] || '', 10);
          if (Number.isFinite(mb)) diskUsageMb = mb;
        } catch {
          // 统计失败不影响状态展示
        }
      }
      res.json({
        deployed: Boolean(cache),
        running: cache?.running || false,
        port: HOST_PORT,
        authEnabled,
        diskUsageMb,
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
    // 可选访问认证（1.43.0）：REGISTRY_AUTH=htpasswd，凭证写入 <数据目录>/registry-auth/htpasswd
    const authEnabled = req.body?.authEnabled === true;
    let authPassword = '';
    const extraEnv: string[] = [];
    const extraBinds: string[] = [];
    if (authEnabled) {
      const authDir = path.join(getDataDir(), 'registry-auth');
      fs.mkdirSync(authDir, { recursive: true });
      const authUser = 'admin';
      authPassword = crypto.randomBytes(9).toString('base64url');
      const hash = await generateHtpasswd(authUser, authPassword);
      fs.writeFileSync(path.join(authDir, 'htpasswd'), `${authUser}:${hash}\n`, 'utf8');
      extraEnv.push('REGISTRY_AUTH=htpasswd', 'REGISTRY_AUTH_HTPASSWD_REALM=Registry Realm', 'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd');
      extraBinds.push(`${authDir}:/auth`);
    }
    const stream = await docker.pull('registry:2');
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      stream.resume();
    });
    await docker.createContainer({
      name: CACHE_NAME,
      Image: 'registry:2',
      Env: [`REGISTRY_PROXY_REMOTEURL=${remote}`, ...extraEnv],
      HostConfig: {
        RestartPolicy: { Name: 'always' },
        PortBindings: { '5000/tcp': [{ HostPort: String(HOST_PORT) }] },
        Binds: extraBinds,
      },
    });
    const container = docker.getContainer(CACHE_NAME);
    await container.start();
    logOperation(
      res.locals.username,
      '部署镜像缓存',
      'container',
      CACHE_NAME,
      `remote: ${remote}; auth: ${authEnabled ? 'htpasswd(admin)' : 'off'}`,
    );
    res.json({
      ok: true,
      port: HOST_PORT,
      authEnabled,
      // 认证凭证仅在开启认证时返回一次（密码为随机生成）
      credentials: authEnabled ? { username: 'admin', password: authPassword } : null,
      mirrorSnippet: `{ "registry-mirrors": ["http://<本机IP>:${HOST_PORT}"] }`,
    });
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
