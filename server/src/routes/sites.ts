/**
 * 站点 / SSL / 反向代理 API 路由（挂载路径 /api/sites）
 *
 * 管理反向代理站点：域名 → 上游(host:port)，由内置 nginx 容器承载。
 * 站点配置持久化于 SQLite（sites 表）；每次站点变更后重新生成 nginx 配置
 * 到 <dataDir>/nginx/conf.d/ 并重启内置 nginx 反代容器（尽力而为：容器不存在/无法创建时
 * 仅保存配置并提示，不中断站点 CRUD）。
 *
 * SSL：站点可启用 HTTPS，证书文件放置于宿主机路径并写入配置（cert_path）。
 * 不包含 ACME 自动签发，避免引入额外依赖。
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from '../storage';
import { getDockerClient } from '../docker/client';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/** 站点行 */
interface SiteRow {
  id: string;
  domain: string;
  upstream_host: string;
  upstream_port: number;
  listen_port: number;
  enable_https: number;
  cert_path: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** 反代容器名（单实例） */
const PROXY_CONTAINER = 'dm-reverse-proxy';
/** nginx 配置目录（宿主机侧，挂载进容器 /etc/nginx/conf.d） */
const NGINX_DIR_NAME = 'nginx';

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
 * 获取 nginx 配置目录绝对路径
 */
function nginxDir(): string {
  return path.join(__dirname, '..', '..', '..', 'data', NGINX_DIR_NAME);
}

/**
 * 校验输入
 */
function validateInput(body: any): SiteRow {
  const domain = String(body?.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const upstreamHost = String(body?.upstreamHost || '').trim();
  const upstreamPort = Number(body?.upstreamPort);
  if (!domain) throw Object.assign(new Error('域名不能为空'), { statusCode: 400 });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/.test(domain)) {
    throw Object.assign(new Error('域名格式不正确'), { statusCode: 400 });
  }
  if (!upstreamHost) throw Object.assign(new Error('上游地址不能为空'), { statusCode: 400 });
  if (!(upstreamPort >= 1 && upstreamPort <= 65535)) {
    throw Object.assign(new Error('上游端口无效'), { statusCode: 400 });
  }
  let listenPort = Number(body?.listenPort) || 80;
  if (body?.enableHttps) listenPort = Number(body?.listenPort) || 443;
  if (!(listenPort >= 1 && listenPort <= 65535)) {
    throw Object.assign(new Error('监听端口无效'), { statusCode: 400 });
  }
  return {
    id: '',
    domain,
    upstream_host: upstreamHost,
    upstream_port: upstreamPort,
    listen_port: listenPort,
    enable_https: body?.enableHttps ? 1 : 0,
    cert_path: body?.certPath ? String(body.certPath).trim() : null,
    enabled: body?.enabled === false ? 0 : 1,
    created_at: 0,
    updated_at: 0,
  };
}

/**
 * 生成所有站点的 nginx conf.d 配置
 * @param sites 站点列表
 * @returns 配置文件名 → 内容
 */
function generateConfigs(sites: SiteRow[]): Record<string, string> {
  const files: Record<string, string> = {};
  const enabledSites = sites.filter((s) => s.enabled);
  for (const s of enabledSites) {
    const safeName = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const upstream = `http://${s.upstream_host}:${s.upstream_port}`;
    if (s.enable_https && s.cert_path) {
      files[`${safeName}.conf`] = [
        `server {`,
        `  listen ${s.listen_port} ssl;`,
        `  server_name ${s.domain};`,
        `  ssl_certificate ${s.cert_path};`,
        `  ssl_certificate_key ${s.cert_path.replace(/\.(crt|pem)$/i, '.key')};`,
        `  location / {`,
        `    proxy_pass ${upstream};`,
        `    proxy_set_header Host $host;`,
        `    proxy_set_header X-Real-IP $remote_addr;`,
        `    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
        `    proxy_set_header X-Forwarded-Proto $scheme;`,
        `  }`,
        `}`,
      ].join('\n');
    } else {
      files[`${safeName}.conf`] = [
        `server {`,
        `  listen ${s.listen_port};`,
        `  server_name ${s.domain};`,
        `  location / {`,
        `    proxy_pass ${upstream};`,
        `    proxy_set_header Host $host;`,
        `    proxy_set_header X-Real-IP $remote_addr;`,
        `    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
        `    proxy_set_header X-Forwarded-Proto $scheme;`,
        `  }`,
        `}`,
      ].join('\n');
    }
  }
  return files;
}

/**
 * 将生成的配置写入宿主机 nginx 目录（清空旧配置，写入新配置）
 * @param files 配置映射
 */
function writeConfigFiles(files: Record<string, string>): void {
  const dir = nginxDir();
  fs.mkdirSync(dir, { recursive: true });
  // 清理旧的站点配置（避免残留域名）
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.conf')) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // 忽略
      }
    }
  }
  // 写入默认 server（nginx 启动需要至少一个 server 块）
  if (Object.keys(files).length === 0) {
    fs.writeFileSync(
      path.join(dir, '_default.conf'),
      ['server {', '  listen 80 default_server;', '  return 444;', '}'].join('\n'),
    );
  } else {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }
}

