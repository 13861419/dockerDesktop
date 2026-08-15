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
 * 支持四类备份的创建与恢复：
 *   - database：对面板 SQLite 做 VACUUM INTO 快照，恢复时导入回滚
 *   - volume：用一次性 alpine 容器对命名卷 tar 打包 / 解包
 *   - compose：对 Compose 项目目录 tar 打包 / 恢复时解包
 *   - site：对站点 nginx 配置与证书 tar 打包 / 恢复时还原
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { getDb, DATA_DIR, importDatabaseBuffer } from '../storage';
import { getDockerClient } from '../docker/client';
import type Dockerode from 'dockerode';
import { listBackups, getBackup, writeBackup, updateBackupStatus } from './manifest';
import type { BackupKind, BackupManifest, BackupStatus } from './types';

const execAsync = promisify(execCb);

// Compose 项目根目录（与 server/src/routes/compose.ts 保持一致，避免循环依赖）
const COMPOSE_ROOT = process.env.COMPOSE_ROOT
  ? process.env.COMPOSE_ROOT
  : path.join(os.tmpdir(), 'docker-compose-projects');

// nginx 配置根目录（等同 server/src/routes/sites.ts 中 data/nginx）
const NGINX_DIR = path.join(DATA_DIR, 'nginx');

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
 * 校验 Compose 项目名是否安全（仅允许字母数字开头，后续可为字母数字、下划线、短划线，
 * 拒绝 . 与 .. 等路径穿越片段）
 * @param n 项目名
 * @returns 是否安全
 */
function isSafeProjectName(n: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(n);
}

/**
 * 将站点记录 ID（UUID）安全化为文件名片段（与 sites.ts 的 safeName 规则一致）
 * @param id 站点记录 ID
 * @returns 安全化后的文件名片段
 */
function safeNameOfId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
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
 * 将目录打包为 tar.gz
 * @param srcDir 源目录（必须存在）
 * @param tarPath 目标 tar.gz 路径
 */
