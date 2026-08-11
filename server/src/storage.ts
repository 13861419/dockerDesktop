/**
 * SQLite 统一存储层（基于 Node 内置 node:sqlite，零第三方依赖）
 *
 * 负责打开/初始化数据库文件、建表、提供统一的 pragma 配置。
 * 各业务模块（users/hubConfig/imagePullHistory）通过本模块获取连接，
 * 并使用各自的表完成读写，替代原有的 JSON/文本文件存储。
 *
 * 数据库文件：见 resolveDataDir()（支持环境变量/Q 数据目录/安装目录回退）。
 * 注意：node:sqlite 为实验性 API，需要 Node.js >= 22。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * 解析数据目录（优先级从高到低）：
 *  1. 环境变量 DOCKERMANAGER_DATA（若已显式设置）
 *  2. 系统数据目录 %PROGRAMDATA%\DockerManager\data（正式安装到 Program Files 等受保护目录时使用，
 *     此处所有用户可写，规避安装目录不可写导致的启动失败）
 *  3. 回退：项目/安装目录下 data（开发环境与便携场景）
 *
 * @returns 数据目录绝对路径
 */
function resolveDataDir(): string {
  if (process.env.DOCKERMANAGER_DATA) {
    return path.resolve(process.env.DOCKERMANAGER_DATA);
  }
  const programData = process.env.PROGRAMDATA;
  if (programData) {
    const systemDir = path.join(programData, 'DockerManager', 'data');
    // 仅当安装位置不可写（位于系统保护目录）时，才启用系统数据目录
    if (!isDirWritable(path.join(__dirname, '..', '..', 'data'))) {
      return systemDir;
    }
  }
  // 默认回退到项目/安装目录下的 data（开发与便携场景）
  return path.join(__dirname, '..', '..', 'data');
}

/**
 * 校验目标目录是否可写（用于判断是否落入系统保护目录）
 * 不创建目录，仅尝试探测父级可写性，避免副作用。
 * @param dir 待检测目录
 */
