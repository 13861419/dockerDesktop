/**
 * 本地备份 REST API 路由（挂载路径 /api/backups）
 *
 * 提供备份的创建、列表、下载、恢复与删除五类接口。
 * 数据操作全部委托给 backup/manager.ts（Task 2 已实现的核心服务），
 * 本文件仅负责：参数解析与校验、401 外层的业务校验、操作日志、响应序列化。
 *
 * 安全：下载负载文件时，通过路径归一化 + 前缀校验防止路径穿越，
 * 确保仅能访问 BACKUP_ROOT 之内的文件。
 */
import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { DATA_DIR } from '../storage';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';
import {
  createBackup,
  deleteBackupFile,
  listBackupFiles,
  readBackupManifest,
  restoreBackup,
} from '../backup/manager';
import type { BackupKind } from '../backup/types';

const router = Router();

/** 合法备份类型集合 */
const KINDS: BackupKind[] = ['database', 'volume', 'compose', 'site'];

/** 备份根目录（与 manager 的 BACKUP_ROOT 保持一致） */
const BACKUP_ROOT = path.join(DATA_DIR, 'backups');

/**
 * 统一兜底错误处理
 * 将 async 处理函数中的异常转为 { statusCode, message } 结构的 JSON 响应
 * @param fn 需要被包装的异步路由处理函数
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      res.status(status).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/**
 * 校验备份类型是否合法
 * @param kind 待校验的备份类型字符串
 * @returns 非法时抛 400 错误
 */
function assertKind(kind: unknown): asserts kind is BackupKind {
  if (typeof kind !== 'string' || !KINDS.includes(kind as BackupKind)) {
    throw Object.assign(new Error('无效的备份类型'), { statusCode: 400 });
  }
}

/**
 * 解析并校验恢复下载目标文件
 * 依据清单 filePath 定位负载，并强制校验解析结果位于备份根目录内，
 * 杜绝路径穿越；文件不存在时抛 404。
 * @param id 备份记录 ID
 * @returns 解析后的安全文件路径
 */
function resolveDownloadFile(id: string): string {
  const manifest = readBackupManifest(id);
  if (!manifest) {
    throw Object.assign(new Error('备份不存在'), { statusCode: 404 });
  }
  const root = path.resolve(BACKUP_ROOT);
  const resolved = path.resolve(manifest.filePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw Object.assign(new Error('非法的备份文件路径'), { statusCode: 500 });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw Object.assign(new Error('备份负载文件缺失'), { statusCode: 404 });
  }
  return resolved;
}

/**
 * GET /api/backups
 * 列出全部备份清单（含负载文件存在性与大小）
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ backups: listBackupFiles() });
  }),
);

/**
 * POST /api/backups
 * 创建一条本地备份
 * 请求体：{ kind, name, source }
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    assertKind(body.kind);
    const name = String(body.name || '').trim();
    if (!name) {
      throw Object.assign(new Error('备份名称不能为空'), { statusCode: 400 });
    }
    const backup = await createBackup({
      kind: body.kind,
      name,
      source: String(body.source || ''),
    });
    logOperation(res.locals.username, '创建备份', '备份', name, `${backup.kind} / ${backup.id}`);
    res.status(201).json({ backup });
  }),
);

/**
 * GET /api/backups/:id/download
 * 下载备份负载文件（Content-Disposition attachment）
 * @param id 备份记录 ID
 */
router.get(
  '/:id/download',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const filePath = resolveDownloadFile(id);
    const manifest = readBackupManifest(id)!;
    res.setHeader('Content-Type', 'application/octet-stream');
    const filename = `${manifest.kind}-${manifest.id}-backup${path.extname(filePath)}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  }),
);

/**
 * POST /api/backups/:id/restore
 * 恢复一条备份，返回恢复结果结构
 * @param id 备份记录 ID
 */
router.post(
  '/:id/restore',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const result = await restoreBackup(id);
    logOperation(
      res.locals.username,
      '恢复备份',
      '备份',
      id,
      result.ok ? '恢复成功' : result.message,
      result.ok,
    );
    res.json({ result });
  }),
);

/**
 * DELETE /api/backups/:id
 * 删除一条备份（负载目录与清单记录）
 * @param id 备份记录 ID
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const manifest = readBackupManifest(id);
    if (!manifest) {
      throw Object.assign(new Error('备份不存在'), { statusCode: 404 });
    }
    deleteBackupFile(id);
    logOperation(res.locals.username, '删除备份', '备份', manifest.name);
    res.json({ ok: true });
  }),
);

export default router;