async function packDirToTar(srcDir: string, tarPath: string): Promise<void> {
  if (!fs.existsSync(srcDir)) throw new Error(`源目录不存在: ${srcDir}`);
  fs.mkdirSync(path.dirname(tarPath), { recursive: true });
  const escapedSrc = srcDir.replace(/"/g, '\\"');
  const escapedTar = tarPath.replace(/"/g, '\\"');
  // Windows 下使用系统 tar（Win10+ 自带 bsdtar）；cmd 内参数用引号包裹
  const cmd = `tar -czf "${escapedTar}" -C "${escapedSrc}" .`;
  try {
    await execAsync(cmd, { shell: 'cmd.exe', maxBuffer: 1024 * 1024 * 50 });
  } catch (err: any) {
    throw new Error(`目录打包失败: ${err?.stderr || err?.message || 'tar 执行错误'}`);
  }
}

/**
 * 将 tar.gz 解包到目标目录（不存在则创建）
 * @param tarPath 源 tar.gz 路径
 * @param destDir 目标目录
 */
async function unpackTarToDir(tarPath: string, destDir: string): Promise<void> {
  if (!fs.existsSync(tarPath)) throw new Error(`备份文件不存在: ${tarPath}`);
  fs.mkdirSync(destDir, { recursive: true });
  const escapedTar = tarPath.replace(/"/g, '\\"');
  const escapedDest = destDir.replace(/"/g, '\\"');
  const cmd = `tar -xzf "${escapedTar}" -C "${escapedDest}"`;
  try {
    await execAsync(cmd, { shell: 'cmd.exe', maxBuffer: 1024 * 1024 * 50 });
  } catch (err: any) {
    throw new Error(`解包失败: ${err?.stderr || err?.message || 'tar 执行错误'}`);
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
 * 查询站点表中的 ID、域名与证书路径
 * @returns 站点 ID、域名与证书路径列表
 */
function listSiteRows() {
  return getDb()
    .prepare('SELECT id, domain, cert_path FROM sites')
    .all() as { id: string; domain: string; cert_path: string | null }[];
}

/**
 * 保证 alpine 镜像存在（不存在则 pull）
 * @param docker Dockerode 实例
 */
async function ensureAlpineImage(docker: Dockerode): Promise<void> {
  const images = await docker.listImages();
  const hasAlpine = images.some((i) =>
    (i.RepoTags || []).some((t) => t.split(':')[0].toLowerCase() === 'alpine'),
  );
  if (!hasAlpine) {
    await pullImage(docker, 'alpine:latest');
  }
}

/**
 * 拉取指定镜像
 * @param docker Dockerode 实例
 * @param ref 镜像引用，如 alpine:latest
 */
async function pullImage(docker: Dockerode, ref: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(ref, (err: any, stream: any) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (perr: any) => (perr ? reject(perr) : resolve()), () => {});
    });
  });
}

/**
 * 通过一次性 alpine 容器对卷执行 tar 命令（打包或解包）
 * @param docker Dockerode 实例
 * @param volume 卷名
 * @param mountDir 挂载进容器 /backup 的宿主机目录（即 dir，dir/backup.tar.gz 即容器内 /backup/backup.tar.gz）
 * @param direction 'pack' 打包 | 'unpack' 解包
 */
async function runVolumeTar(docker: Dockerode, volume: string, mountDir: string, direction: 'pack' | 'unpack'): Promise<void> {
  await ensureAlpineImage(docker);
  const tarName = 'backup.tar.gz';
  const cmd =
    direction === 'pack'
      ? `sh -c "tar -czf /backup/${tarName} -C /data ."`
      : `sh -c "tar -xzf /backup/${tarName} -C /data"`;
  const container = await docker.createContainer({
    Image: 'alpine:latest',
    Cmd: ['/bin/sh', '-c', cmd],
    HostConfig: {
      Binds: [`${volume}:/data`, `${mountDir}:/backup`],
      // 不使用 AutoRemove：容器退出后会被立即删除，导致 container.wait() 返回 404
      // 改为 wait() 后手动 remove，确保能可靠取得退出码
    },
  });
  await container.start();
  const res = await container.wait();
  await container.remove({ force: true });
  if (res.StatusCode !== 0) {
    throw new Error(`卷备份容器退出码非 0: ${res.StatusCode}`);
  }
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
  } else if (kind === 'volume') {
    const docker = await getDockerClient();
    await runVolumeTar(docker, input.source, dir, 'pack');
  } else if (kind === 'compose') {
    if (!isSafeProjectName(input.source)) throw new Error('非法的 Compose 项目名');
    const src = path.join(COMPOSE_ROOT, input.source);
    await packDirToTar(src, filePath);
  } else if (kind === 'site') {
    // 站点数据分布在 data/nginx 根目录的 <safeName>.conf 与证书路径，先收集到临时 stage 目录再打包
    if (!/^[a-zA-Z0-9.-]+$/.test(input.source)) throw new Error('非法的站点域名');
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(path.join(stage, 'conf.d'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'certs'), { recursive: true });
    const rows = listSiteRows();
    const site = rows.find((r) => r.domain === input.source);
    let siteIdSafe = '';
    if (site) {
      siteIdSafe = safeNameOfId(site.id);
      const confSrc = path.join(NGINX_DIR, `${siteIdSafe}.conf`);
      if (fs.existsSync(confSrc)) fs.copyFileSync(confSrc, path.join(stage, 'conf.d', `${siteIdSafe}.conf`));
      // 从 sites 表读取证书路径并复制
      if (site.cert_path) {
        const keyPath = site.cert_path.replace(/\.(crt|pem)$/i, '.key');
        if (fs.existsSync(site.cert_path)) fs.copyFileSync(site.cert_path, path.join(stage, 'certs', path.basename(site.cert_path)));
        if (fs.existsSync(keyPath)) fs.copyFileSync(keyPath, path.join(stage, 'certs', path.basename(keyPath)));
      }
    }
    try {
      await packDirToTar(stage, filePath);
    } finally {
      // 无论打包成功与否都清理临时 stage 目录
      fs.rmSync(stage, { recursive: true, force: true });
    }
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
 * database 做 SQLite 导入回滚；volume 用一次性 alpine 容器解包回卷；
 * compose 解包回项目目录；site 还原 nginx 配置与证书。
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

    if (kind === 'volume') {
      if (!fs.existsSync(filePath)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '备份负载文件缺失，无法恢复' };
      }
      const docker = await getDockerClient();
      // 卷不存在则先创建
      const vols = await docker.listVolumes();
      const exists = (vols.Volumes || []).some((v) => v && v.Name === manifest.source);
      if (!exists) {
        await docker.createVolume({ Name: manifest.source });
      }
      await runVolumeTar(docker, manifest.source, dir, 'unpack');
      updateBackupStatus(id, 'ready');
      return { ok: true, supported: true, kind, id, message: '数据卷已恢复' };
    }

    if (kind === 'compose') {
      if (!isSafeProjectName(manifest.source)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '非法的 Compose 项目名' };
      }
      if (!fs.existsSync(filePath)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '备份负载文件缺失，无法恢复' };
      }
      const dest = path.join(COMPOSE_ROOT, manifest.source);
      await unpackTarToDir(filePath, dest);
      updateBackupStatus(id, 'ready');
      return { ok: true, supported: true, kind, id, message: 'Compose 配置已恢复（未自动启停容器）' };
    }

    if (kind === 'site') {
      if (!/^[a-zA-Z0-9.-]+$/.test(manifest.source)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '非法的站点域名' };
      }
      if (!fs.existsSync(filePath)) {
        updateBackupStatus(id, 'failed');
        return { ok: false, supported: true, kind, id, message: '备份负载文件缺失，无法恢复' };
      }
      const stage = path.join(dir, 'stage');
      // 站点是否仍在库（影响 conf 是否可还原）
      const site = listSiteRows().find((r) => r.domain === manifest.source);
      try {
        await unpackTarToDir(filePath, stage);
        // 站点仍在库时，按其 record id 还原 conf 到 data/nginx 根目录 <safeName>.conf
        if (site) {
          const siteIdSafe = safeNameOfId(site.id);
          const confStage = path.join(stage, 'conf.d', `${siteIdSafe}.conf`);
          const confDest = path.join(NGINX_DIR, `${siteIdSafe}.conf`);
          fs.mkdirSync(NGINX_DIR, { recursive: true });
          if (fs.existsSync(confStage)) fs.copyFileSync(confStage, confDest);
        }
        // 还原证书目录（无论站点是否仍在库都尝试）
        const certsStage = path.join(stage, 'certs');
        if (fs.existsSync(certsStage)) {
          const certsDest = path.join(NGINX_DIR, 'certs');
          fs.mkdirSync(certsDest, { recursive: true });
          for (const f of fs.readdirSync(certsStage)) {
            fs.copyFileSync(path.join(certsStage, f), path.join(certsDest, f));
          }
        }
      } finally {
        // 无论解包/还原成功与否都清理临时 stage 目录
        fs.rmSync(stage, { recursive: true, force: true });
      }
      updateBackupStatus(id, 'ready');
      // message 提示 conf 是否还原成功
      const confNote = site ? '（含 nginx 配置）' : '（站点已不存在，未还原 nginx 配置，已还原证书）';
      return { ok: true, supported: true, kind, id, message: `站点配置已恢复${confNote}（未自动重启反代容器）` };
    }

    // 兜底终止：正常情况下不可达（kind 已由 isSafeKind 收窄）
    updateBackupStatus(id, 'ready');
    return { ok: false, supported: true, kind, id, message: '未知的备份类型' };
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
