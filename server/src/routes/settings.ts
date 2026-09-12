/**
 * 统一配置中心 API 路由（挂载路径 /api/settings）
 *
 * - GET  /api/settings        已知设置 + 值 + 来源 + 分组（登录即可读；secret 只回显 configured）
 * - PUT  /api/settings        批量更新（body: { key: value, ... }，管理员）
 * - PUT  /api/settings/:key   单个更新（管理员）
 * - DELETE /api/settings/:key 恢复默认（清除落库值，回退 env/default，管理员）
 */
import { Router, Request, Response } from 'express';
import { requireAdmin, requireAuth } from '../auth';
import { listSettings, setSetting, resetSetting, validateSetting, getSettingRaw } from '../settings';
import { logOperation } from '../operationLog';

const router = Router();

/** 取设置项类型（用于审计脱敏） */
function settingType(key: string): string {
  const item = listSettings().find((x) => x.key === key);
  return item?.type || 'string';
}

/** 序列化设置值用于操作日志：secret 脱敏为 ***，超长截断 */
function describeSettingValue(key: string, value: any): string {
  if (settingType(key) === 'secret') {
    return value === undefined || value === null || value === '' ? '(空)' : '***';
  }
  const s = String(value);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

/**
 * GET /api/settings
 * 返回全部已注册设置（按 group/key 排序）
 */
router.get('/', requireAuth, (_req: Request, res: Response) => {
  res.json({ items: listSettings() });
});

/**
 * PUT /api/settings
 * 批量更新。body: { key: value, ... }；逐项校验，全部通过才提交（任一失败返回 400 且不落库）。
 */
router.put('/', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const body = req.body || {};
  const keys = Object.keys(body).filter((k) => k && typeof k === 'string');
  if (!keys.length) {
    return res.status(400).json({ error: '缺少待更新的设置项' });
  }
// 先校验（保证原子性：全部合法才写入）
for (const key of keys) {
  const err = validateSetting(key, body[key]);
  if (err) {
    return res.status(400).json({ error: err });
  }
}
// 变更审计：记录旧值（1.44.0）
const oldVals = new Map<string, any>();
for (const key of keys) {
  const raw = getSettingRaw(key);
  if (raw) oldVals.set(key, raw.value);
}
for (const key of keys) {
  setSetting(key, body[key]);
}
const detail = keys
  .map((k) => `${k}: ${oldVals.has(k) ? describeSettingValue(k, oldVals.get(k)) : '(默认)'} → ${describeSettingValue(k, body[k])}`)
  .join('; ');
logOperation(res.locals.username, '更新系统设置', 'system', keys.join(', '), detail);
res.json({ ok: true, updated: keys });
});

/**
 * PUT /api/settings/:key
 * 单项更新。
 */
router.put(
  '/:key',
  requireAuth,
  requireAdmin,
(req: Request, res: Response) => {
const key = String(req.params.key || '');
// 变更审计：记录旧值（1.44.0）
const raw = getSettingRaw(key);
const oldValue = raw ? describeSettingValue(key, raw.value) : '(默认)';
try {
  setSetting(key, req.body?.value);
} catch (err: any) {
  return res.status(err?.statusCode || 500).json({ error: err?.message || '更新失败' });
}
logOperation(res.locals.username, '更新系统设置', 'system', key, `${key}: ${oldValue} → ${describeSettingValue(key, req.body?.value)}`);
res.json({ ok: true, key });
},
);

/**
 * DELETE /api/settings/:key
 * 恢复默认（删除落库值，读取回退到 env/default）。
 */
router.delete(
  '/:key',
  requireAuth,
  requireAdmin,
(req: Request, res: Response) => {
const key = String(req.params.key || '');
// 变更审计：记录被恢复前的落库值（1.44.0）
const raw = getSettingRaw(key);
resetSetting(key);
logOperation(
  res.locals.username,
  '恢复设置默认值',
  'system',
  key,
  `${key}: ${raw ? describeSettingValue(key, raw.value) : '(默认)'} → (默认)`,
);
res.json({ ok: true, key });
},
);

export default router;
