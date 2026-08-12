/**
 * 本地备份管理器（Task 2 核心服务）
 *
 * 负责备份文件的创建、删除、恢复与清单列举。备份的对象（数据库 / 数据卷 /
 * Compose / 站点）统一以"清单记录 + 负载文件"双份形式组织：
 *   - 清单记录：由 backup/manifest.ts 写入 SQLite（backups 表）
 *   - 负载文件：落在 <data>/backups/<kind>/<id>/ 目录下
 *
 * 安全：所有由用户可控的 id/name 派生路径都必须经过 resolveSafePath 归一化，
 * 并校验结果位于 backups 根目录之内，杜绝路径穿越。
 *
 * 本阶段（第一阶段核心）：
 *   - database：可真实备份/恢复（对面板 SQLite 做 VACUUM INTO 快照 / 导入回滚）
 *   - volume / compose / site：仅创建清单记录与占位负载，恢复返回"暂不支持"结构，
 *     绝不触碰用户数据，保证正确性优先。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, DATA_DIR, importDatabaseBuffer } from '../storage';
import { listBackups, getBackup, writeBackup, updateBackupStatus } from './manifest';
import type { BackupKind, BackupManifest, BackupStatus } from './types';

/** 备份根目录（位于数据目录下） */
const BACKUP_ROOT = path.join(DATA_DIR, 'backups');

/** 安全 ID 允许的字符（UUID / 短划线），拒绝分隔符与路径穿越 */
const SAFE_ID_RE = /^[a-zA-Z0-9-]+$/;

/**
 * 校验 ID 是否安全（仅允许字母数字与短划线）
 * @param id 备份记录 ID
 * @returns 是否安全
 */
function isSafeId(id: string): boolean {
  return !!id && id.length <= 64 && SAFE_ID_RE.test(id);
}

/**
 * 校验备份类型是否合法
 * @param kind 备份类型
 */
function isSafeKind(kind: string): kind is BackupKind {
  return kind === 'database' || kind === 'volume' || kind === 'compose' || kind === 'site';
}

/**
 * 路径安全归一化：将若干路径片段拼接到 base 下，并强制校验结果位于 base 之内
 * @param base 基准目录
 * @param segments 待拼接片段
 * @returns 归一化后的绝对路径
 * @throws 结果越界时抛错
 */
function resolveSafePath(base: string, ...segments: string[]): string {
  const root = path.resolve(base);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('非法路径：不允许越出备份根目录');
  }
  return resolved;
}

/**
 * 计算某一备份记录所属目录（创建该目录的父目录）
 * @param kind 备份类型
 * @param id 备份 ID
 * @returns 目录绝对路径
 */
function backupDir(kind: BackupKind, id: string): string {
  if (!isSafeKind(kind)) throw new Error('非法备份类型');
  if (!isSafeId(id)) throw new Error('非法备份 ID');
  return resolveSafePath(BACKUP_ROOT, kind, id);
}

/**
 * 依据备份类型返回负载文件名（便于区分内容格式）
 * @param kind 备份类型
 */
function payloadName(kind: BackupKind): string {
  switch (kind) {
    case 'database':
      return 'backup.db';
    case 'volume':
    case 'compose':
    case 'site':
    default:
      return 'backup.tar.gz';
  }
}

/**
 * 为 database 类型生成一份一致性数据库快照到目标路径（VACUUM INTO，含 WAL 合并）
 * 注意：backups 表与面板数据同库，快照为全量拷贝，属预期行为。
 * @param target 目标文件路径
 */
function snapshotDatabase(target: string): void {
  // 先确保目录存在
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const escaped = target.replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${escaped}'`);
}

/**
 * 生成占位（骨架）负载文件，用于尚未实现真实数据搬运的备份类型
 * @param target 目标文件路径
 * @param kind 备份类型
 * @param source 源描述
 */
function writePlaceholderPayload(target: string, kind: BackupKind, source: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = JSON.stringify(
    {
      kind,
      skeleton: true,
      message: `${kind} 类型的真实备份尚未实现，此文件仅为占位负载。`,
      source: source || '',
      createdAt: Date.now(),
    },
    null,
    2,
  );
  fs.writeFileSync(target, body, 'utf8');
}

/* ---------------------------------------------------------------------------
 * 对外 API
 * ------------------------------------------------------------------------- */

/**
 * 创建一条本地备份
 *
 * 生成 ID 与输出目录，写入负载文件（database 快照 / 其它类型占位），
 * 并在 backups 根目录写一份 manifest.json 便于离线携带，最后通过
 * writeBackup() 持久化清单记录到 SQLite 并返回。
 *
 * @param input 备份创建入参
 * @param input.kind 备份类型
 * @param input.name 备份名称（仅元数据，不参与路径拼接）
 * @param input.source 备份来源描述（如卷名 / 站点域名）
 * @returns 已持久化的备份清单记录
 */
