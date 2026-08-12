import crypto from 'crypto';
import { getDb } from '../storage';
import type { BackupManifest, BackupManifestInput, BackupStatus } from './types';

interface BackupRow {
  id: string;
  kind: BackupManifest['kind'];
  name: string;
  source: string;
  file_path: string;
  size: number;
  status: BackupStatus;
  created_at: number;
  updated_at: number;
}

/**
 * 将 SQLite 备份行转换为对外使用的备份清单对象
 * @param row SQLite 备份记录
 */
function toManifest(row: BackupRow): BackupManifest {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    source: row.source,
    filePath: row.file_path,
    size: row.size,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 列出全部备份清单记录
 */
export function listBackups(): BackupManifest[] {
  const rows = getDb()
    .prepare('SELECT id, kind, name, source, file_path, size, status, created_at, updated_at FROM backups ORDER BY created_at DESC')
    .all() as unknown as BackupRow[];
  return rows.map(toManifest);
}

/**
 * 读取单个备份清单记录
 * @param id 备份记录 ID
 */
export function getBackup(id: string): BackupManifest | null {
  const row = getDb()
    .prepare('SELECT id, kind, name, source, file_path, size, status, created_at, updated_at FROM backups WHERE id = ?')
    .get(id) as BackupRow | undefined;
  return row ? toManifest(row) : null;
}

/**
 * 写入或覆盖一条备份清单记录
 * @param input 备份清单输入
 */
export function writeBackup(input: BackupManifestInput): BackupManifest {
  const now = Date.now();
  const record: BackupManifest = {
    id: input.id || crypto.randomUUID(),
    kind: input.kind,
    name: input.name,
    source: input.source,
    filePath: input.filePath,
    size: input.size,
    status: input.status || 'ready',
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
  getDb()
    .prepare(
      `INSERT INTO backups (id, kind, name, source, file_path, size, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         name = excluded.name,
         source = excluded.source,
         file_path = excluded.file_path,
         size = excluded.size,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .run(
      record.id,
      record.kind,
      record.name,
      record.source,
      record.filePath,
      record.size,
      record.status,
      record.createdAt,
      record.updatedAt,
    );
  return record;
}

/**
 * 更新备份清单状态
 * @param id 备份记录 ID
 * @param status 新状态
 */
export function updateBackupStatus(id: string, status: BackupStatus): BackupManifest | null {
  const updatedAt = Date.now();
  getDb().prepare('UPDATE backups SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, id);
  return getBackup(id);
}