/**
 * 确保内置 nginx 反代容器存在（尽力而为）
 * @returns 是否可用（容器存在并运行）
 */
async function ensureProxyContainer(): Promise<boolean> {
  try {
    const docker = await getDockerClient();
    const containers = await docker.listContainers({ all: true });
    const existing = containers.find((c: any) => c.Names?.includes('/' + PROXY_CONTAINER));
    if (existing) {
      if (existing.State !== 'running') {
        await docker.getContainer(existing.Id).restart();
      }
      return true;
    }
    // 尝试创建：挂载 nginx 配置目录
    const hostDir = nginxDir();
    await docker.createContainer({
      name: PROXY_CONTAINER,
      Image: 'nginx:stable-alpine',
      HostConfig: {
        PortBindings: { '80/tcp': [{ HostPort: '80' }], '443/tcp': [{ HostPort: '443' }] },
        Binds: [`${hostDir}:/etc/nginx/conf.d:ro`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
    });
    await docker.getContainer(PROXY_CONTAINER).start();
    return true;
  } catch {
    return false;
  }
}

/**
 * 应用站点配置（拉取最新站点 → 生成配置 → 写盘 → 重启 nginx 容器）
 */
async function syncReverseProxy(): Promise<{ ok: boolean; message: string }> {
  const d = getDb();
  const sites = d.prepare('SELECT * FROM sites').all() as unknown as SiteRow[];
  const files = generateConfigs(sites);
  writeConfigFiles(files);
  try {
    const avail = await ensureProxyContainer();
    if (!avail) {
      return { ok: false, message: '配置已写入，但内置反代容器无法创建/重启（请确认 Docker 可用并有 nginx 镜像）' };
    }
    // 重启以加载新配置
    const docker = await getDockerClient();
    try {
      await docker.getContainer(PROXY_CONTAINER).restart();
    } catch {
      // 忽略重启失败
    }
    return { ok: true, message: `已应用 ${sites.filter((s) => s.enabled).length} 个站点配置` };
  } catch {
    return { ok: false, message: '配置已生成，反代容器刷新失败（Docker 不可用）' };
  }
}

/**
 * GET /api/sites
 * 列出全部站点
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const d = getDb();
    const rows = d.prepare('SELECT * FROM sites ORDER BY created_at ASC').all() as unknown as SiteRow[];
    res.json({
      sites: rows.map((r) => ({
        id: r.id,
        domain: r.domain,
        upstreamHost: r.upstream_host,
        upstreamPort: r.upstream_port,
        listenPort: r.listen_port,
        enableHttps: !!r.enable_https,
        certPath: r.cert_path || '',
        enabled: !!r.enabled,
      })),
    });
  }),
);

/**
 * POST /api/sites
 * 新增站点并应用配置
 */
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const v = validateInput(req.body);
    const d = getDb();
    const dup = d.prepare('SELECT id FROM sites WHERE domain = ?').get(v.domain);
    if (dup) return res.status(400).json({ error: '该域名已存在站点' });
    const id = crypto.randomUUID();
    const now = Date.now();
    d.prepare(
      'INSERT INTO sites (id, domain, upstream_host, upstream_port, listen_port, enable_https, cert_path, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, v.domain, v.upstream_host, v.upstream_port, v.listen_port, v.enable_https, v.cert_path, v.enabled, now, now);
    const result = await syncReverseProxy();
    logOperation(res.locals.username, '新增站点', '反代', v.domain);
    res.json({ ok: true, id, proxy: result });
  }),
);