export async function createBackup(input: { kind: BackupKind; name: string; source: string }): Promise<BackupManifest> {
  const kind = input.kind;
  if (!isSafeKind(kind)) throw new Error('非法备份类型');
  const name = String(input.name || '').trim().replace(/[\r\n\u0000-\u001f]/g, '') || '未命名备份';
  const id = crypto.randomUUID();
  const dir = backupDir(kind, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, payloadName(kind));
  if (kind === 'database') {
    snapshotDatabase(filePath);
  } else {
    writePlaceholderPayload(filePath, kind, input.source);
  }

  const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  // 写入伴生 manifest.json（供离线/迁移参考；SQLite 记录才是权威）
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id, kind, name, source: input.source, filePath, size, createdAt: Date.now() }, null, 2),
    'utf8',
  );

  return writeBackup({ id, kind, name, source: input.source || '', filePath, size });
}

/**
 * 删除一条备份：移除负载目录及文件，并删除清单记录
 * @param id 备份记录 ID
 * @returns 删除成功标记
 * @throws 备份不存在或路径非法时抛错
 */
export function deleteBackupFile(id: string): { ok: true } {
  if (!isSafeId(id)) throw new Error('非法备份 ID');
  const manifest = getBackup(id);
  if (!manifest) throw new Error('备份不存在');
  const dir = backupDir(manifest.kind, manifest.id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const db = getDb();
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * 恢复备份恢复结果结构（供 Task 3 路由消费）
 */
export interface RestoreResult {
  ok: boolean;
  supported: boolean;
  kind: BackupKind;
  id: string;
  message: string;
}

/**
 * 恢复一条备份
 *
 * 流程：加载清单 → 校验类型/状态 → 标记 restoring → 执行恢复 → 标记 ready/failed。
 * 对尚未实现真实恢复的类型（volume/compose/site）返回"暂不支持"结构化结果，
 * 并恢复状态为 ready，绝不触碰用户数据。
 *
 * @param id 备份记录 ID
 * @returns 恢复结果结构
 */
export async function restoreBackup(id: string): Promise<RestoreResult> {
  if (!isSafeId(id)) throw new Error('非法备份 ID');
  const manifest = getBackup(id);
  if (!manifest) throw new Error('备份不存在');
  const kind = manifest.kind;

  // 不可在当前恢复中的记录上重复触发
  if (manifest.status === 'restoring') {
    return { ok: false, supported: true, kind, id, message: '该备份正在恢复中，请稍后再试' };
  }

  // 标记为恢复中
  updateBackupStatus(id, 'restoring');

  const dir = backupDir(kind, id);
  const filePath = path.join(dir, payloadName(kind));

  try {
    if (kind === 'database') {
      if (!fs.existsSync(filePath)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '备份负载文件缺失，无法恢复' };
      }
      const buffer = fs.readFileSync(filePath);
      if (buffer.length === 0) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '备份负载文件为空，无法恢复' };
      }
      // 导入会校验 SQLite 文件头并原子替换当前数据库
      importDatabaseBuffer(buffer);
      // 恢复成功后，backups 表可能已被新库覆盖；若记录仍在则更新为 ready
      if (getBackup(id)) {
        updateBackupStatus(id, 'ready');
      }
      return { ok: true, supported: true, kind, id, message: '数据库已恢复' };
    }

    // volume / compose / site：本阶段不支持真实恢复，保持数据不动
    updateBackupStatus(id, 'ready');
    return {
      ok: false,
      supported: false,
      kind,
      id,
      message: `${kind} 类型的恢复暂未支持，未对现有数据做任何改动`,
    };
  } catch (err: any) {
    // 恢复过程异常：标记失败
    try {
      if (getBackup(id)) updateBackupStatus(id, 'failed');
    } catch {
      // 忽略状态更新失败
    }
    return { ok: false, supported: true, kind, id, message: err?.message || '恢复失败' };
  }
}

/** 备份列表条目 = 清单记录 + 磁盘存在性/大小 */
export interface BackupListItem extends BackupManifest {
  exists: boolean;
  fileSize: number;
}

/**
 * 列出全部备份（清单层为权威），并附带负载文件的存在性与磁盘大小
 * @returns 备份列表
 */
export function listBackupFiles(): BackupListItem[] {
  return listBackups().map((m) => {
    let exists = false;
    let fileSize = 0;
    if (isSafeKind(m.kind) && isSafeId(m.id)) {
      const p = path.join(backupDir(m.kind, m.id), payloadName(m.kind));
      try {
        if (fs.existsSync(p)) {
          exists = true;
          fileSize = fs.statSync(p).size;
        }
      } catch {
        // 忽略统计失败
      }
    }
    return { ...m, exists, fileSize };
  });
}

/**
 * 读取单条备份清单（便捷别名）
 * @param id 备份记录 ID
 * @returns 备份清单记录或 null
 */
export function readBackupManifest(id: string): BackupManifest | null {
  return getBackup(id);
}
