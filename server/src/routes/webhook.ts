/**
 * Webhook 触发路由（匿名入口）
 *
 * POST /api/webhook/:token —— 依据 URL 中的 token 依次匹配：
 *   1. cron_tasks.webhook_token → 异步执行该任务（复用 tasks.dispatchTask）
 *   2. deploy_apps.webhook_token → 异步触发 Git 部署（复用 deploys 的执行入口）
 * 命中后立即返回 200。
 * 安全：token 为 16/32 字节随机 hex；可选 Header X-Docker-Panel-Token 二次校验；
 *       部署应用可配置 HMAC 签名密钥（webhook_secret），启用后必须携带
 *       X-Hub-Signature-256: sha256=<hex>（GitHub/Gitea 兼容），用原始请求体计算。
 */
import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from '../storage';
import { dispatchTask } from './tasks';
import { triggerDeployByToken } from './deploys';
import { logOperation } from '../operationLog';

const router = Router();

/**
 * 按 webhook token 查询任务
 * @param token token
 * @returns 任务行或 null
 */
function findTaskByWebhookToken(token: string): { id: string; name: string } | null {
  const row = getDb()
    .prepare('SELECT id, name FROM cron_tasks WHERE webhook_token = ?')
    .get(token) as unknown as { id: string; name: string } | undefined;
  return row || null;
}

/**
 * 按 webhook token 查询部署应用（附带 HMAC 签名密钥）
 */
function findDeployAppByToken(token: string): { id: number; name: string; webhook_secret: string | null } | null {
  const row = getDb()
    .prepare('SELECT id, name, webhook_secret FROM deploy_apps WHERE webhook_token = ?')
    .get(token) as unknown as { id: number; name: string; webhook_secret: string | null } | undefined;
  return row || null;
}

/**
 * 校验 Git Webhook 的 X-Hub-Signature-256 签名（GitHub/Gitea 兼容）
 * @param secret 预共享签名密钥
 * @param rawBody 原始请求体字节（app.ts 的 express.json verify 回调暂存）
 * @param signature 请求头中的签名，形如 "sha256=<hex>"
 * @returns 签名有效返回 true
 */
export function verifyHubSignature(
  secret: string,
  rawBody: Buffer | undefined,
  signature: string,
): boolean {
  if (!rawBody || rawBody.length === 0) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(signature.trim());
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(m[1], 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * POST /api/webhook/:token
 * 触发匹配的任务/部署（异步）；未匹配返回 404
 */
router.post('/:token', (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  const headerToken = String(req.headers['x-docker-panel-token'] || '');
  // 可选 Header 二次校验：Header 若携带则必须与 path token 一致，否则 403
  if (headerToken && headerToken !== token) {
    return res.status(403).json({ error: 'X-Docker-Panel-Token 校验失败' });
  }

  const task = findTaskByWebhookToken(token);
  if (task) {
    // 异步执行，不阻塞响应
    dispatchTask(task.id)
      .then((r) => {
        logOperation('webhook', r?.ok ? 'Webhook 触发任务执行' : 'Webhook 触发任务执行（失败）', 'task', task.name, r?.detail, r?.ok);
      })
      .catch((err) => {
        // 触发异常时记录服务端错误日志，便于排障
        console.error(`[webhook] 触发任务执行失败 taskId=${task.id}:`, err?.message || err);
      });
    return res.json({ ok: true, taskId: task.id, name: task.name });
  }

  const app = findDeployAppByToken(token);
  if (app) {
    // 配置了签名密钥时强制校验 X-Hub-Signature-256，防止 token 泄露后被伪造触发
    const secret = app.webhook_secret || '';
    if (secret) {
      const sig = String(req.headers['x-hub-signature-256'] || '');
      const rawBody = (req as any).rawBody as Buffer | undefined;
      if (!verifyHubSignature(secret, rawBody, sig)) {
        logOperation('webhook', 'Webhook 签名校验被拒', 'compose', app.name, '缺少或无效的 X-Hub-Signature-256', false);
        return res.status(401).json({ error: 'Webhook 签名校验失败' });
      }
    }
    const started = triggerDeployByToken(app.id, 'webhook');
    if (!started) {
      return res.status(409).json({ error: '该应用正在部署中' });
    }
    return res.json({ ok: true, deployAppId: app.id, name: app.name });
  }

  return res.status(404).json({ error: 'Webhook token 无效或已失效' });
});

export default router;
