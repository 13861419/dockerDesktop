/**
 * 运维工具箱后端路由（1.75.9）
 *
 * 仅两个需要面板服务器发起的网络探测，其余工具均为纯前端：
 *  - POST /api/tools/dns  ：域名解析查询（Node 内置 dns 模块，零依赖）
 *  - POST /api/tools/ssl  ：SSL 证书查看（Node 内置 tls 模块，零依赖）
 *
 * 安全：均需登录；输入做长度与字符白名单校验；DNS 查询带 5 秒超时。
 */
import { Router, Request, Response } from 'express';
import dns from 'dns';
import tls from 'tls';
import { requireAuth } from '../auth';

const router = Router();

/** 校验主机名/IP：字母数字点横线下划线冒号（IPv6 冒号），限 255 字符，防注入 */
function isValidHost(host: string): boolean {
  return host.length > 0 && host.length <= 255 && /^[a-zA-Z0-9._:-]+$/.test(host);
}

/** 带超时包装 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('查询超时')), ms))]);
}

/**
 * POST /api/tools/dns
 * 域名解析查询
 * body: { host: string }
 */
router.post('/dns', (req: Request, res: Response) => {
  const host = String((req.body || {}).host || '').trim();
  if (!isValidHost(host)) {
    return res.status(400).json({ error: '请输入合法的域名或 IP' });
  }
  const resolver = dns.promises;
  const jobs: Record<string, Promise<unknown>> = {
    a: withTimeout(resolver.resolve4(host).catch(() => []), 5000),
    aaaa: withTimeout(resolver.resolve6(host).catch(() => []), 5000),
    cname: withTimeout(resolver.resolveCname(host).catch(() => []), 5000),
    txt: withTimeout(resolver.resolveTxt(host).catch(() => []), 5000),
    mx: withTimeout(resolver.resolveMx(host).catch(() => []), 5000),
    ns: withTimeout(resolver.resolveNs(host).catch(() => []), 5000),
  };
  Promise.all(Object.entries(jobs).map(async ([k, p]) => [k, await p] as const))
    .then((entries) => {
      const out: Record<string, unknown> = { host };
      for (const [k, v] of entries) out[k] = v;
      res.json(out);
    })
    .catch(() => res.status(500).json({ error: '解析查询失败' }));
});

/**
 * POST /api/tools/ssl
 * SSL 证书查看：与目标主机完成 TLS 握手并返回对端证书信息
 * body: { host: string, port?: number }
 */
router.post('/ssl', (req: Request, res: Response) => {
  const host = String((req.body || {}).host || '').trim();
  const port = Number((req.body || {}).port) || 443;
  if (!isValidHost(host)) {
    return res.status(400).json({ error: '请输入合法的域名或 IP' });
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return res.status(400).json({ error: '端口须为 1-65535' });
  }
  let settled = false;
  const socket = tls.connect(
    {
      host,
      port,
      servername: host,
      rejectUnauthorized: false, // 查看器允许自签证书，展示详情由用户自行判断
      timeout: 8000,
    },
    () => {
      settled = true;
      const cert = socket.getPeerCertificate();
      const san = (cert as any)?.subjectaltname || '';
      res.json({
        host,
        port,
        subject: (cert as any)?.subject?.CN || '',
        issuer: (cert as any)?.issuer?.O || (cert as any)?.issuer?.CN || '',
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        daysLeft: Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000),
        sans: san
          ? san
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [],
        authorized: socket.authorized,
        authorizationError: socket.authorizationError || '',
      });
      socket.end();
    },
  );
  socket.on('error', (err) => {
    if (settled) return;
    settled = true;
    res.status(400).json({ error: `连接失败: ${err.message}` });
  });
  socket.on('timeout', () => {
    if (settled) return;
    settled = true;
    socket.destroy();
    res.status(400).json({ error: '连接超时' });
  });
});

export default router;
