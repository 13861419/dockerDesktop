/**
 * 面板自身 SQLite 数据库备份服务
 *
 * 对面板数据库（<data>/docker-manager.db）执行物理级一致性快照：
 *  - 备份：SQLite `VACUUM INTO` 生成与在线写入一致的快照文件（含 WAL 中未合并数据），
 *    落盘到 <data>/db-backups/，无需停服
 *  - 保留策略：设置 db.backup.retentionCount（默认保留最近 7 份，0 = 不自动清理）
 *  - 恢复：关闭当前连接 → 用备份文件覆盖库文件 → 重新打开并完整性校验
 *    （所有模块均通过 getDb() 惰性获取连接，恢复后自动使用新库）
 *
 * 可通过计划任务类型 sqliteBackup 定时自动备份，也可在设置中心手动触发。
 */
import fs from 'fs';
import path from 'path';
import { getDataDir, getDb, closeDb } from './storage';
import { getSetting } from './settings';
import { registerTaskHandler, type CronTaskRow, type TaskRunResult } from './scheduler';

/** 备份输出目录 */
const BACKUP_DIR = path.join(getDataDir(), 'db-backups');
/** 面板数据库文件（与 storage.ts 的 DB_FILE 同一位置） */
const DB_FILE = path.join(getDataDir(), 'docker-manager.db');

/** 备份文件信息 */
export interface SqliteBackupInfo {
  file: string;
  size: number;
  createdAt: number;
}

/**
 * 生成备份文件名（时间戳 + 原因），如 docker-manager-2026-08-28T10-30-00-000Z-scheduled.db
 */
function backupFileName(reason: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = String(reason || 'manual').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'manual';
  return `docker-manager-${stamp}-${safeReason}.db`;
}

/**
 * 校验文件名安全（禁止路径穿越），返回备份目录内的绝对路径
 * @throws 文件名非法时抛 400
 */
function resolveBackupPath(file: string): string {
  const name = String(file || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw Object.assign(new Error('非法备份文件名'), { statusCode: 400 });
  }
  const full = path.join(BACKUP_DIR, name);
  if (path.dirname(full) !== BACKUP_DIR) {
    throw Object.assign(new Error('非法备份文件路径'), { statusCode: 400 });
  }
  return full;
}

/**
 * 按保留份数清理最旧的备份（db.backup.retentionCount，0 = 不清理）
 * @returns 删除的文件数
 */
function pruneOldBackups(): number {
  const keep = Math.floor(Number(getSetting<number>('db.backup.retentionCount')) || 0);
  if (keep <= 0) return 0;
  const files = listSqliteBackups();
  let removed = 0;
  for (const f of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f.file));
      removed += 1;
    } catch {
      // 单个文件删除失败不影响整体
    }
  }
  return removed;
}

/**
 * 创建一次面板数据库备份（VACUUM INTO 一致性快照，不停服）
 * @param reason 备份原因（manual / scheduled / restore-before），写入文件名便于识别
 */
export function createSqliteBackup(reason = 'manual'): SqliteBackupInfo {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = backupFileName(reason);
  const target = path.join(BACKUP_DIR, file);
  // VACUUM INTO 要求目标文件不存在；路径中的单引号按 SQL 字面量转义
  const sqlPath = `'${target.replace(/'/g, "''")}'`;
  getDb().exec(`VACUUM INTO ${sqlPath}`);
  if (!fs.existsSync(target)) {
    throw new Error('备份失败：未生成快照文件');
  }
  pruneOldBackups();
  return { file, size: fs.statSync(target).size, createdAt: Date.now() };
}

/**
 * 列出全部备份文件（按创建时间倒序）
 */
export function listSqliteBackups(): SqliteBackupInfo[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const out: SqliteBackupInfo[] = [];
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const full = path.join(BACKUP_DIR, f);
    if (!f.endsWith('.db') || !fs.statSync(full).isFile()) continue;
    out.push({ file: f, size: fs.statSync(full).size, createdAt: fs.statSync(full).mtimeMs });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * 删除一个备份文件
 * @throws 不存在时抛 404
 */
export function deleteSqliteBackup(file: string): void {
  const full = resolveBackupPath(file);
  if (!fs.existsSync(full)) {
    throw Object.assign(new Error('备份文件不存在'), { statusCode: 404 });
  }
  fs.unlinkSync(full);
}

/**
 * 读取备份文件绝对路径（供下载），存在性校验由路由完成
 * @throws 不存在时抛 404
 */
export function resolveSqliteBackupFile(file: string): string {
  const full = resolveBackupPath(file);
  if (!fs.existsSync(full)) {
    throw Object.assign(new Error('备份文件不存在'), { statusCode: 404 });
  }
  return full;
}

/**
 * 用指定备份恢复面板数据库：
 * 关闭当前连接 → 覆盖库文件 → 清理 WAL/SHM → 重新打开并做完整性校验。
 * 所有模块通过 getDb() 惰性取连接，恢复后即生效；建议随后重启面板以彻底复位。
 * @throws 备份文件非 SQLite 格式时抛 400
 */
export function restoreSqliteBackup(file: string): { message: string } {
  const src = resolveBackupPath(file);
  // 校验 SQLite 文件头（16 字节魔数），避免用非数据库文件覆盖
  const fd = fs.openSync(src, 'r');
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
    throw Object.assign(new Error('该文件不是有效的 SQLite 数据库备份'), { statusCode: 400 });
  }

  closeDb();
  try {
    fs.copyFileSync(src, DB_FILE);
    // 旧连接遗留的 WAL/SHM 与新库文件不匹配，一并清理
    for (const suffix of ['-wal', '-shm']) {
      const p = `${DB_FILE}${suffix}`;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } finally {
    // 无论覆盖过程是否成功都立即重开连接，避免面板处于无库状态
    getDb();
  }
  // 完整性校验
  const check = getDb().prepare('PRAGMA quick_check').get() as { quick_check: string };
  if (check?.quick_check !== 'ok') {
    throw new Error(`恢复后完整性校验未通过：${check?.quick_check || '未知结果'}`);
  }
  return { message: '数据库已恢复，建议尽快重启面板服务以彻底复位全部连接' };
}

/** 调度器 handler：定时备份（config: { retentionCount? }） */
async function runSqliteBackupHandler(_task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const info = createSqliteBackup('scheduled');
  return { ok: true, detail: `已创建备份 ${info.file}（${(info.size / 1024).toFixed(0)} KB）` };
}

// 注册到调度器（模块加载即注册）
registerTaskHandler('sqliteBackup', runSqliteBackupHandler);
