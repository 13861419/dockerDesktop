/**
 * 镜像 GC 策略 API 路由（挂 /api/gc）
 *
 *  - POST /api/gc/plan ：按策略计算清理计划（只读，不删除）
 *  - POST /api/gc/run  ：执行清理（删除前在服务端重算 plan 作双保险，绝不删在用镜像）
 *
 * 全部 requireAdmin（删除不可逆）。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { logOperation } from '../operationLog';
import { requireAuth, requireAdmin } from '../auth';
import { planGc, collectGcImages, summarizePlan, bytesText, type GcPolicy } from '../gc';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      res.status(err?.statusCode || 500).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/** 解析策略（数值合理性校验） */
function parsePolicy(body: any): GcPolicy {
  const policy: GcPolicy = {};
  if (body.keepPerRepo !== undefined) {
    const v = Number(body.keepPerRepo);
    if (Number.isFinite(v) && v >= 0 && v <= 1000) policy.keepPerRepo = Math.floor(v);
  }
  if (body.olderThanDays !== undefined) {
    const v = Number(body.olderThanDays);
    if (Number.isFinite(v) && v >= 0 && v <= 36500) policy.olderThanDays = Math.floor(v);
  }
  policy.pruneDangling = body.pruneDangling === true;
  return policy;
}

/**
 * POST /api/gc/plan
 * 计算清理计划（只读，不删除）
 * body: { keepPerRepo?, olderThanDays?, pruneDangling? }
 */
router.post(
  '/plan',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const images = await collectGcImages(docker);
    const plan = planGc(images, parsePolicy(req.body || {}));
    res.json({
      ...plan,
      totals: { toFree: plan.totals.toFree, bytes: plan.totals.bytes, bytesText: bytesText(plan.totals.bytes) },
    });
  }),
);

/**
 * POST /api/gc/run
 * 执行清理（服务端重算 plan 双保险；绝不删在用镜像）
 * body 同 plan。返回删除清单与回收空间。
 */
router.post(
  '/run',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const policy = parsePolicy(req.body || {});
    const images = await collectGcImages(docker);
    const plan = planGc(images, policy);

    const deleted: string[] = [];
    let bytes = 0;
    for (const cand of plan.candidates) {
      try {
        const info = await docker.getImage(cand.id).remove().catch(() => null);
        if (Array.isArray(info)) {
          for (const it of info as any[]) {
            const name = it?.Untagged || it?.Deleted || '';
            if (name && !deleted.includes(name)) deleted.push(name);
          }
        } else {
          deleted.push(cand.tags[0] || cand.id.slice(0, 12));
        }
        bytes += cand.size || 0;
      } catch {
        // 删除失败（可能仍被引用等）跳过，不影响其它
      }
    }

    const detail = summarizePlan(plan) + `\n实际删除: ${deleted.length} 个, 释放 ${bytesText(bytes)}`;
    logOperation(
      res.locals.username,
      '镜像GC策略清理',
      'image',
      null,
      `候选 ${plan.totals.toFree} 个, 实际删除 ${deleted.length} 个, 释放 ${bytesText(bytes)}`,
    );
    res.json({ ok: true, deleted, spaceReclaimed: bytes, detail, policy });
  }),
);

export default router;
