/**
 * 数据库数据级备份服务
 *
 * 对已登记数据库实例（MySQL / MariaDB / PostgreSQL）执行「逻辑备份」：
 * 通过官方 CLI（mysqldump / pg_dump）将指定库导出为压缩 SQL 文件，落盘到
 * <data>/db_backups/<instanceId>/ 目录，供列表、下载、删除。
 *
 * 执行策略（与 databases.ts 的容器/宿主机双通道保持一致）：
 *  - 容器型（container_ref 存在）：用一次性容器以 --network=container:<ref> 复用数据库容器网络，
 *    并将备份目录挂载为 /backup，在容器内执行 dump 后 gzip 写入挂载文件（无字符串/超时限制，可靠支撑较大库）。
 *  - 宿主机型：若宿主机装有对应 CLI，则用 exec 重定向输出；否则明确提示。
 *
 * 安全：所有由实例 id / 文件名派生的路径都经 resolveSafePath 归一化并校验位于备份根目录内，
 * 杜绝路径穿越；口令仅在本命令执行时解密使用，绝不打日志。
 */
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import Dockerode from 'dockerode';
import { getDockerClient } from './docker/client';
import { DATA_DIR, decryptSecret } from './storage';
import { hostShellForExec, quoteForHost } from './platform/exec';

const execAsync = promisify(exec);

/** 数据库实例行（databases 表字段，仅取本模块所需） */
interface DbInstance {
  id: number;
  name: string;
  type: string;
  container_ref: string | null;
  host: string;
  port: number;
  user: string | null;
  cred_encrypted: string | null;
}

/** 合法备份类型映射到 dump 用官方镜像（内置对应 CLI） */
const DUMP_IMAGE: Record<string, string> = {
  mysql: 'mysql:8.0',
  mariadb: 'mariadb:11.4',
  postgres: 'postgres:16-alpine',
};

/** 数据库备份根目录 */
const DB_BACKUP_ROOT = path.join(DATA_DIR, 'db_backups');

/** 单实例目录名安全化（数字 id 已是安全） */
function instanceDirName(instanceId: number): string {
  return String(instanceId).replace(/[^0-9]/g, '');
}

/**
 * 路径安全归一化：拼接片段并强制校验落在备份根目录内，防止路径穿越
 * @param segments 待拼接片段
 */
function resolveSafePath(...segments: string[]): string {
  const root = path.resolve(DB_BACKUP_ROOT);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('非法路径：不允许越出备份根目录');
  }
  return resolved;
}

/**
 * 规范化文件名（仅保留字母数字、点、下划线、短划线，拒绝分隔符）
 * @param name 原始文件名
 */
function safeFileName(name: string): string {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 校验数据库类型是否支持数据级备份
 * @param type 类型
 */
function supportedType(type: string): boolean {
  return type === 'mysql' || type === 'mariadb' || type === 'postgres';
}

/**
 * 用容器的 shell 安全地引用单参（单引号包裹、内部单引号转义），用于容器内 sh 命令拼接
 * @param arg 原始参数
 */
function csh(arg: string): string {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/**
 * 构建容器内执行的 dump 命令（管道 gzip，输出到 /backup/<file>）
 * @param inst 实例
 * @param db 库名
 * @param file 目标文件名（容器内 /backup 下）
 * @param pwd 明文口令
 */
function buildDumpCmd(inst: DbInstance, db: string, file: string, pwd: string): string {
  const port = inst.port;
  const user = inst.user || 'root';
  if (inst.type === 'mysql' || inst.type === 'mariadb') {
    // mysqldump --single-transaction 保证一致性快照；--skip-lock-tables 避免锁表
    const auth = `-h127.0.0.1 -P${port} -u${csh(user)}${pwd ? ` -p${csh(pwd)}` : ''}`;
    return `mysqldump --single-transaction --skip-lock-tables --quick ${auth} ${csh(db)} | gzip > /backup/${safeFileName(file)}`;
  }
  // postgres
  const pwdPrefix = pwd ? `PGPASSWORD=${csh(pwd)} ` : '';
  return `${pwdPrefix}pg_dump -h127.0.0.1 -p${port} -U ${csh(user)} -d ${csh(db)} | gzip > /backup/${safeFileName(file)}`;
}

/**
 * 确保指定镜像存在（不存在则拉取）
 * @param docker dockerode 客户端
 * @param image 镜像引用
 */
async function ensureImage(docker: Dockerode, image: string): Promise<void> {
  const images = await docker.listImages();
  const has = images.some((i) => (i.RepoTags || []).includes(image));
  if (has) return;
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: any, stream: any) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (perr: any) => (perr ? reject(perr) : resolve()), () => {});
    });
  });
}

/**
 * 在数据所在容器内执行 dump：一次性容器复用其网络 + 挂载备份目录，可靠支撑较大库
 * @param inst 实例
 * @param db 库名
 * @param backupDir 宿主机备份目录
 * @param file 目标文件名
 * @param pwd 明文口令
 */
