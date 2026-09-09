/**
 * 容器镜像自动更新 API（挂载路径 /api/image-updates）
 *
 * - GET    /                    列出全部条目（按加入时间倒序）
 * - POST   /                    加入/更新条目 body: { containerId, containerName?, enabled? }
 * - DELETE /:containerId        移除条目
 * - POST   /check               立即检查 body: { containerId }（单容器，返回结果）
 * - POST   /run                 立即扫描全部启用条目
 *
 * 'imageUpdate' 计划任务类型：周期性调用 runImageUpdateScan() 扫描启用条目，
 * 在计划任务页新建「镜像自动更新」类型任务即可配置扫描周期。
 */
import { Router, Request, Response } from 'express';
import { requireAdmin, requireAuth } from '../auth';
import { logOperation } from '../operationLog';
import { getDb } from '../storage';
import { getDockerClient } from '../docker/client';
import { registerTaskHandler, type CronTaskRow, type TaskRunResult } from '../scheduler';
import { runImageUpdateScan, checkOne, type AutoUpdateRow } from '../docker/imageUpdate';

const router = Router();

/** 立即检查的进行中标记（防止并发重复检查同一容器） */
const checking = new Set<string>();

/** 查询全部条目（新 → 旧） */
function listRows(): AutoUpdateRow[] {
  return getDb()
    .prepare('SELECT * FROM container_auto_updates ORDER BY id DESC')
    .all() as unknown as AutoUpdateRow[];
}

/** GET / — 条目列表 */
router.get('/', requireAuth, (_req: Request, res: Response) => {
  res.json({ items: listRows() });
});

/** POST / — 加入或更新条目（容器存在性在此校验） */
router.post('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const containerId = String(req.body?.containerId || '').trim();
  if (!containerId) {
    return res.status(400).json({ error: '缺少容器 id' });
  }
  const enabled = req.body?.enabled !== false;
  try {
    const docker = await getDockerClient();
    const info = await docker.getContainer(containerId).inspect();
    const name = (info.Name || '').replace(/^\//, '');
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO container_auto_updates (container_id, container_name, image_ref, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(container_id) DO UPDATE SET enabled = excluded.enabled, container_name = excluded.container_name, updated_at = excluded.updated_at`,
      )
      .run(containerId, name, info.Config?.Image || '', req.body?.enabled === false ? 0 : 1, now, now);
    logOperation(res.locals.username, '配置镜像自动更新', 'container', name, enabledText(req.body?.enabled), true);
    res.json({ ok: true, item: listRows().find((r) => r.container_id === containerId) });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || '容器不存在' });
  }
});

/** DELETE /:containerId — 移除条目 */
router.delete('/:containerId', requireAuth, requireAdmin, (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM container_auto_updates WHERE container_id = ?').run(req.params.containerId);
  logOperation(res.locals.username, '移除镜像自动更新', 'container', req.params.containerId.slice(0, 12), '', true);
  res.json({ ok: true });
});

/** POST /check — 立即检查单个容器（同步等待结果） */
router.post('/check', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const containerId = String(req.body?.containerId || '').trim();
  if (!containerId) {
    return res.status(400).json({ error: '缺少容器 id' });
  }
  const row = listRows().find((r) => r.container_id === containerId);
  if (!row) {
    return res.status(404).json({ error: '该容器未加入自动更新' });
  }
  if (checking.has(containerId)) {
    return res.status(409).json({ error: '该容器正在检查中' });
  }
  checking.add(containerId);
  try {
    const outcome = await checkOne(row);
    res.json(outcome);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '检查失败' });
  } finally {
    checking.delete(containerId);
  }
});

/** POST /run — 立即扫描全部启用条目 */
router.post('/run', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  const result = await runImageUpdateScan(res.locals.username || 'manual');
  res.json(result);
});

function enabledText(v: unknown): string {
  return v === false ? '关闭' : '开启';
}

// ============ 计划任务类型注册 ============

registerTaskHandler('imageUpdate', async (_task: CronTaskRow, _config: Record<string, any>): Promise<TaskRunResult> => {
  const result = await runImageUpdateScan('scheduler');
  return { ok: result.ok, detail: result.detail };
});

export default router;
