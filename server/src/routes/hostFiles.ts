/**
 * 宿主机文件管理 API 路由（挂载路径 /api/hostfiles）
 *
 * 提供宿主机（Windows）文件系统的浏览 / 上传 / 下载 / 新建 / 重命名 / 移动 / 删除能力。
 * 全部基于 Node 内置 fs/promises 与 stream，无任何第三方新增依赖。
 *
 * 安全约束：
 *  - 所有路径统一使用 path.resolve 规整为绝对路径。
 *  - 路径与父路径都必须落在 Windows 逻辑盘符根之下，且拒绝路径穿越（'..'）。
 *  - 删除目录需显式传真 force=true（递归删除），默认仅允许空目录或单文件。
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/** 读取接口允许的文件大小上限（字节，2MB） */
const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * 统一兜底错误处理
 * @param fn 异步处理函数
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 规整并校验用户路径为绝对路径，防穿越
 * @param raw 用户输入路径（可空表示根）
 * @returns 规整后的绝对路径
 */
function resolvePath(raw: string | undefined | null): string {
  const p = path.resolve(String(raw || '').trim() || '/');
  return p;
}

/**
 * 校验路径落在合法盘符根下
 * @param p 绝对路径
 */
function assertSafePath(p: string): void {
  const root = path.parse(p).root;
  if (!root || root === '\\' || root === '/') {
    throw Object.assign(new Error('非法路径'), { statusCode: 400 });
  }
}

/**
 * GET /api/hostfiles/list?path=
 * 列出指定路径的目录/文件；path 省略或无有效盘符时返回本机盘符列表
 */
router.get(
  '/list',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const rawPath = req.query.path ? String(req.query.path) : '';
    let target: string;

    if (!rawPath) {
      // 未指定路径：返回 Windows 逻辑盘符
      const drives: string[] = [];
      for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c) + ':\\';
        if (fs.existsSync(letter)) drives.push(letter);
      }
      return res.json({ items: drives.map((d) => ({ name: d, type: 'drive', path: d })), path: '' });
    }

    target = resolvePath(rawPath);
    assertSafePath(target);

    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat) {
      return res.status(404).json({ error: `路径不存在: ${target}` });
    }
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `不是目录: ${target}` });
    }

    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const items = [];
    for (const ent of entries) {
      if (ent.name.startsWith('$') && ent.isDirectory()) continue; // 跳过系统目录
      try {
        const full = path.join(target, ent.name);
        const st = await fs.promises.stat(full);
        items.push({
          name: ent.name,
          type: ent.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
          size: st.isFile() ? st.size : null,
          mtime: st.mtimeMs,
          path: full,
        });
      } catch {
        items.push({ name: ent.name, type: 'other', size: null, mtime: null, path: path.join(target, ent.name) });
      }
    }
    // 目录在前，然后按名称排序
    items.sort((a: any, b: any) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name));
    res.json({ items, path: target });
  }),
);

/**
 * POST /api/hostfiles/mkdir
 * 新建目录
 * @body path 目标父目录
 * @body name 目录名
 */
router.post(
  '/mkdir',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const parent = resolvePath(req.body?.path);
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '目录名不能为空' });
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
      return res.status(400).json({ error: '目录名含非法字符' });
    }
    const target = path.join(parent, name);
    assertSafePath(target);
    await fs.promises.mkdir(target, { recursive: false });
    logOperation(res.locals.username, '创建目录', '文件', name, `路径: ${parent}`);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/hostfiles/read
 * 读取文本文件内容
 * @body path 文件路径
 */
router.post(
  '/read',
  asyncHandler(async (req: Request, res: Response) => {
    const target = resolvePath(req.body?.path);
    assertSafePath(target);
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ error: '文件不存在' });
    if (stat.size > MAX_READ_BYTES) {
      return res.status(400).json({ error: '文件过大，请下载后查看（上限 2MB）' });
    }
    const content = await fs.promises.readFile(target, 'utf8');
    res.json({ content });
  }),
);

/**
 * POST /api/hostfiles/write
 * 写入文本文件（覆盖式）
 * @body path 文件路径
 * @body content 内容
 */
router.post(
  '/write',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const target = resolvePath(req.body?.path);
    assertSafePath(target);
    const content = String(req.body?.content ?? '');
    await fs.promises.writeFile(target, content, 'utf8');
    logOperation(res.locals.username, '保存文件', '文件', target);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/hostfiles/rename
 * 重命名 / 移动
 * @body from 源路径
 * @body to   目标路径
 */
router.post(
  '/rename',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const from = resolvePath(req.body?.from);
    const to = resolvePath(req.body?.to);
    assertSafePath(from);
    assertSafePath(to);
    await fs.promises.rename(from, to);
    logOperation(res.locals.username, '重命名', '文件', path.basename(from), `→ ${to}`);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/hostfiles/delete
 * 删除文件或目录
 * @body path 目标路径
 * @body force 目录递归删除需 true
 */
router.post(
  '/delete',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const target = resolvePath(req.body?.path);
    assertSafePath(target);
    const force = !!req.body?.force;
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat) return res.status(404).json({ error: '目标不存在' });
    if (stat.isDirectory()) {
      if (!force) {
        const entries = await fs.promises.readdir(target).catch(() => []);
        if (entries.length > 0) {
          return res.status(400).json({ error: '目录非空，需确认递归删除' });
        }
      }
      await fs.promises.rm(target, { recursive: !!force, force: true });
      logOperation(res.locals.username, '删除目录', '文件', target, force ? '(递归)' : undefined);
    } else {
      await fs.promises.unlink(target);
      logOperation(res.locals.username, '删除文件', '文件', target);
    }
    res.json({ ok: true });
  }),
);

/**
 * POST /api/hostfiles/upload
 * 上传文件到指定目录（express.raw，query 传 path=目录 & name=文件名）
 */
router.post(
  '/upload',
  requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: '1gb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = resolvePath(String(req.query.path || ''));
    const name = String(req.query.name || '').trim();
    assertSafePath(dir);
    if (!name) return res.status(400).json({ error: '缺少文件名' });
    const raw = req.body as Buffer | undefined;
    if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) {
      return res.status(400).json({ error: '空内容' });
    }
    const target = path.join(dir, name);
    assertSafePath(target);
    await fs.promises.writeFile(target, raw);
    logOperation(res.locals.username, '上传文件', '文件', name, `目录: ${dir}`);
    res.json({ ok: true, size: raw.length });
  }),
);

/**
 * GET /api/hostfiles/download?path=
 * 下载文件（流式返回）
 */
router.get(
  '/download',
  asyncHandler(async (req: Request, res: Response) => {
    const target = resolvePath(String(req.query.path || ''));
    assertSafePath(target);
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ error: '文件不存在' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
    );
    const stream = fs.createReadStream(target);
    await pipeline(stream, res);
  }),
);

export default router;
