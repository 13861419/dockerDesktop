/**
 * OpenAPI 文档路由（1.4.0）
 *
 * GET /api/openapi.json —— 输出核心端点的 OpenAPI 3.0 文档（需登录，与面板其他接口一致）。
 */
import { Router, Request, Response } from 'express';
import { buildOpenApiDocument } from '../openapi';
import { requireAuth } from '../auth';

const router = Router();

router.get('/openapi.json', requireAuth, (req: Request, res: Response) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = String(req.headers.host || req.hostname || 'localhost:9528');
  res.json(buildOpenApiDocument(`${proto}://${host}`));
});

export default router;
