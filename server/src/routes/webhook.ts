/**
 * Webhook 触发路由（匿名入口）
 *
 * POST /api/webhook/:token —— 依据 URL 中的 token 匹配 cron_tasks.webhook_token，
 * 命中后异步触发该任务执行（复用 tasks.dispatchTask），立即返回 200。
 * 安全：token 为 32 字节随机 hex；可选 Header X-Docker-Panel-Token 二次校验。
 */
import { Router, Request, Response } from 'express';
import { getDb } from '../storage';
import { dispatchTask } from './tasks';
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
 * POST /api/webhook/:token
 * 触发匹配任务的执行（异步）；未匹配返回 404
 */
router.post('/:token', (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  const headerToken = String(req.headers['x-docker-panel-token'] || '');
  const row = findTaskByWebhookToken(token);
  if (!row) {
    return res.status(404).json({ error: 'Webhook token 无效或已失效' });
  }
  // 可选 Header 二次校验：Header 若携带则必须与 path token 一致，否则 403
  if (headerToken && headerToken !== token) {
    return res.status(403).json({ error: 'X-Docker-Panel-Token 校验失败' });
  }
  // 异步执行，不阻塞响应
  dispatchTask(row.id)
    .then((r) => {
      logOperation('webhook', r?.ok ? 'Webhook 触发任务执行' : 'Webhook 触发任务执行（失败）', 'task', row.name, r?.detail, r?.ok);
    })
    .catch(() => {
      // 失败已在 dispatchTask / 调度器内记录
    });
  res.json({ ok: true, taskId: row.id, name: row.name });
});

export default router;