async function dumpInContainer(inst: DbInstance, db: string, backupDir: string, file: string, pwd: string): Promise<void> {
  const docker = await getDockerClient();
  const dbContainer = docker.getContainer(inst.container_ref as string);
  // 备份要求数据库容器处于运行中（复用其网络命名空间）
  const inspect = await dbContainer.inspect();
  if (inspect.State?.Running !== true) {
    throw new Error('数据库容器未运行，无法执行备份，请先启动该容器');
  }
  const image = DUMP_IMAGE[inst.type];
  await ensureImage(docker, image);
  const cmd = buildDumpCmd(inst, db, file, pwd);
  const container = await docker.createContainer({
    Image: image,
    Cmd: ['sh', '-c', cmd],
    HostConfig: {
      NetworkMode: `container:${inst.container_ref}`,
      Binds: [`${backupDir}:/backup`],
    },
  });
  try {
    await container.start();
    const res = await container.wait();
    if (res.StatusCode !== 0) {
      throw new Error(`数据库备份执行失败（退出码 ${res.StatusCode}）`);
    }
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/**
 * 在宿主机执行 dump：重定向输出到备份文件（回退通道，要求宿主机已装 CLI）
 * @param inst 实例
 * @param db 库名
 * @param file 完整输出文件路径
 * @param pwd 明文口令
 */
async function dumpOnHost(inst: DbInstance, db: string, file: string, pwd: string): Promise<void> {
  const port = inst.port;
  const user = inst.user || 'root';
  let cmd = '';
  if (inst.type === 'mysql' || inst.type === 'mariadb') {
    const auth = `-h${inst.host} -P${port} -u ${csh(user)}${pwd ? ` -p${csh(pwd)}` : ''}`;
    cmd = `mysqldump --single-transaction --skip-lock-tables --quick ${auth} ${csh(db)} | gzip > ${csh(file)}`;
  } else {
    const pwdPrefix = pwd ? `PGPASSWORD=${csh(pwd)} ` : '';
    cmd = `${pwdPrefix}pg_dump -h${inst.host} -p${port} -U ${csh(user)} -d ${csh(db)} | gzip > ${csh(file)}`;
  }
  try {
    await execAsync(cmd, { shell: hostShellForExec(), maxBuffer: 64 * 1024 * 1024 });
  } catch (err: any) {
    if (/ENOENT|not recognized|不是内部或外部命令/i.test(String(err?.message || ''))) {
      throw new Error('宿主机未安装对应数据库客户端 CLI（mysqldump/pg_dump），无法在宿主机模式备份');
    }
    throw new Error(err?.stderr || err?.message || '数据备份执行失败');
  }
}

/**
 * 初始化实例备份目录
 * @param inst 实例
 */
function ensureDir(inst: DbInstance): string {
  const dir = resolveSafePath(instanceDirName(inst.id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 发起一次数据级备份
 * @param inst 实例（须已解密）
 * @param db 要备份的库名
 * @returns 生成的备份文件信息
 */
export async function createDbBackup(inst: DbInstance, db: string): Promise<{ file: string; path: string; size: number; createdAt: number }> {
  if (!supportedType(inst.type)) {
    throw Object.assign(new Error('暂不支持该类型的数据级备份（仅支持 MySQL/MariaDB/PostgreSQL），Redis 请使用持久化配置'), {
      statusCode: 400,
    });
  }
  const dbName = String(db || '').trim();
  if (!dbName) throw Object.assign(new Error('请指定要备份的库名'), { statusCode: 400 });

  const dir = ensureDir(inst);
  const fileName = `${Date.now()}_${safeFileName(dbName)}.sql.gz`;
  const fullPath = resolveSafePath(instanceDirName(inst.id), fileName);
  const pwd = decryptSecret(inst.cred_encrypted);

  if (inst.container_ref) {
    await dumpInContainer(inst, dbName, resolveSafePath(instanceDirName(inst.id)), fileName, pwd);
  } else {
    await dumpOnHost(inst, dbName, fullPath, pwd);
  }

  if (!fs.existsSync(fullPath)) {
    throw new Error('备份失败：未生成输出文件');
  }
  return {
    file: fileName,
    path: fullPath,
    size: fs.statSync(fullPath).size,
    createdAt: Date.now(),
  };
}

/**
 * 列出某实例的全部备份文件
 * @param instanceId 实例 id
 */
export function listDbBackups(instanceId: number): Array<{ file: string; size: number; createdAt: number }> {
  const dir = resolveSafePath(instanceDirName(instanceId));
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ file: string; size: number; createdAt: number }> = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile()) continue;
    const ts = Number(f.slice(0, 13));
    out.push({ file: f, size: fs.statSync(full).size, createdAt: Number.isNaN(ts) ? 0 : ts });
  }
  // 按创建时间倒序（最新在前）
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * 安全解析某实例下的备份文件绝对路径（供下载），存在性校验由路由完成
 * @param instanceId 实例 id
 * @param fileName 文件名
 */
export function resolveBackupFile(instanceId: number, fileName: string): string {
  const file = safeFileName(fileName);
  return resolveSafePath(instanceDirName(instanceId), file);
}

/**
 * 删除某实例下的一个备份文件
 * @param instanceId 实例 id
 * @param fileName 文件名
 */
export function deleteDbBackup(instanceId: number, fileName: string): void {
  const full = resolveBackupFile(instanceId, fileName);
  const dir = resolveSafePath(instanceDirName(instanceId));
  // 仅允许删除本实例备份目录内的文件（不在子目录）
  if (path.dirname(full) !== dir) throw new Error('非法备份文件路径');
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw Object.assign(new Error('备份文件不存在'), { statusCode: 404 });
  }
  fs.unlinkSync(full);
}

/** 供路由注入/复用的 token */
export { DB_BACKUP_ROOT };
