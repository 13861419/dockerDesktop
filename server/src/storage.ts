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
 *  2. 系统数据目录：
 *     - Windows：%PROGRAMDATA%\DockerManager\data
 *     - Linux：/var/lib/docker-manager（标准 FHS 路径）
 *  3. 回退：项目/安装目录下 data（开发环境与便携场景）
 *
 * @returns 数据目录绝对路径
 */
function resolveDataDir(): string {
  if (process.env.DOCKERMANAGER_DATA) {
    return path.resolve(process.env.DOCKERMANAGER_DATA);
  }
  // Windows：PROGRAMDATA
  const programData = process.env.PROGRAMDATA;
  if (programData) {
    const systemDir = path.join(programData, 'DockerManager', 'data');
    if (!isDirWritable(path.join(__dirname, '..', '..', 'data'))) {
      return systemDir;
    }
  }
  // Linux：标准 FHS 路径
  if (process.platform === 'linux') {
    const linuxDir = '/var/lib/docker-manager';
    try {
      // 若该目录已存在或其父目录可写，优先使用
      if (fs.existsSync(linuxDir) || isDirWritable('/var/lib')) {
        return linuxDir;
      }
    } catch {
      // ignore
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
  // 开启外键约束（本库暂未使用外键，预留）与 WAL 日志模式提升并发读性能。
  // busy_timeout 默认 0（遇到瞬时锁立即报 database is locked），
  // 设置为 5000ms 以等待短暂写锁（多进程/多连接并发时避免偶发锁冲突）。
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 15000;');
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

    -- 云端备份目标表：S3 / OSS / WebDAV 存储目标（凭据加密存储）
    CREATE TABLE IF NOT EXISTS cloud_targets (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL,            -- s3 | oss | webdav
      endpoint   TEXT NOT NULL,            -- 基址（WebDAV 服务器 / S3 region 端点 / OSS 端点）
      bucket     TEXT,                      -- 桶名（webdav 可空）
      path       TEXT NOT NULL DEFAULT '',  -- 基路径
      access_key TEXT,
      secret_encrypted TEXT,
      region     TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 反向代理站点表：站点域名 → 上游，经内置 nginx 反代容器承载
    CREATE TABLE IF NOT EXISTS sites (
      id            TEXT PRIMARY KEY,
      domain        TEXT NOT NULL UNIQUE,
      upstream_host TEXT NOT NULL,
      upstream_port INTEGER NOT NULL,
      listen_port   INTEGER NOT NULL,        -- 宿主机对外监听端口（80/443 或自定义）
      enable_https  INTEGER NOT NULL DEFAULT 0,
      cert_path     TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      -- 反代高级配置（新增列，迁移时以 ALTER 补列）
      enable_ws          INTEGER NOT NULL DEFAULT 0,  -- WebSocket 透传
      enable_gzip        INTEGER NOT NULL DEFAULT 0,  -- 启用 gzip 压缩
      enable_auth        INTEGER NOT NULL DEFAULT 0,  -- 站点 Basic Auth 访问控制
      auth_username      TEXT,                        -- 访问控制用户名
      auth_password      TEXT,                        -- 访问控制密码（htpasswd {SHA} 形式，或在页面展示时返回明文以重算）
      rate_limit         TEXT,                        -- 请求限速（如 "5r/s"，留空不开启）
      client_max_body    TEXT,                        -- 请求体大小上限（如 "50m"，留空默认 1m）
      proxy_timeout      INTEGER NOT NULL DEFAULT 60, -- 上游读超时/代理超时（秒）
      extra_config       TEXT,                        -- 自定义 nginx 高级配置片段（location 外，写在 server 内）
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    -- 备份清单表：记录本地备份文件及其恢复状态
    CREATE TABLE IF NOT EXISTS backups (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      name       TEXT NOT NULL,
      source     TEXT NOT NULL,
      file_path  TEXT NOT NULL,
      size       INTEGER NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'ready',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC);

    -- 镜像构建历史表：记录每次 Dockerfile 独立构建的结果（用于回溯与配置复用）
    CREATE TABLE IF NOT EXISTS image_build_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,               -- 镜像名称（含 tag，如 myapp:latest）
      context     TEXT NOT NULL,               -- 构建上下文目录
      dockerfile  TEXT NOT NULL DEFAULT 'Dockerfile',
      success     INTEGER NOT NULL DEFAULT 0,  -- 构建是否成功（1/0）
      log_preview TEXT,                        -- 构建日志尾部预览（便于快速排查失败）
      duration_ms INTEGER NOT NULL DEFAULT 0,  -- 构建耗时（毫秒）
      created_at  INTEGER NOT NULL             -- 构建时间（秒）
    );
    CREATE INDEX IF NOT EXISTS idx_build_history_created ON image_build_history(created_at DESC);

    -- Docker 事件持久化表：采集器批量落库，供历史查询/导出（Docker 事件本身不持久化）
    CREATE TABLE IF NOT EXISTS docker_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      time        INTEGER NOT NULL,            -- 事件产生时间（毫秒）
      type        TEXT NOT NULL DEFAULT '',    -- container / image / volume / network / plugin / daemon
      action      TEXT NOT NULL DEFAULT '',    -- start / stop / destroy 等
      entity_id   TEXT NOT NULL DEFAULT '',    -- 事件主体标识（容器 id / 镜像名 / 卷名 / 网络名）
      scope       TEXT NOT NULL DEFAULT 'local',
      attributes  TEXT NOT NULL DEFAULT '{}',  -- 附加过滤属性（JSON）
      created_at  INTEGER NOT NULL             -- 落库时间（秒，用于保留清理）
    );
    CREATE INDEX IF NOT EXISTS idx_docker_events_time ON docker_events(time DESC);
    CREATE INDEX IF NOT EXISTS idx_docker_events_type ON docker_events(type);

    -- 防火墙端口放行规则表：记录由本面板管理的 Windows 防火墙入站放行规则
    CREATE TABLE IF NOT EXISTS firewall_ports (
      id         TEXT PRIMARY KEY,
      port       INTEGER NOT NULL,          -- 端口号（1-65535）
      proto      TEXT NOT NULL DEFAULT 'tcp', -- tcp / udp
      name       TEXT NOT NULL,             -- Windows 防火墙规则名（含面板前缀）
      remark     TEXT,                      -- 备注
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_firewall_ports_port_proto ON firewall_ports(port, proto);

    -- 通知渠道表：告警推送目标（Webhook / 邮件 / 钉钉 / 飞书），敏感凭据加密存储
    CREATE TABLE IF NOT EXISTS notify_channels (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL,             -- webhook | email | dingtalk | feishu
      enabled    INTEGER NOT NULL DEFAULT 1,
      config     TEXT NOT NULL DEFAULT '{}', -- 类型相关配置（URL/收件人等），敏感字段加密
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 告警规则表：资源告警阈值与开关（cpu/mem/disk 各一行，cpu 阈值等）
    CREATE TABLE IF NOT EXISTS alert_rules (
      type        TEXT PRIMARY KEY,         -- cpu | mem | disk
      enabled     INTEGER NOT NULL DEFAULT 1,
      warn_threshold  REAL NOT NULL DEFAULT 75, -- 警告阈值（使用率 %）
      danger_threshold REAL NOT NULL DEFAULT 90, -- 危险阈值（使用率 %）
      updated_at  INTEGER NOT NULL
    );

    -- 告警记录表：每次触发的告警事件（含推送结果）
    CREATE TABLE IF NOT EXISTS alert_records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,            -- cpu | mem | disk
      level       TEXT NOT NULL,            -- warn | danger
      message     TEXT NOT NULL,
      value       REAL,                     -- 触发时的使用率值
      channel_id  TEXT,                     -- 实际推送使用的渠道（无渠道/失败时为空）
      push_status TEXT NOT NULL DEFAULT 'none', -- none | ok | failed
      push_detail TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_records_created ON alert_records(created_at DESC);

    -- 容器级告警规则表：针对具体容器的退出/健康检查/端口探测告警（同一容器同监控类型唯一）
    CREATE TABLE IF NOT EXISTS container_alert_rules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id  TEXT NOT NULL,                -- 目标容器（docker id 或名称）
      watch_type    TEXT NOT NULL,                -- exited | health | port
      enabled       INTEGER NOT NULL DEFAULT 1,
      port          INTEGER,                      -- watch_type=port 时的探测端口（留空用容器映射主端口）
      silent_start  TEXT,                         -- 静默时段开始 HH:mm
      silent_end    TEXT,                         -- 静默时段结束
      workdays_only INTEGER NOT NULL DEFAULT 0,   -- 仅工作日
      work_start    TEXT,                         -- 工作时段开始
      work_end      TEXT,                         -- 工作时段结束
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE(container_id, watch_type)
    );

    -- 主机监控指标采样表：采集器降采样落库，供跨小时/跨天历史趋势查询（重启不丢失）
    CREATE TABLE IF NOT EXISTS host_metrics (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                 INTEGER NOT NULL,             -- 采样时间（毫秒）
      cpu_percent        REAL NOT NULL,
      cpu_cores          INTEGER NOT NULL,
      mem_percent        REAL NOT NULL,
      mem_used           INTEGER NOT NULL,
      mem_total          INTEGER NOT NULL,
      disk_percent       REAL NOT NULL,
      disk_used          INTEGER NOT NULL,
      disk_total         INTEGER NOT NULL,
      net_rx             INTEGER NOT NULL,             -- 累计接收字节
      net_tx             INTEGER NOT NULL,             -- 累计发送字节
      containers_running INTEGER NOT NULL,
      containers_total   INTEGER NOT NULL,
      images             INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_host_metrics_ts ON host_metrics(ts DESC);

    -- 容器资源指标采样表：采集器对每个运行中容器降采样落库，供容器详情页历史趋势查询
    CREATE TABLE IF NOT EXISTS container_metrics (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id TEXT NOT NULL,                  -- 容器 id（完整 64 字符）
      ts           INTEGER NOT NULL,               -- 采样时间（毫秒）
      cpu_percent  REAL NOT NULL,                  -- CPU 使用率（0-100，已按核数归一化）
      mem_usage    INTEGER NOT NULL,               -- 内存使用量（字节）
      mem_limit    INTEGER NOT NULL,               -- 内存上限（字节）
      mem_percent  REAL NOT NULL,                  -- 内存使用率（0-100）
      net_rx       INTEGER NOT NULL,               -- 累计接收字节
      net_tx       INTEGER NOT NULL,               -- 累计发送字节
      rx_delta     INTEGER NOT NULL DEFAULT 0,     -- 本次采样周期内接收增量（字节）
      tx_delta     INTEGER NOT NULL DEFAULT 0      -- 本次采样周期内发送增量（字节）
    );
    CREATE INDEX IF NOT EXISTS idx_container_metrics_id_ts ON container_metrics(container_id, ts DESC);

    -- 容器模板库表：用户保存的容器部署模板（config 为容器配置 JSON，与 /config 导出兼容）
    CREATE TABLE IF NOT EXISTS container_templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,         -- 模板名称（唯一）
      description TEXT,                        -- 描述（可选）
      image      TEXT NOT NULL DEFAULT '',     -- 主镜像（便于列表展示与检索）
      config     TEXT NOT NULL DEFAULT '{}',   -- 容器配置 JSON（docker-manager.container.config/v1 的 config 部分）
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_container_templates_name ON container_templates(name);

    -- 应用商店自定义应用表：用户新增的应用定义（与内置目录一起展示、可安装），字段复刻 AppDefinition
    CREATE TABLE IF NOT EXISTS appstore_custom_apps (
      id          TEXT PRIMARY KEY,            -- 应用 id（custom- 前缀避免与内置冲突）
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category    TEXT NOT NULL DEFAULT '自定义',
      image       TEXT NOT NULL,
      icon        TEXT NOT NULL DEFAULT '📦',
      ports       TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
      env         TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
      volumes     TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
      tags        TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
      compose     TEXT,                        -- compose 定义 JSON（可选，未填为单容器应用）
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Compose 模板库表：用户保存的常用 Compose 配置（YAML 文本），供新建项目时快速复用
    CREATE TABLE IF NOT EXISTS compose_templates (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,         -- 模板名称（唯一）
      description TEXT,                         -- 描述（可选）
      content     TEXT NOT NULL DEFAULT '',     -- compose 文件原文（YAML）
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_compose_templates_name ON compose_templates(name);

    -- 容器启动依赖编排表：记录每个容器所依赖(需先启动)的容器 id 集合，用于一键按拓扑序编排启停
    CREATE TABLE IF NOT EXISTS container_dependencies (
      container_id  TEXT PRIMARY KEY,          -- 被编排容器 id
      deps          TEXT NOT NULL DEFAULT '[]', -- 依赖的容器 id 数组(JSON)，这些容器需先于本容器启动
      enabled       INTEGER NOT NULL DEFAULT 1, -- 是否参与编排(0=跳过)
      updated_at    INTEGER NOT NULL
    );

    -- 编排执行历史表：记录每次一键启动/停止/重启的结果留档，供追踪复盘
    CREATE TABLE IF NOT EXISTS orchestrate_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,               -- start | stop | restart
      started_at  INTEGER NOT NULL,            -- 开始时间戳(ms)
      duration_ms INTEGER NOT NULL DEFAULT 0,  -- 总耗时(ms)
      success     INTEGER NOT NULL DEFAULT 0,  -- 成功容器数
      fail        INTEGER NOT NULL DEFAULT 0,  -- 失败容器数
      skipped     INTEGER NOT NULL DEFAULT 0,  -- 跳过容器数
      detail      TEXT NOT NULL DEFAULT '{}',  -- 分轮明细 JSON（含 phases 与 order）
      error       TEXT,                        -- 整体错误（如依赖环）
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orchestrate_runs_started ON orchestrate_runs(started_at DESC);

    -- AI 助手配置表（单行：id 恒为 1），密钥经 encryptSecret 对称加密
    CREATE TABLE IF NOT EXISTS ai_settings (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      enabled       INTEGER NOT NULL DEFAULT 0,   -- 总开关
      base_url      TEXT NOT NULL DEFAULT '',     -- OpenAI 兼容端点
      model         TEXT NOT NULL DEFAULT '',     -- 模型名
      api_key_enc   TEXT NOT NULL DEFAULT '',     -- encryptSecret(apiKey)
      system_prompt TEXT NOT NULL DEFAULT '',     -- 自定义系统提示词
      timeout_ms    INTEGER NOT NULL DEFAULT 60000,
      updated_at    INTEGER NOT NULL
    );

    -- AI 配置文件表（多套配置），密钥经 encryptSecret 对称加密
    CREATE TABLE IF NOT EXISTS ai_profiles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL DEFAULT '',
      kind          TEXT NOT NULL DEFAULT 'local',
      provider      TEXT NOT NULL DEFAULT 'custom',
      base_url      TEXT NOT NULL DEFAULT '',
      model         TEXT NOT NULL DEFAULT '',
      api_key_enc   TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      timeout_ms    INTEGER NOT NULL DEFAULT 60000,
      is_default    INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    -- AI 用量统计表（每次对话/流式调用记录一条 token 用量）
    CREATE TABLE IF NOT EXISTS ai_usage (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id         INTEGER,                       -- 关联 ai_profiles.id，可为空
      provider           TEXT NOT NULL DEFAULT '',      -- 冗余 provider 名便于展示
      model              TEXT NOT NULL DEFAULT '',      -- 模型名快照
      tool               TEXT NOT NULL DEFAULT '',      -- chat / compose-infer / logs 等
      prompt_tokens      INTEGER NOT NULL DEFAULT 0,    -- 输入 token
      completion_tokens  INTEGER NOT NULL DEFAULT 0,    -- 输出 token
      total_tokens       INTEGER NOT NULL DEFAULT 0,    -- 合计
      prompt_chars       INTEGER NOT NULL DEFAULT 0,    -- 估算输入字符（无法取到 usage 时用）
      completion_chars   INTEGER NOT NULL DEFAULT 0,    -- 估算输出字符
      duration_ms        INTEGER NOT NULL DEFAULT 0,    -- 响应时间（毫秒）
      success            INTEGER NOT NULL DEFAULT 1,    -- 是否成功
      error_message      TEXT NOT NULL DEFAULT '',      -- 失败原因
      username           TEXT NOT NULL DEFAULT '',      -- 调用者
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_model   ON ai_usage(model);

    -- AI 对话历史表（每会话一条，messages 存 JSON 文本）
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL DEFAULT '新对话',
      messages    TEXT NOT NULL DEFAULT '[]',       -- JSON 数组 [{role,content,error?}]
      tool        TEXT NOT NULL DEFAULT '',         -- 会话绑定的工具（chat/compose-infer/logs）
      target      TEXT NOT NULL DEFAULT '',         -- logs 工具的目标容器
      username    TEXT NOT NULL DEFAULT '',         -- 归属用户
      pinned      INTEGER NOT NULL DEFAULT 0,       -- 是否置顶/收藏
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_session_user ON ai_chat_sessions(username, updated_at);

    CREATE TABLE IF NOT EXISTS ai_prompt_templates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT '通用',
      prompt      TEXT NOT NULL,
      is_system   INTEGER NOT NULL DEFAULT 0,  -- 1=预置模板（不可删除）
      username    TEXT NOT NULL DEFAULT '',     -- 用户自定义模板归属
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_template_user ON ai_prompt_templates(username, category);

    CREATE TABLE IF NOT EXISTS ai_cache (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_hash TEXT NOT NULL UNIQUE,
      prompt      TEXT NOT NULL,
      response    TEXT NOT NULL,
      model       TEXT NOT NULL DEFAULT '',
      hit_count   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_cache_hash ON ai_cache(prompt_hash, expires_at);

    CREATE TABLE IF NOT EXISTS ai_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL,
      action_type TEXT NOT NULL,
      params      TEXT NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'pending',
      ai_message  TEXT NOT NULL DEFAULT '',
      result      TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ai_actions_user_status ON ai_actions(username, status);

    -- AI 运维知识库（RAG）
    CREATE TABLE IF NOT EXISTS ai_knowledge (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'general',
      content     TEXT NOT NULL,
      tags        TEXT NOT NULL DEFAULT '[]',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_knowledge_category ON ai_knowledge(category);

    -- AI 定时巡检报告
    CREATE TABLE IF NOT EXISTS ai_inspections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      status      INTEGER NOT NULL DEFAULT 0,       -- 0=正常 1=存在异常
      summary     TEXT NOT NULL DEFAULT '',         -- AI 摘要（Markdown）
      snapshot    TEXT NOT NULL DEFAULT '',         -- 采集时的容器快照
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_inspections_created ON ai_inspections(created_at);

    -- 高危操作审批流（二期）
    CREATE TABLE IF NOT EXISTS approvals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL,                    -- 提交人
      action_type TEXT NOT NULL,                    -- 动作类型（container.delete 等）
      target      TEXT NOT NULL,                    -- 目标标识（容器 ID / 镜像名 / 卷名 / all）
      payload     TEXT NOT NULL DEFAULT '{}',       -- 执行参数 JSON
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected/cancelled
      reason      TEXT NOT NULL DEFAULT '',         -- 提交说明
      result      TEXT,                             -- 执行结果或拒绝理由
      created_at  INTEGER NOT NULL,
      decided_at  INTEGER,
      decided_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
  `);

  // 迁移：为 ai_knowledge 表补充 embedding 列（BLOB 存储向量）
  try {
    d.exec('ALTER TABLE ai_knowledge ADD COLUMN embedding BLOB');
  } catch {
    // 列已存在则忽略
  }

  // 迁移：为 ai_knowledge 表补充 owner 和 shared 列（多用户知识库）
  try {
    d.exec("ALTER TABLE ai_knowledge ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
  } catch {
    // 列已存在则忽略
  }
  try {
    d.exec('ALTER TABLE ai_knowledge ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
  } catch {
    // 列已存在则忽略
  }

  // 迁移：为 ai_chat_sessions 表补充 pinned 列（会话收藏/置顶）
  try {
    d.exec('ALTER TABLE ai_chat_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  } catch {
    // 列已存在则忽略
  }

  // 迁移：为旧版本已存在的 users 表补充 must_change_password 列（新列默认 0，不强制）
  try {
    d.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  } catch {
    // 列已存在则忽略（首次创建即含该列）
  }

  // 迁移：为 hub_sources 表补充 is_default 列（显式默认源标记，0=非默认 1=默认）
  try {
    d.exec('ALTER TABLE hub_sources ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
  } catch {
    // 列已存在则忽略
  }

  // 迁移：为 hub_sources 表补充 sort_order 列（手动排序，值越小优先级越高，控制 failover 顺序）
  try {
    d.exec('ALTER TABLE hub_sources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  } catch {
    // 列已存在则忽略
  }

  // 迁移：为 ai_profiles 表补充预算控制列（月度 token/费用上限，0=不限制）
  for (const col of ['budget_monthly_tokens', 'budget_monthly_cost']) {
    try {
      d.exec(`ALTER TABLE ai_profiles ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // 列已存在则忽略
    }
  }

  // 迁移：为 sites 表补充反代高级配置列（逐列宽松迁移，兼容旧库）
  const siteMigrations: Array<{ col: string; ddl: string }> = [
    { col: 'enable_ws', ddl: 'ALTER TABLE sites ADD COLUMN enable_ws INTEGER NOT NULL DEFAULT 0' },
    { col: 'enable_gzip', ddl: 'ALTER TABLE sites ADD COLUMN enable_gzip INTEGER NOT NULL DEFAULT 0' },
    { col: 'enable_auth', ddl: 'ALTER TABLE sites ADD COLUMN enable_auth INTEGER NOT NULL DEFAULT 0' },
    { col: 'auth_username', ddl: 'ALTER TABLE sites ADD COLUMN auth_username TEXT' },
    { col: 'auth_password', ddl: 'ALTER TABLE sites ADD COLUMN auth_password TEXT' },
    { col: 'rate_limit', ddl: 'ALTER TABLE sites ADD COLUMN rate_limit TEXT' },
    { col: 'client_max_body', ddl: 'ALTER TABLE sites ADD COLUMN client_max_body TEXT' },
    { col: 'proxy_timeout', ddl: 'ALTER TABLE sites ADD COLUMN proxy_timeout INTEGER NOT NULL DEFAULT 60' },
    { col: 'extra_config', ddl: 'ALTER TABLE sites ADD COLUMN extra_config TEXT' },
  ];
  for (const m of siteMigrations) {
    try {
      // 仅当列不存在时执行（避免重复迁移）
      const cols = d.prepare('PRAGMA table_info(sites)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === m.col)) d.exec(m.ddl);
    } catch {
      // 列已存在则忽略
    }
  }

  // 迁移：为 alert_rules 表补充告警静默/工作时间段字段（HH:mm 或 NULL 表示不启用）
  try {
    d.exec("ALTER TABLE alert_rules ADD COLUMN silent_start TEXT");
  } catch {
    // 列已存在则忽略
  }
  try {
    d.exec("ALTER TABLE alert_rules ADD COLUMN silent_end TEXT");
  } catch {
    // 列已存在则忽略
  }
  try {
    d.exec('ALTER TABLE alert_rules ADD COLUMN workdays_only INTEGER NOT NULL DEFAULT 0');
  } catch {
    // 列已存在则忽略
  }
  try {
    d.exec("ALTER TABLE alert_rules ADD COLUMN work_start TEXT");
  } catch {
    // 列已存在则忽略
  }
  try {
    d.exec("ALTER TABLE alert_rules ADD COLUMN work_end TEXT");
  } catch {
    // 列已存在则忽略
  }

  // 迁移：为 container_alert_rules 补充 CPU/内存阈值列（watch_type=cpu/mem 时使用，其余类型为 NULL/默认）
  try {
    d.exec('ALTER TABLE container_alert_rules ADD COLUMN warn_threshold REAL DEFAULT 75');
  } catch {
    // 列已存在则忽略
  }
  try {
    d.exec('ALTER TABLE container_alert_rules ADD COLUMN danger_threshold REAL DEFAULT 90');
  } catch {
    // 列已存在则忽略
  }

  // 迁移：为 cron_tasks 补充 Webhook 触发 token 列（NULL/空=未开启 Webhook）
  try {
    d.exec('ALTER TABLE cron_tasks ADD COLUMN webhook_token TEXT');
  } catch {
    // 列已存在则忽略
  }
  // 迁移：为 cron_tasks 补充 Git 私有仓库凭证列（加密 JSON，NULL=无凭证）
  try {
    d.exec('ALTER TABLE cron_tasks ADD COLUMN git_cred_encrypted TEXT');
  } catch {
    // 列已存在则忽略
  }
  // 迁移：为 ai_usage 补充响应时间列
  try {
    d.exec('ALTER TABLE ai_usage ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0');
  } catch {
    // 列已存在则忽略
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
  seedContainerTemplates(getDb());
}

/**
 * 内置示例容器模板：config 结构与创建接口 /api/containers 兼容，
 * 供容器页「从模板创建」一键回填，方便快速体验常用镜像部署。
 * 仅在 container_templates 表为空时注入一次（幂等），不覆盖用户已保存的模板。
 */
const BUILTIN_TEMPLATES: Array<{
  name: string;
  description: string;
  image: string;
  config: Record<string, unknown>;
}> = [
  {
    name: 'Nginx 静态站点',
    description: '高性能 Web 服务器 / 反向代理，映射宿主机 8080 端口',
    image: 'nginx:alpine',
    config: {
      name: 'nginx-site',
      image: 'nginx:alpine',
      command: '',
      networkMode: 'default',
      restartPolicy: 'unless-stopped',
      tty: true,
      ports: [{ host: '8080', container: '80', protocol: 'tcp' }],
      volumes: [],
      env: [],
    },
  },
  {
    name: 'MySQL 数据库',
    description: '关系型数据库，含数据卷持久化与初始账号配置',
    image: 'mysql:8',
    config: {
      name: 'mysql',
      image: 'mysql:8',
      command: '',
      networkMode: 'default',
      restartPolicy: 'unless-stopped',
      tty: true,
      ports: [{ host: '3306', container: '3306', protocol: 'tcp' }],
      volumes: [{ source: 'mysql_data', target: '/var/lib/mysql', readonly: false }],
      env: [
        'MYSQL_ROOT_PASSWORD=root123456',
        'MYSQL_DATABASE=app',
        'MYSQL_USER=app',
        'MYSQL_PASSWORD=app123456',
      ],
    },
  },
  {
    name: 'Redis 缓存',
    description: '高性能键值缓存数据库，映射宿主机 6379 端口',
    image: 'redis:7-alpine',
    config: {
      name: 'redis',
      image: 'redis:7-alpine',
      command: '',
      networkMode: 'default',
      restartPolicy: 'unless-stopped',
      tty: false,
      ports: [{ host: '6379', container: '6379', protocol: 'tcp' }],
      volumes: [{ source: 'redis_data', target: '/data', readonly: false }],
      env: [],
    },
  },
  {
    name: 'Portainer 管理面板',
    description: 'Docker 图形化管理面板（需挂载 Docker Socket）',
    image: 'portainer/portainer-ce',
    config: {
      name: 'portainer',
      image: 'portainer/portainer-ce',
      command: '',
      networkMode: 'default',
      restartPolicy: 'unless-stopped',
      tty: true,
      privileged: true,
      ports: [{ host: '9000', container: '9000', protocol: 'tcp' }],
      volumes: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock', readonly: false }],
      env: [],
    },
  },
  {
    name: 'Uptime Kuma 监控面板',
    description: '开源网站 / 服务可用性监控面板，映射宿主机 3001 端口',
    image: 'louislam/uptime-kuma:1',
    config: {
      name: 'uptime-kuma',
      image: 'louislam/uptime-kuma:1',
      command: '',
      networkMode: 'default',
      restartPolicy: 'unless-stopped',
      tty: true,
      ports: [{ host: '3001', container: '3001', protocol: 'tcp' }],
      volumes: [{ source: 'uptime_data', target: '/app/data', readonly: false }],
      env: [],
    },
  },
];

function seedContainerTemplates(d: DatabaseSync): void {
  // 内置示例模板：固定 id（builtin-N），存在则同步为最新定义，缺失则插入。
  // 用 id 强制覆盖内置定义（便于修正/升级内置模板），不会影响用户自定义模板（其 id 为 UUID）。
  const now = Date.now();
  const getRow = d.prepare('SELECT id FROM container_templates WHERE id = ?');
  const upd = d.prepare(
    'UPDATE container_templates SET name = ?, description = ?, image = ?, config = ?, updated_at = ? WHERE id = ?',
  );
  const ins = d.prepare(
    'INSERT OR IGNORE INTO container_templates (id, name, description, image, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  BUILTIN_TEMPLATES.forEach((t, i) => {
    const id = `builtin-${i + 1}`;
    const cfg = JSON.stringify(t.config);
    if (getRow.get(id)) {
      upd.run(t.name, t.description, t.image, cfg, now, id);
    } else {
      // 若与用户模板重名（name 唯一约束），INSERT OR IGNORE 会自动跳过该内置示例
      ins.run(id, t.name, t.description, t.image, cfg, now, now);
    }
  });
}

export { DATA_DIR, DB_FILE };
