/**
 * Compose 模板库路由（挂载路径 /api/compose-templates）
 *
 * 提供对 compose_templates 表的完整 CRUD：
 *  - 列表（GET）、新增（POST，管理员）、更新（PUT，管理员）、删除（DELETE，管理员）
 *  - content 字段保存 compose 文件原文（YAML 文本），
 *    供 Compose 页"从模板新建"一键回填与"保存为模板"持久化。
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getDb } from '../storage';
import { requireAdmin } from '../auth';
import { logOperation } from '../operationLog';

const router = Router();

/** 模板表记录行结构（content 为原始 YAML 字符串） */
interface ComposeTemplateRow {
  id: string;
  name: string;
  description: string | null;
  content: string;
  created_at: number;
  updated_at: number;
}

/** 对外返回的模板对象 */
interface ComposeTemplateItem {
  id: string;
  name: string;
  description: string;
  content: string;
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
 * 将数据库行转换为对外返回对象（content 原样返回）
 * @param row 数据库行
 * @returns 模板对象
 */
function toItem(row: ComposeTemplateRow): ComposeTemplateItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    content: row.content || '',
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
    ? d.prepare('SELECT id FROM compose_templates WHERE name = ? AND id != ?').get(n, excludeId)
    : d.prepare('SELECT id FROM compose_templates WHERE name = ?').get(n);
  if (dup) {
    throw Object.assign(new Error(`模板名称「${n}」已存在`), { statusCode: 409 });
  }
}

/**
 * GET /api/compose-templates
 * 列出全部 Compose 模板，按创建时间倒序（最新在前）。需登录，无需管理员。
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = getDb()
      .prepare('SELECT * FROM compose_templates ORDER BY created_at DESC')
      .all() as unknown as ComposeTemplateRow[];
    res.json(rows.map(toItem));
  }),
);

/**
 * POST /api/compose-templates
 * 新增一个 Compose 模板（管理员）
 * @body name        模板名称（必填，唯一）
 * @body description 描述（可选）
 * @body content     compose 文件内容（必填，非空）
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    validateName(name);
    const content = String(body.content || '');
    if (!content.trim()) {
      throw Object.assign(new Error('模板内容不能为空'), { statusCode: 400 });
    }
    const description = String(body.description || '').trim();
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .prepare(
        'INSERT INTO compose_templates (id, name, description, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, description || null, content, now, now);
    logOperation(res.locals.username, '新增 Compose 模板', 'template', name);
    const row = getDb().prepare('SELECT * FROM compose_templates WHERE id = ?').get(id) as unknown as ComposeTemplateRow;
    res.status(201).json(toItem(row));
  }),
);

/**
 * PUT /api/compose-templates/:id
 * 更新指定 Compose 模板（管理员）
 * @param id        模板 id
 * @body name        模板名称（可选，唯一）
 * @body description 描述（可选）
 * @body content     compose 文件内容（可选）
 */
router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT * FROM compose_templates WHERE id = ?').get(id) as
      | ComposeTemplateRow
      | undefined;
    if (!row) {
      throw Object.assign(new Error('模板不存在'), { statusCode: 404 });
    }
    const body = req.body || {};
    const name = body.name !== undefined ? String(body.name).trim() : row.name;
    validateName(name, id);
    const description =
      body.description !== undefined ? String(body.description).trim() : row.description || '';
    const content = body.content !== undefined ? String(body.content) : row.content || '';
    if (!content.trim()) {
      throw Object.assign(new Error('模板内容不能为空'), { statusCode: 400 });
    }
    const now = Math.floor(Date.now() / 1000);
    d.prepare('UPDATE compose_templates SET name = ?, description = ?, content = ?, updated_at = ? WHERE id = ?').run(
      name,
      description || null,
      content,
      now,
      id,
    );
    logOperation(res.locals.username, '更新 Compose 模板', 'template', name);
    const updated = d.prepare('SELECT * FROM compose_templates WHERE id = ?').get(id) as unknown as ComposeTemplateRow;
    res.json(toItem(updated));
  }),
);

/**
 * DELETE /api/compose-templates/:id
 * 删除指定 Compose 模板（管理员）
 * @param id 模板 id
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT name FROM compose_templates WHERE id = ?').get(id) as
      | { name: string }
      | undefined;
    if (!row) {
      throw Object.assign(new Error('模板不存在'), { statusCode: 404 });
    }
    d.prepare('DELETE FROM compose_templates WHERE id = ?').run(id);
    logOperation(res.locals.username, '删除 Compose 模板', 'template', row.name);
    res.json({ ok: true });
  }),
);

export default router;
