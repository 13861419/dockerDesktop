/**
 * Webhook 触发路由（匿名入口）
 *
 * POST /api/webhook/:token —— 依据 URL 中的 token 依次匹配：
 *   1. cron_tasks.webhook_token → 异步执行该任务（复用 tasks.dispatchTask）
 *   2. deploy_apps.webhook_token → 异步触发 Git 部署（复用 deploys 的执行入口）
 * 命中后立即返回 200。
 * 安全：token 为 16/32 字节随机 hex；可选 Header X-Docker-Panel-Token 二次校验。
 */
import { Router, Request, Response } from 'express';
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
 * 按 webhook token 查询部署应用
 */
function findDeployAppByToken(token: string): { id: number; name: string } | null {
  const row = getDb()
    .prepare('SELECT id, name FROM deploy_apps WHERE webhook_token = ?')
    .get(token) as unknown as { id: number; name: string } | undefined;
  return row || null;
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
    const started = triggerDeployByToken(app.id, 'webhook');
    if (!started) {
      return res.status(409).json({ error: '该应用正在部署中' });
    }
    return res.json({ ok: true, deployAppId: app.id, name: app.name });
  }

  return res.status(404).json({ error: 'Webhook token 无效或已失效' });
});

export default router;
