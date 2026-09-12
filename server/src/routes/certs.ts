/**
 * SSL 证书 API 路由（挂载路径 /api/certs）
 *
 *  - GET    /             列出已签发证书（不含 PEM 内容）
 *  - GET    /status       http-01 挑战服务状态与 ACME 目录地址
 *  - POST   /issue        签发证书 { domains: 'a.com,b.com' | ['a.com'] }
 *  - POST   /renew        立即执行一轮续期巡检（管理员）
 *  - DELETE /:id          删除证书（主域名）
 *
 * 签发使用 Let's Encrypt（可用 ACME_DIRECTORY_URL 切换 staging），http-01 验证；
 * 挑战服务监听 80 端口（ACME_HTTP_PORT 可覆盖）。
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAdmin, requireAuth } from '../auth';
import { getDb } from '../storage';
import { CERTS_DIR, currentDirectoryUrl, issueCertificate, renewDueCertificates, sanitizeDomains } from '../acme/issue';
import { challengeServerStatus } from '../acme/challengeServer';
import { logOperation } from '../operationLog';

const router = Router();

interface SslCertRow {
  id: string;
  domains: string;
  cert_pem: string;
  key_pem: string;
  source: string;
  issued_at: number;
  expires_at: number;
  created_at: number;
}

/** 行 → 响应体（附带落盘路径，不含敏感内容） */
function serialize(row: SslCertRow) {
  const domains: string[] = JSON.parse(row.domains || '[]');
  const dir = path.join(CERTS_DIR, row.id);
  return {
    id: row.id,
    domains,
    source: row.source,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    certPath: path.join(dir, `${row.id}.pem`),
    keyPath: path.join(dir, `${row.id}.key`),
    certFileReady: fs.existsSync(path.join(dir, `${row.id}.pem`)),
  };
}

/**
 * GET /api/certs
 * 列出全部证书（登录即可查看）。
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = getDb()
      .prepare('SELECT * FROM ssl_certs ORDER BY created_at DESC')
      .all() as unknown as SslCertRow[];
    res.json({ certs: (rows || []).map(serialize) });
  }),
);

/**
 * GET /api/certs/status
 * http-01 挑战服务状态与 ACME 目录地址。
 */
router.get(
  '/status',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      challengeServer: challengeServerStatus(),
      directoryUrl: currentDirectoryUrl(),
    });
  }),
);

/**
 * POST /api/certs/issue
 * 签发证书：{ domains }，完成 http-01 验证后自动落盘并入库。
 */
router.post(
  '/issue',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const domains = sanitizeDomains(req.body?.domains);
    const result = await issueCertificate(domains, `admin@${domains[0]}`);
    res.status(201).json({
      ok: true,
      domains: result.domains,
      issuedAt: result.issuedAt,
      expiresAt: result.expiresAt,
    });
    logOperation(res.locals.username, '签发 SSL 证书', 'cert', domains[0], domains.join(', '));
  }),
);

/**
 * POST /api/certs/renew
 * 立即执行一轮续期巡检（管理员），返回每张到期临近证书的续期结果。
 */
router.post(
  '/renew',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const results = await renewDueCertificates();
    res.json({ ok: true, results });
    logOperation(res.locals.username, 'SSL 证书续期巡检', 'cert', '-', `${results.length} 张待处理`);
  }),
);

/**
 * DELETE /api/certs/:id
 * 删除证书记录与本地文件（不影响站点已生成的 nginx 配置）。
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getDb().prepare('SELECT id FROM ssl_certs WHERE id = ?').get(req.params.id);
    if (!row) {
      res.status(404).json({ error: '证书不存在' });
      return;
    }
    getDb().prepare('DELETE FROM ssl_certs WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
    logOperation(res.locals.username, '删除 SSL 证书', 'cert', req.params.id);
  }),
);

/** asyncHandler：包装 async 路由，异常统一交给错误中间件 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      const status = err?.statusCode || 500;
      if (!res.headersSent) {
        res.status(status).json({ error: err?.message || '内部错误' });
      }
    });
  };
}

export default router;
