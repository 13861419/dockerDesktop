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
  // 反代高级配置
  enable_ws: number;
  enable_gzip: number;
  enable_auth: number;
  auth_username: string | null;
  auth_password: string | null;
  rate_limit: string | null;
  client_max_body: string | null;
  proxy_timeout: number;
  extra_config: string | null;
  created_at: number;
  updated_at: number;
}

/** 反代容器名（单实例） */
const PROXY_CONTAINER = 'dm-reverse-proxy';
/** nginx 配置目录（宿主机侧，挂载进容器 /etc/nginx/conf.d） */
const NGINX_DIR_NAME = 'nginx';

/**
 * 将明文密码生成为 nginx htpasswd 的 {SHA} 条目值（nginx 原生支持，无需外部工具，零依赖）
 * @param password 明文密码
 * @returns htpasswd 密码字段值（如 {SHA}xxxx）
 */
function htpasswdSha(password: string): string {
  const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest();
  return `{SHA}${sha1.toString('base64')}`;
}

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
 * 校验输入并规整为站点行（含反代高级配置）
 * @param body 请求体
 * @param existing 已存在的站点行（PUT 时用于保留未变更的密码等字段）
 * @returns 规整后的站点行（不含 id/时间戳，由调用方补齐）
 */
function validateInput(body: any, existing?: SiteRow | null): SiteRow {
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

  // 反代高级配置
  const enableWs = body?.enableWs ? 1 : 0;
  const enableGzip = body?.enableGzip ? 1 : 0;
  const enableAuth = body?.enableAuth ? 1 : 0;
  const authUsername = enableAuth ? String(body?.authUsername || '').trim() : '';
  if (enableAuth && !authUsername) {
    throw Object.assign(new Error('开启访问控制时必须填写用户名'), { statusCode: 400 });
  }
  // 密码：传入明文则计算 {SHA}；否则（未提供或留空）沿用已有密码（PUT 场景）
  let authPasswordHash: string | null = existing?.auth_password || null;
  const rawPass = body?.authPassword != null ? String(body.authPassword) : '';
  if (rawPass !== '') {
    if (rawPass.length < 4) {
      throw Object.assign(new Error('访问控制密码长度至少 4 位'), { statusCode: 400 });
    }
    authPasswordHash = htpasswdSha(rawPass);
  }
  if (enableAuth && !authPasswordHash) {
    throw Object.assign(new Error('开启访问控制时必须设置密码'), { statusCode: 400 });
  }

  const rateLimit = String(body?.rateLimit || '').trim();
  if (rateLimit && !/^\d+(?:\.\d+)?r\/(s|m|h|d)$/.test(rateLimit)) {
    throw Object.assign(new Error('限速格式应为如 5r/s、1r/m 等'), { statusCode: 400 });
  }
  let clientMaxBody = String(body?.clientMaxBody || '').trim();
  if (clientMaxBody && !/^\d+[kKmMgG]$/.test(clientMaxBody)) {
    throw Object.assign(new Error('请求体上限格式应为如 10m、512k 等'), { statusCode: 400 });
  }
  if (!clientMaxBody) clientMaxBody = '1m';
  const proxyTimeout = Math.max(Number(body?.proxyTimeout) || 60, 5);
  const extraConfig = String(body?.extraConfig || '').trim();

  return {
    id: '',
    domain,
    upstream_host: upstreamHost,
    upstream_port: upstreamPort,
    listen_port: listenPort,
    enable_https: body?.enableHttps ? 1 : 0,
    cert_path: body?.certPath ? String(body.certPath).trim() : null,
    enabled: body?.enabled === false ? 0 : 1,
    // 高级配置
    enable_ws: enableWs,
    enable_gzip: enableGzip,
    enable_auth: enableAuth,
    auth_username: enableAuth ? authUsername : null,
    auth_password: enableAuth ? authPasswordHash : null,
    rate_limit: rateLimit || null,
    client_max_body: clientMaxBody,
    proxy_timeout: proxyTimeout,
    extra_config: extraConfig || null,
    created_at: 0,
    updated_at: 0,
  };
}

/**
 * 生成单个站点的 nginx server 配置片段（含反代高级配置）
 * @param s 站点行
 * @param authFile 该站点 htpasswd 文件宿主机绝对路径（未启用 auth 时为空串）
 * @returns nginx server 配置块
 */