/**
 * PUT /api/sites/:id
 * 更新站点并应用配置
 */
router.put(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow | undefined;
    if (!row) return res.status(404).json({ error: '站点不存在' });
    const v = validateInput({ ...req.body, domain: req.body?.domain ?? row.domain });
    d.prepare(
      'UPDATE sites SET domain=?, upstream_host=?, upstream_port=?, listen_port=?, enable_https=?, cert_path=?, enabled=?, updated_at=? WHERE id=?',
    ).run(v.domain, v.upstream_host, v.upstream_port, v.listen_port, v.enable_https, v.cert_path, v.enabled, Date.now(), id);
    const result = await syncReverseProxy();
    logOperation(res.locals.username, '更新站点', '反代', v.domain);
    res.json({ ok: true, proxy: result });
  }),
);

/**
 * DELETE /api/sites/:id
 * 删除站点并应用配置
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT domain FROM sites WHERE id = ?').get(id) as { domain: string } | undefined;
    if (!row) return res.status(404).json({ error: '站点不存在' });
    d.prepare('DELETE FROM sites WHERE id = ?').run(id);
    const result = await syncReverseProxy();
    logOperation(res.locals.username, '删除站点', '反代', row.domain);
    res.json({ ok: true, proxy: result });
  }),
);

/**
 * POST /api/sites/:id/toggle
 * 启停站点
 */
router.post(
  '/:id/toggle',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT enabled FROM sites WHERE id = ?').get(id) as { enabled: number } | undefined;
    if (!row) return res.status(404).json({ error: '站点不存在' });
    d.prepare('UPDATE sites SET enabled = ?, updated_at = ? WHERE id = ?').run(row.enabled ? 0 : 1, Date.now(), id);
    const result = await syncReverseProxy();
    res.json({ ok: true, enabled: !row.enabled, proxy: result });
  }),
);

/**
 * POST /api/sites/reload
 * 重新生成配置并重启反代容器
 */
router.post(
  '/reload',
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await syncReverseProxy();
    if (!result.ok) return res.status(502).json({ error: result.message, ok: false });
    res.json({ ok: true, message: result.message });
  }),
);

/**
 * GET /api/sites/:id/cert
 * 查看站点证书状态
 */
router.get(
  '/:id/cert',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT cert_path FROM sites WHERE id = ?').get(id) as { cert_path: string | null } | undefined;
    if (!row) return res.status(404).json({ error: '站点不存在' });
    let exists = false;
    let expiresAt: string | null = null;
    if (row.cert_path) {
      exists = fs.existsSync(row.cert_path);
      if (exists) {
        const crt = String(row.cert_path);
        try {
          const pem = fs.readFileSync(crt, 'utf8');
          const m = pem.match(/Not After\s*:\s*(.+)/i) || pem.match(/,(\d{2}\s+[A-Za-z]{3}\s+\d{4}[\s\S]*?GMT)/i);
          if (m?.[1]) expiresAt = m[1].trim();
        } catch {
          // 忽略解析错误
        }
      }
    }
    res.json({ certPath: row.cert_path || '', exists, expiresAt });
  }),
);

/**
 * POST /api/sites/:id/cert
 * 替换站点证书（express.raw 接收 .crt，.key 通过 query 的 keyPath 指定）
 * query: certPath=证书文件路径 & keyPath=私钥文件路径
 */
router.post(
  '/:id/cert',
  express.raw({ type: 'application/octet-stream', limit: '10mb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT domain FROM sites WHERE id = ?').get(id) as { domain: string } | undefined;
    if (!row) return res.status(404).json({ error: '站点不存在' });
    const certPath = String(req.query.certPath || '').trim();
    const keyPath = String(req.query.keyPath || '').trim();
    if (!certPath) return res.status(400).json({ error: '缺少证书路径' });
    const raw = req.body as Buffer | undefined;
    if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) {
      return res.status(400).json({ error: '空证书内容' });
    }
    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    fs.writeFileSync(certPath, raw);
    d.prepare('UPDATE sites SET cert_path = ?, updated_at = ? WHERE id = ?').run(certPath, Date.now(), id);
    const result = await syncReverseProxy();
    logOperation(res.locals.username, '替换站点证书', '反代', row.domain);
    res.json({ ok: true, certPath, keyPath, proxy: result });
  }),
);

export default router;