function isDirWritable(dir: string): boolean {
  try {
    const probeDir = path.dirname(dir);
    if (!fs.existsSync(probeDir)) return false;
    // 在目标目录下尝试创建临时探测文件
    const testFile = path.join(probeDir, `.dm-probe-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/** 数据目录（见 resolveDataDir()，随模块加载解析一次） */
const DATA_DIR = resolveDataDir();
/** SQLite 数据库文件路径 */
const DB_FILE = path.join(DATA_DIR, 'docker-manager.db');

/** 全局单例数据库连接 */
let db: DatabaseSync | null = null;

/** 导出数据目录（便于启动日志/调试展示） */
export function getDataDir(): string {
  return DATA_DIR;
}

/**
 * 确保数据目录存在
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * 获取全局数据库连接（懒加载单例）
 *
 * 首次调用时打开数据库、设置基础 PRAGMA，并创建所有业务表。
 * @returns SQLite 数据库连接实例
 */
export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDataDir();
  db = new DatabaseSync(DB_FILE);
  // 开启外键约束（本库暂未使用外键，预留）与 WAL 日志模式提升并发读性能
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  createTables();
  return db;
}

/**
 * 创建所需的全部数据表（若不存在）
 */
function createTables(): void {
  const d = getDb();
  d.exec(`
    -- 用户表：账号、盐值、加盐密码哈希、角色、创建时间、是否需强制改密
    CREATE TABLE IF NOT EXISTS users (
      username             TEXT PRIMARY KEY,
      salt                 TEXT NOT NULL,
      password_hash        TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'user',
      created_at           INTEGER NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0
    );

    -- 镜像源表：加速源配置（内置源在并发重启时可能重复，用唯一约束保护）
    CREATE TABLE IF NOT EXISTS hub_sources (
      id      TEXT PRIMARY KEY,
      host    TEXT NOT NULL UNIQUE,
      name    TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    -- 自定义搜索源表：单行（id=1）存储用户配置的搜索 API 基址
    CREATE TABLE IF NOT EXISTS setting (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- 镜像拉取时间表：镜像ID -> 首次本地拉取时间戳（秒）
    CREATE TABLE IF NOT EXISTS image_pull_history (
      image_id TEXT PRIMARY KEY,
      pull_at  INTEGER NOT NULL
    );

    -- 操作审计日志表：记录用户手动执行的关键操作（启停容器、删镜像、建卷/网络、Compose 等）
    CREATE TABLE IF NOT EXISTS operation_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL,
      action      TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_name TEXT,
      detail      TEXT,
      success     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(created_at DESC);

    -- 定时任务表：记录计划任务（自动清理/备份/拉取/Compose 等）
    CREATE TABLE IF NOT EXISTS cron_tasks (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      cron        TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      config      TEXT NOT NULL DEFAULT '{}',
      last_run_at INTEGER,
      last_status INTEGER,
      last_detail TEXT,
      next_run_at INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cron_tasks_next_run ON cron_tasks(next_run_at);

    -- 定时任务执行历史表：记录每次定时/手动执行的日志（最多保留最近 N 条见 tasks.ts）
    CREATE TABLE IF NOT EXISTS cron_task_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      name       TEXT,
      type       TEXT,
      run_at     INTEGER NOT NULL,
      status     INTEGER NOT NULL,
      detail     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cron_task_logs_task ON cron_task_logs(task_id, id DESC);

    -- 应用商店安装记录表：记录 Compose 套件安装实例的参数快照（用于升级/重装比对）
    CREATE TABLE IF NOT EXISTS appstore_instances (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id       TEXT NOT NULL UNIQUE,
      project_name TEXT NOT NULL,
      version      TEXT,
      params       TEXT NOT NULL DEFAULT '{}',
      installed_at INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    -- 数据库实例登记表：记录可管理的数据库容器连接信息（口令加密存储）
    CREATE TABLE IF NOT EXISTS database_instances (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      type           TEXT NOT NULL,
      container_ref  TEXT,
      host           TEXT NOT NULL DEFAULT 'localhost',
      port           INTEGER NOT NULL,
      user           TEXT,
      cred_encrypted TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    -- 应用商店应用自定义参数表：记录单容器应用安装时的端口/卷/环境变量覆盖（用于升级/重装）
    CREATE TABLE IF NOT EXISTS appstore_app_params (
      app_id       TEXT PRIMARY KEY,
      params       TEXT NOT NULL DEFAULT '{}',
      updated_at   INTEGER NOT NULL
    );

    -- Docker 引擎表：多引擎配置（命名端点，可切换当前引擎）
    CREATE TABLE IF NOT EXISTS docker_engines (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      endpoint   TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // 迁移：为旧版本已存在的 users 表补充 must_change_password 列（新列默认 0，不强制）
  try {
    d.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  } catch {
    // 列已存在则忽略（首次创建即含该列）
  }
}

/**
 * 关闭数据库连接（服务退出时调用，进程结束前兜底落盘 WAL）
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // 忽略重复关闭错误
    }
    db = null;
  }
}

/** 
 * 生成（或缓存）用于加密敏感字段（如数据库口令）的对称密钥。
 *
 * 密钥来源：优先使用环境变量 CRED_SECRET（用户显式提供）；否则读取
 * <数据目录>/.cred-secret 文件，不存在则生成一个 32 字节随机密钥并落盘持久化，
 * 保证重启用同一密钥可解密历史数据。
 * @returns 32 字节对称密钥 Buffer
 */
function getCredentialKey(): Buffer {
  const envKey = process.env.CRED_SECRET;
  if (envKey && envKey.length >= 16) {
    return Buffer.from(envKey.slice(0, 32).padEnd(32, '0'), 'utf8');
  }
  const keyFile = path.join(DATA_DIR, '.cred-secret');
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  } catch {
    // 写盘失败不阻断（退化为内存密钥，重启后历史密文无法解密，但新写入仍可用）
  }
  return key;
}

/**
 * 使用共享密钥加密明文字符串（AES-256-GCM，随机 IV + 认证标签，Base64 输出）
 * @param plaintext 明文
 * @returns 加密后的密文（含版本号前缀 v1:）
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const key = getCredentialKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * 解密由 encryptSecret 加密的密文
 * @param encrypted 密文（v1: 前缀）
 * @returns 明文；无法解密时返回空串
 */
export function decryptSecret(encrypted: string | null | undefined): string {
  if (!encrypted || !String(encrypted).startsWith('v1:')) return '';
  try {
    const buf = Buffer.from(String(encrypted).slice(3), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getCredentialKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // 密钥不匹配或密文损坏时返回空串，由调用方提示用户
    return '';
  }
}

/**
 * 导出数据库：通过 VACUUM INTO 生成一份完整一致的 SQLite 副本文件路径
 * @returns 生成的可下载备份文件绝对路径
 * @throws 生成失败时抛错
 */
export function exportDatabase(): string {
  const d = getDb();
  ensureDataDir();
  const backupPath = path.join(DATA_DIR, `docker-manager-${Date.now()}.db.backup`);
  // VACUUM INTO 会生成包含全部数据的独立一致副本（含 WAL 合并）
  d.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}

/**
 * 导入/恢复数据库：校验 Buffer 为有效 SQLite 文件后，关闭当前连接并替换数据库文件
 * @param buffer 上传的数据库文件内容
 * @returns 恢复后的用户数等信息
 * @throws 校验失败或替换出错时抛错
 */
export function importDatabaseBuffer(buffer: Buffer): { users: number } {
  ensureDataDir();
  // 简单校验：SQLite 文件头
  if (!buffer || buffer.length < 16) throw new Error('无效的数据库文件');
  const magic = 'SQLite format 3\u0000';
  if (buffer.subarray(0, 16).toString('utf8') !== magic) {
    throw new Error('文件不是有效的 SQLite 数据库');
  }
  closeDb();
  const backupPath = path.join(DATA_DIR, 'docker-manager.pre-restore.db');
  if (fs.existsSync(DB_FILE)) {
    try {
      fs.copyFileSync(DB_FILE, backupPath);
    } catch {
      // 备份失败不阻断恢复
    }
  }
  // 清理可能残留的 WAL/SHM 文件，避免与新库冲突
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(DB_FILE + suffix, { force: true });
    } catch {
      // ignore
    }
  }
  fs.writeFileSync(DB_FILE, buffer);
  // 重新打开并重建表（兼容旧版本备份缺列的情况）
  getDb();
  createTables();
  const users = (getDb().prepare('SELECT count(*) AS c FROM users').get() as { c: number }).c;
  return { users };
}

/** 旧 JSON/文本存储文件名（供迁移识别），迁移成功后统一重命名为 .bak 保留备份 */
const LEGACY_USERS_FILE = path.join(DATA_DIR, 'users.json');
const LEGACY_SOURCES_FILE = path.join(DATA_DIR, 'hub-sources.json');
const LEGACY_SEARCH_FILE = path.join(DATA_DIR, 'hub-search-source.txt');
const LEGACY_PULL_FILE = path.join(DATA_DIR, 'image-pull-history.json');

/**
 * 将旧 JSON 数据安全迁移到 SQLite（幂等，仅当对应表为空时执行）
 *
 * 从原有 JSON/文本文件读取数据写入各表，成功后把旧文件重命名为 .bak 以便回退。
 * 单个文件损坏/缺失不会中断整体迁移。
 */
function migrateLegacyData(): void {
  const d = getDb();
  migrateUsers(d);
  migrateHubSources(d);
  migrateSearchSource(d);
  migratePullHistory(d);
}

/** 迁移 users.json -> users 表 */
function migrateUsers(d: DatabaseSync): void {
  if (!fs.existsSync(LEGACY_USERS_FILE)) return;
  const count = (d.prepare('SELECT count(*) AS c FROM users').get() as { c: number }).c;
  if (count > 0) return; // 表非空则不导入，避免覆盖
  try {
    const arr = JSON.parse(fs.readFileSync(LEGACY_USERS_FILE, 'utf8'));
    if (Array.isArray(arr)) {
      const ins = d.prepare(
        'INSERT OR IGNORE INTO users (username, salt, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const u of arr) {
        if (u && u.username && u.salt && u.passwordHash) {
          ins.run(u.username, u.salt, u.passwordHash, u.role || 'user', typeof u.createdAt === 'number' ? u.createdAt : Date.now());
        }
      }
      fs.renameSync(LEGACY_USERS_FILE, LEGACY_USERS_FILE + '.bak');
    }
  } catch {
    // 文件损坏则保留原文件，交由用户手动处理
  }
}

/** 迁移 hub-sources.json -> hub_sources 表 */
function migrateHubSources(d: DatabaseSync): void {
  if (!fs.existsSync(LEGACY_SOURCES_FILE)) return;
  const count = (d.prepare('SELECT count(*) AS c FROM hub_sources').get() as { c: number }).c;
  if (count > 0) return;
  try {
    const arr = JSON.parse(fs.readFileSync(LEGACY_SOURCES_FILE, 'utf8'));
    if (Array.isArray(arr)) {
      const ins = d.prepare(
        'INSERT OR IGNORE INTO hub_sources (id, host, name, builtin, enabled) VALUES (?, ?, ?, ?, ?)',
      );
      for (const s of arr) {
        if (s && s.id && s.host) {
          ins.run(s.id, s.host, s.name || null, s.builtin ? 1 : 0, s.enabled ? 1 : 0);
        }
      }
      fs.renameSync(LEGACY_SOURCES_FILE, LEGACY_SOURCES_FILE + '.bak');
    }
  } catch {
    // 忽略损坏文件
  }
}

/** 迁移 hub-search-source.txt -> setting 表（key=searchSource） */
function migrateSearchSource(d: DatabaseSync): void {
  if (!fs.existsSync(LEGACY_SEARCH_FILE)) return;
  const existing = d.prepare("SELECT 1 AS x FROM setting WHERE key = 'searchSource'").get();
  if (existing) return;
  try {
    const value = fs.readFileSync(LEGACY_SEARCH_FILE, 'utf8').trim();
    if (value) {
      d.prepare("INSERT OR IGNORE INTO setting (key, value) VALUES ('searchSource', ?)").run(value);
    }
    fs.renameSync(LEGACY_SEARCH_FILE, LEGACY_SEARCH_FILE + '.bak');
  } catch {
    // 忽略读取失败
  }
}

/** 迁移 image-pull-history.json -> image_pull_history 表 */
function migratePullHistory(d: DatabaseSync): void {
  if (!fs.existsSync(LEGACY_PULL_FILE)) return;
  const count = (d.prepare('SELECT count(*) AS c FROM image_pull_history').get() as { c: number }).c;
  if (count > 0) return;
  try {
    const obj = JSON.parse(fs.readFileSync(LEGACY_PULL_FILE, 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const ins = d.prepare('INSERT OR IGNORE INTO image_pull_history (image_id, pull_at) VALUES (?, ?)');
      for (const [imageId, ts] of Object.entries(obj)) {
        if (typeof ts === 'number') ins.run(imageId, ts);
      }
      fs.renameSync(LEGACY_PULL_FILE, LEGACY_PULL_FILE + '.bak');
    }
  } catch {
    // 忽略损坏文件
  }
}

/**
 * 初始化存储层：确保表就绪，并执行一次旧数据自动迁移（幂等）
 *
 * 应在服务启动时显式调用一次，保证迁移早于任何业务请求执行。
 */
export function initStorage(): void {
  getDb();
  migrateLegacyData();
}

export { DATA_DIR, DB_FILE };