function siteServerBlock(s: SiteRow, authFile: string): string {
  const lines: string[] = [];
  const schema = s.enable_https ? 'https' : 'http';
  const listen = s.enable_https && s.cert_path
    ? `  listen ${s.listen_port} ssl;`
    : `  listen ${s.listen_port};`;
  lines.push('server {');
  lines.push(listen);
  lines.push(`  server_name ${s.domain};`);
  if (s.enable_https && s.cert_path) {
    lines.push(`  ssl_certificate ${s.cert_path};`);
    lines.push(`  ssl_certificate_key ${s.cert_path.replace(/\.(crt|pem)$/i, '.key')};`);
  }

  // 自定义高级配置片段（server 级，location 外）
  if (s.extra_config) {
    const cleaned = String(s.extra_config).trim().replace(/^\{|\}$/g, '').trim();
    if (cleaned) lines.push(cleaned);
  }

  // 启用 gzip 压缩（server 上下文中合法）
  if (s.enable_gzip) {
    lines.push('  gzip on;');
    lines.push('  gzip_comp_level 5;');
    lines.push('  gzip_min_length 1k;');
    lines.push('  gzip_http_version 1.1;');
    lines.push('  gzip_types text/plain text/css application/javascript application/json application/xml image/svg+xml;');
  }

  // 请求体大小上限
  lines.push(`  client_max_body_size ${s.client_max_body || '1m'};`);

  // Basic Auth 访问控制
  if (s.enable_auth && s.auth_username && authFile && s.auth_password) {
    lines.push(`  auth_basic "Restricted";`);
    lines.push(`  auth_basic_user_file ${authFile};`);
  }

  const timeout = s.proxy_timeout || 60;
  const upstream = `http://${s.upstream_host}:${s.upstream_port}`;
  lines.push('  location / {');
  if (s.enable_auth && s.auth_username && authFile && s.auth_password) {
    lines.push('    auth_basic "Restricted";');
    lines.push(`    auth_basic_user_file ${authFile};`);
  }
  if (s.rate_limit) {
    lines.push(`    limit_req zone=site_${s.id} burst=20 nodelay;`);
  }
  lines.push(`    proxy_pass ${upstream};`);
  lines.push('    proxy_http_version 1.1;');
  lines.push('    proxy_set_header Host $host;');
  lines.push('    proxy_set_header X-Real-IP $remote_addr;');
  lines.push('    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
  lines.push(`    proxy_set_header X-Forwarded-Proto ${schema};`);
  lines.push(`    proxy_read_timeout ${timeout}s;`);
  lines.push(`    proxy_send_timeout ${timeout}s;`);
  if (s.enable_ws) {
    // WebSocket：透传 Upgrade/Connection 升级头，并延长空闲超时
    lines.push('    proxy_set_header Upgrade $http_upgrade;');
    lines.push('    proxy_set_header Connection "upgrade";');
    lines.push(`    proxy_read_timeout 3600s;`);
  }
  lines.push('  }');
  lines.push('}');
  return lines.join('\n');
}

/**
 * 生成所有站点的 nginx conf.d 配置（含站点配置 + 限速 zone 定义 + http 公共块）
 * @param sites 站点列表
 * @returns 配置文件名 → 内容
 */
function generateConfigs(sites: SiteRow[]): Record<string, string> {
  const files: Record<string, string> = {};
  const enabledSites = sites.filter((s) => s.enabled);

  // 限速 zone 定义（http 上下文，conf.d 每个文件顶层即为 http 上下文）
  const zones = enabledSites
    .filter((s) => s.rate_limit)
    .map((s) => `limit_req_zone $binary_remote_addr zone=site_${s.id}:10m rate=${s.rate_limit};`)
    .join('\n');
  if (zones) {
    files['_limits.conf'] = zones + '\n';
  }

  // Basic Auth 凭据文件（宿主机路径，供 auth_basic_user_file 引用）
  const authDir = path.join(nginxDir(), 'auth');
  const authFiles: Record<string, string> = {};
  for (const s of enabledSites) {
    if (s.enable_auth && s.auth_username && s.auth_password) {
      const authPath = path.join(authDir, `${s.id}.htpasswd`);
      authFiles[s.id] = authPath;
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(authPath, `${s.auth_username}:${s.auth_password}\n`);
    }
  }
  // 清理不再需要的 auth 文件（避免凭据残留）
  if (fs.existsSync(authDir)) {
    for (const f of fs.readdirSync(authDir)) {
      if (f.endsWith('.htpasswd')) {
        const id = f.replace(/\.htpasswd$/, '');
        if (!authFiles[id]) {
          try {
            fs.unlinkSync(path.join(authDir, f));
          } catch {
            // 忽略
          }
        }
      }
    }
  }

  for (const s of enabledSites) {
    const safeName = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    files[`${safeName}.conf`] = siteServerBlock(s, authFiles[s.id] || '');
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
        // 反代高级配置（密码不回传原文，仅标记是否已设置）
        enableWs: !!r.enable_ws,
        enableGzip: !!r.enable_gzip,
        enableAuth: !!r.enable_auth,
        authUsername: r.enable_auth && r.auth_username ? r.auth_username : '',
        authPasswordSet: !!(r.enable_auth && r.auth_password),
        rateLimit: r.rate_limit || '',
        clientMaxBody: r.client_max_body || '1m',
        proxyTimeout: r.proxy_timeout || 60,
        extraConfig: r.extra_config || '',
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
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const v = validateInput(req.body);
    const d = getDb();
    const dup = d.prepare('SELECT id FROM sites WHERE domain = ?').get(v.domain);
    if (dup) return res.status(400).json({ error: '该域名已存在站点' });
    const id = crypto.randomUUID();
    const now = Date.now();
    d.prepare(
      'INSERT INTO sites (id, domain, upstream_host, upstream_port, listen_port, enable_https, cert_path, enabled, enable_ws, enable_gzip, enable_auth, auth_username, auth_password, rate_limit, client_max_body, proxy_timeout, extra_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, v.domain, v.upstream_host, v.upstream_port, v.listen_port, v.enable_https, v.cert_path, v.enabled,
      v.enable_ws, v.enable_gzip, v.enable_auth, v.auth_username, v.auth_password, v.rate_limit, v.client_max_body, v.proxy_timeout, v.extra_config,
      now, now,
    );
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
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow | undefined;
    if (!row) return res.status(404).json({ error: '站点不存在' });
    // 合并现有高级配置作为默认，避免前端未传字段被误重置（密码等）
    const merged = {
      ...req.body,
      domain: req.body?.domain ?? row.domain,
      enableWs: req.body?.enableWs ?? !!row.enable_ws,
      enableGzip: req.body?.enableGzip ?? !!row.enable_gzip,
      enableAuth: req.body?.enableAuth ?? !!row.enable_auth,
      authUsername: req.body?.authUsername ?? row.auth_username,
      rateLimit: req.body?.rateLimit ?? row.rate_limit ?? '',
      clientMaxBody: req.body?.clientMaxBody ?? row.client_max_body ?? '1m',
      proxyTimeout: req.body?.proxyTimeout ?? row.proxy_timeout ?? 60,
      extraConfig: req.body?.extraConfig ?? row.extra_config ?? '',
    };
    const v = validateInput(merged, row);
    d.prepare(
      'UPDATE sites SET domain=?, upstream_host=?, upstream_port=?, listen_port=?, enable_https=?, cert_path=?, enabled=?, enable_ws=?, enable_gzip=?, enable_auth=?, auth_username=?, auth_password=?, rate_limit=?, client_max_body=?, proxy_timeout=?, extra_config=?, updated_at=? WHERE id=?',
    ).run(
      v.domain, v.upstream_host, v.upstream_port, v.listen_port, v.enable_https, v.cert_path, v.enabled,
      v.enable_ws, v.enable_gzip, v.enable_auth, v.auth_username, v.auth_password, v.rate_limit, v.client_max_body, v.proxy_timeout, v.extra_config,
      Date.now(), id,
    );
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
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT domain, enabled FROM sites WHERE id = ?').get(id) as { domain: string; enabled: number } | undefined;
    if (!row) return res.status(404).json({ error: '站点不存在' });
    d.prepare('UPDATE sites SET enabled = ?, updated_at = ? WHERE id = ?').run(row.enabled ? 0 : 1, Date.now(), id);
    const result = await syncReverseProxy();
    logOperation(res.locals.username, row.enabled ? '停用站点' : '启用站点', '反代', row.domain);
    res.json({ ok: true, enabled: !row.enabled, proxy: result });
  }),
);

/**
 * POST /api/sites/reload
 * 重新生成配置并重启反代容器
 */
router.post(
  '/reload',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await syncReverseProxy();
    if (!result.ok) return res.status(502).json({ error: result.message, ok: false });
    logOperation(res.locals.username, '重载反代配置', '反代', 'reverse-proxy', result.message);
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
  requireAdmin,
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
