/**
 * 容器模板库路由（挂载路径 /api/templates）
 *
 * 提供对 container_templates 表的完整 CRUD：
 *  - 列表（GET）、新增（POST，管理员）、更新（PUT，管理员）、删除（DELETE，管理员）
 *  - config 字段保存容器配置 JSON（与 /api/containers/:id/config 导出的 config 结构兼容），
 *    供容器页"从模板创建"一键回填。
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../storage';
import { requireAdmin } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();

/** 模板表记录行结构（config 为原始字符串） */
interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  image: string;
  config: string;
  created_at: number;
  updated_at: number;
}

/** 对外返回的模板对象（config 已解析为对象） */
interface TemplateItem {
  id: string;
  name: string;
  description: string;
  image: string;
  config: any;
  createdAt: number;
  updatedAt: number;
}

/** 统一兜底错误处理 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      res.status(status).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/**
 * 将数据库行转换为对外返回对象：config 字符串解析为 JSON 对象
 * @param row 数据库行
 * @returns 解析后的模板对象
 */
function toItem(row: TemplateRow): TemplateItem {
  let config: any = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch {
    config = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    image: row.image || '',
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 校验模板名称非空、唯一（查重）
 * @param name 模板名称
 * @param excludeId 需排除自身的 id（更新时使用，避免与自身冲突）
 * @throws 不合法时抛 400 / 409
 */
function validateName(name: string, excludeId?: string): void {
  const n = String(name || '').trim();
  if (!n) {
    throw Object.assign(new Error('模板名称不能为空'), { statusCode: 400 });
  }
  const d = getDb();
  const dup = excludeId
    ? d.prepare('SELECT id FROM container_templates WHERE name = ? AND id != ?').get(n, excludeId)
    : d.prepare('SELECT id FROM container_templates WHERE name = ?').get(n);
  if (dup) {
    throw Object.assign(new Error(`模板名称「${n}」已存在`), { statusCode: 409 });
  }
}

/**
 * GET /api/templates
 * 列出全部容器模板，按创建时间倒序（最新在前）
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = getDb()
      .prepare('SELECT * FROM container_templates ORDER BY created_at DESC')
      .all() as unknown as TemplateRow[];
    res.json(rows.map(toItem));
  }),
);

/**
 * POST /api/templates
 * 新增一个容器模板（管理员）
 * @body name        模板名称（必填，唯一）
 * @body description 描述（可选）
 * @body image       主镜像（可选）
 * @body config      容器配置 JSON 对象（可选，缺省为 {}）
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    validateName(name);
    const description = String(body.description || '').trim();
    const image = String(body.image || '').trim();
    const config = body.config && typeof body.config === 'object' ? body.config : {};
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .prepare(
        'INSERT INTO container_templates (id, name, description, image, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, description || null, image, JSON.stringify(config), now, now);
    logOperation(res.locals.username, '新增容器模板', 'template', name);
    const row = getDb().prepare('SELECT * FROM container_templates WHERE id = ?').get(id) as unknown as TemplateRow;
    res.status(201).json(toItem(row));
  }),
);

/**
 * PUT /api/templates/:id
 * 更新指定容器模板（管理员）
 * @param id        模板 id
 * @body name        模板名称（可选，唯一）
 * @body description 描述（可选）
 * @body image       主镜像（可选）
 * @body config      容器配置 JSON 对象（可选）
 */
router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT * FROM container_templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) {
      throw Object.assign(new Error('模板不存在'), { statusCode: 404 });
    }
    const body = req.body || {};
    const name = body.name !== undefined ? String(body.name).trim() : row.name;
    validateName(name, id);
    const description = body.description !== undefined ? String(body.description).trim() : row.description || '';
    const image = body.image !== undefined ? String(body.image).trim() : row.image || '';
    const config = body.config && typeof body.config === 'object' ? body.config : JSON.parse(row.config || '{}');
    const now = Math.floor(Date.now() / 1000);
    d.prepare(
      'UPDATE container_templates SET name = ?, description = ?, image = ?, config = ?, updated_at = ? WHERE id = ?',
    ).run(name, description || null, image, JSON.stringify(config), now, id);
    logOperation(res.locals.username, '更新容器模板', 'template', name);
    const updated = d.prepare('SELECT * FROM container_templates WHERE id = ?').get(id) as unknown as TemplateRow;
    res.json(toItem(updated));
  }),
);

/**
 * DELETE /api/templates/:id
 * 删除指定容器模板（管理员）
 * @param id 模板 id
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT name FROM container_templates WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    if (!row) {
      throw Object.assign(new Error('模板不存在'), { statusCode: 404 });
    }
    d.prepare('DELETE FROM container_templates WHERE id = ?').run(id);
    logOperation(res.locals.username, '删除容器模板', 'template', row.name);
    res.json({ ok: true });
  }),
);

export default router;
