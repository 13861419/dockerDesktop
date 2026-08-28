/**
 * 面板配置导入 / 导出
 *
 * 提供面板配置的 JSON 级导出与导入，用于在另一台机器/实例上恢复或迁移配置：
 *  - GET  /api/system/config/export?includeSecrets=1  导出配置 JSON（含/不含敏感字段明文）
 *  - POST /api/system/config/import                  导入配置 JSON，按冲突策略合并
 *
 * 与「全库二进制备份/恢复」不同，这里是选择性、可读、可增量合并的 JSON 层：
 *  - 敏感字段（通知渠道 secret/密码、云端 S3/OSS/WebDAV 密钥、数据库实例口令）默认以明文导出，
 *    也可选择仅导出「已设置」占位，由导入端重新加密落库（跨机器安全）。
 *  - 导入支持 skip / overwrite / error 三种冲突策略。
 *  - 导入后自动执行必要后处理（反代配置重建、引擎重置/事件监听重启、计划任务下次执行时间重算）。
 */
import { Router, Request, Response } from 'express';
import { getDb, encryptSecret, decryptSecret } from '../storage';
import { resetDockerCache } from '../docker/client';
import { restartEventMonitor } from '../docker/events';
import { nextRunTime } from '../scheduler';
import { syncReverseProxy } from './sites';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/** 导出格式版本 */
const FORMAT_VERSION = 1;

/** 统一兜底错误处理 */
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
 * 通知渠道各类的敏感字段名（与 notify.ts 的 SECRET_FIELDS 保持一致）
 * 用于导出时定位需解密/清空的字段
 */
const CHANNEL_SECRET_FIELDS: Record<string, string[]> = {
  webhook: ['secret'],
  email: ['password'],
  dingtalk: ['accessToken', 'secret'],
  feishu: [],
};

/**
 * 解密一个存于 JSON 内的渠道敏感字段值（存储形如 enc:<v1 密文>）
 * @param value 原始值
 * @returns 明文；无法解密时返回原值
 */
function decryptChannelSecret(value: unknown): string {
  if (typeof value !== 'string') return '';
  const s = String(value).trim();
  if (s.startsWith('enc:')) {
    try {
      return decryptSecret(s.slice(4));
    } catch {
      return '';
    }
  }
  if (s.startsWith('v1:')) {
    try {
      return decryptSecret(s);
    } catch {
      return '';
    }
  }
  return s; // 已是明文
}

/**
 * 将明文加密为渠道 JSON 内存储的敏感字段值（enc: 包裹）
 * @param plain 明文
 * @returns 加密串（enc:<v1:...>）；空输入返回空
 */
function encryptChannelSecret(plain: unknown): string {
  if (plain === undefined || plain === null) return '';
  const p = String(plain);
  if (p === '') return '';
  if (p.startsWith('enc:') || p.startsWith('v1:')) return p; // 已是密文
  return 'enc:' + encryptSecret(p);
}

// ==================== 导出 ====================

/**
 * 构造配置导出 JSON
 * @param includeSecrets 是否包含敏感字段明文（false 时仅导出"已设置"占位）
 */
function buildExport(includeSecrets: boolean): Record<string, unknown> {
  const d = getDb();
  const out: Record<string, unknown> = {};

  // 用户（salt/hash 已脱敏，可原样导出，无法反推明文）
  out.users = (d.prepare('SELECT username, salt, password_hash, role, must_change_password, created_at FROM users').all() as any[]).map((r) => ({
    username: r.username,
    salt: r.salt,
    passwordHash: r.password_hash,
    role: r.role,
    mustChangePassword: !!r.must_change_password,
    createdAt: r.created_at,
  }));

  // 镜像源：仅导出自定义源（内置源由 ensureBuiltinSources 幂等兜底）
  out.hubSources = (d.prepare('SELECT id, host, name, builtin, enabled, is_default, sort_order FROM hub_sources').all() as any[])
    .filter((r) => !r.builtin)
    .map((r) => ({ id: r.id, host: r.host, name: r.name || '', enabled: !!r.enabled, isDefault: !!r.is_default, sortOrder: r.sort_order || 0 }));

  // 设置键值
  out.settings = (d.prepare('SELECT key, value FROM setting').all() as any[]).map((r) => ({ key: r.key, value: r.value }));

  // 引擎（endpoint 为显式连接串，非面板自有凭据，可导出）
  out.engines = (d.prepare('SELECT id, name, endpoint, is_current FROM docker_engines').all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    endpoint: r.endpoint,
    isCurrent: !!r.is_current,
  }));

  // Compose / 容器模板
  out.composeTemplates = (d.prepare('SELECT id, name, description, content FROM compose_templates').all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description || '',
    content: r.content,
  }));
  out.containerTemplates = (d.prepare('SELECT id, name, description, image, config FROM container_templates').all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description || '',
    image: r.image,
    config: r.config,
  }));

  // 计划任务：剔除运行时字段（last_* / next_run_at），导入时重算
  out.cronTasks = (d.prepare('SELECT id, name, type, cron, enabled, config FROM cron_tasks').all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    cron: r.cron,
    enabled: !!r.enabled,
    config: r.config,
  }));

  // 反代站点：auth_password 已是 {SHA} 哈希（脱敏），可原样导出；cert_path 为宿主路径（仅字符串）
  out.sites = (d.prepare('SELECT * FROM sites').all() as any[]).map((r) => ({
    id: r.id,
    domain: r.domain,
    upstreamHost: r.upstream_host,
    upstreamPort: r.upstream_port,
    listenPort: r.listen_port,
    enableHttps: !!r.enable_https,
    certPath: r.cert_path || '',
    enabled: !!r.enabled,
    enableWs: !!r.enable_ws,
    enableGzip: !!r.enable_gzip,
    enableAuth: !!r.enable_auth,
    authUsername: r.auth_username || '',
    authPassword: r.auth_password || '',
    rateLimit: r.rate_limit || '',
    clientMaxBody: r.client_max_body || '1m',
    proxyTimeout: r.proxy_timeout || 60,
    extraConfig: r.extra_config || '',
  }));

  // 宿主告警规则
  out.alertRules = (d.prepare('SELECT type, enabled, warn_threshold, danger_threshold, silent_start, silent_end, workdays_only, work_start, work_end FROM alert_rules').all() as any[]).map((r) => ({
    type: r.type,
    enabled: !!r.enabled,
    warnThreshold: r.warn_threshold,
    dangerThreshold: r.danger_threshold,
    silentStart: r.silent_start || null,
    silentEnd: r.silent_end || null,
    workdaysOnly: !!r.workdays_only,
    workStart: r.work_start || null,
    workEnd: r.work_end || null,
  }));

  // 容器级告警规则
  out.containerAlertRules = (d.prepare('SELECT container_id, watch_type, enabled, port, silent_start, silent_end, workdays_only, work_start, work_end FROM container_alert_rules').all() as any[]).map((r) => ({
    containerId: r.container_id,
    watchType: r.watch_type,
    enabled: !!r.enabled,
    port: r.port || null,
    silentStart: r.silent_start || null,
    silentEnd: r.silent_end || null,
    workdaysOnly: !!r.workdays_only,
    workStart: r.work_start || null,
    workEnd: r.work_end || null,
  }));

  // 通知渠道：config 内敏感字段按 includeSecrets 解密/清空
  out.notifyChannels = (d.prepare('SELECT id, name, type, enabled, config FROM notify_channels').all() as any[]).map((r) => {
    let cfg: Record<string, any> = {};
    try {
      cfg = JSON.parse(r.config || '{}');
    } catch {
      cfg = {};
    }
    const secretFields = CHANNEL_SECRET_FIELDS[r.type] || [];
    const hasSecrets: Record<string, boolean> = {};
    for (const k of secretFields) {
      const v = cfg[k];
      const isEnc = typeof v === 'string' && (v.startsWith('enc:') || v.startsWith('v1:'));
      if (isEnc || (typeof v === 'string' && v !== '')) {
        hasSecrets[k] = true;
        cfg[k] = includeSecrets ? decryptChannelSecret(v) : '';
      }
    }
    return { id: r.id, name: r.name, type: r.type, enabled: !!r.enabled, config: cfg, secretsSet: hasSecrets };
  });

  // 云端备份目标：secret 字段密/明文
  out.cloudTargets = (d.prepare('SELECT id, name, type, endpoint, bucket, path, access_key, secret_encrypted, region FROM cloud_targets').all() as any[]).map((r) => {
    const hasSecret = !!r.secret_encrypted && String(r.secret_encrypted).startsWith('v1:');
    let secret = '';
    if (hasSecret) {
      try {
        secret = includeSecrets ? decryptSecret(r.secret_encrypted) : '';
      } catch {
        secret = '';
      }
    }
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      endpoint: r.endpoint,
      bucket: r.bucket || '',
      path: r.path || '',
      accessKey: r.access_key || '',
      secret: hasSecret ? secret : r.secret_encrypted || '',
      region: r.region || '',
      hasSecret,
    };
  });

  // 数据库实例：口令字段密/明文
  out.databaseInstances = (d.prepare('SELECT id, name, type, container_ref, host, port, user, cred_encrypted FROM database_instances').all() as any[]).map((r) => {
    const hasCred = !!r.cred_encrypted && String(r.cred_encrypted).startsWith('v1:');
    let cred = '';
    if (hasCred) {
      try {
        cred = includeSecrets ? decryptSecret(r.cred_encrypted) : '';
      } catch {
        cred = '';
      }
    }
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      containerRef: r.container_ref || '',
      host: r.host,
      port: r.port,
      user: r.user || '',
      password: hasCred ? cred : r.cred_encrypted || '',
      hasPassword: hasCred,
    };
  });

  return {
    version: FORMAT_VERSION,
    exportedAt: Date.now(),
    includeSecrets,
    data: out,
  };
}

/**
 * GET /api/system/config/export
 * 导出面板配置 JSON（管理员）。query: includeSecrets=1|0（默认 0，仅导出脱敏占位）
 */
router.get(
  '/config/export',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const includeSecrets = req.query.includeSecrets === '1' || req.query.includeSecrets === 'true';
    logOperation(res.locals.username, '导出面板配置', '系统', '', includeSecrets ? '含敏感字段' : '脱敏');
    res.json(buildExport(includeSecrets));
  }),
);

// ==================== 导入 ====================

/**
 * 判断对象是否缺失（null/undefined）
 */
function missing(v: unknown): boolean {
  return v === undefined || v === null;
}

/**
 * 执行导入
 * @param payload 导出 JSON 的 data 部分
 * @param conflict skip | overwrite | error
 */
function performImport(payload: Record<string, any>, conflict: 'skip' | 'overwrite' | 'error'): { imported: Record<string, number> } {
  const d = getDb();
  const imported: Record<string, number> = {};
  // 是否导入/标记了当前引擎（决定是否需要重置 Docker 缓存与事件监听）
  let currentFlagged = false;
  // 冲突处理辅助：计数
  const count = (k: string, n: number) => {
    imported[k] = (imported[k] || 0) + n;
  };
  const exists = (sql: string, params: any[]): boolean => {
    return !!d.prepare(sql).get(...params);
  };

  // 使用事务保证要么全部生效、要么回滚。
  // BEGIN IMMEDIATE：进事务即取写锁。WAL 模式下普通 BEGIN（DEFERRED）在
  // 写入时才升级写锁，若其它连接在快照后已提交写入会得到不可重试的
  // BUSY_SNAPSHOT 错误；IMMEDIATE 让锁等待走 busy_timeout，避免偶发失败。
  d.exec('BEGIN IMMEDIATE');
  try {
    // 1. 用户（安全默认：始终 skip，避免把当前机账号改乱 / 误锁）
    if (Array.isArray(payload.users)) {
      const ins = d.prepare('INSERT OR IGNORE INTO users (username, salt, password_hash, role, created_at, must_change_password) VALUES (?, ?, ?, ?, ?, ?)');
      for (const u of payload.users) {
        if (!u || !u.username || !u.salt || !u.passwordHash) continue;
        if (exists('SELECT username FROM users WHERE username = ?', [u.username])) {
          if (conflict === 'skip') { count('users', 0); continue; }
          if (conflict === 'error') throw new Error(`用户已存在: ${u.username}`);
          count('users', 0);
          continue; // users 从不过 overwrite，安全起见
        }
        ins.run(u.username, u.salt, u.passwordHash, u.role || 'user', Number(u.createdAt) || Date.now(), u.mustChangePassword ? 1 : 0);
        count('users', 1);
      }
    }

    // 2. 镜像源（自定义源，host 唯一）
    if (Array.isArray(payload.hubSources)) {
      const ins = d.prepare('INSERT OR IGNORE INTO hub_sources (id, host, name, builtin, enabled, is_default, sort_order) VALUES (?, ?, ?, 0, ?, ?, ?)');
      for (const s of payload.hubSources) {
        if (!s || !s.host) continue;
        if (exists('SELECT id FROM hub_sources WHERE host = ?', [s.host])) {
          if (conflict === 'skip') { count('hubSources', 0); continue; }
          if (conflict === 'error') throw new Error(`镜像源已存在: ${s.host}`);
          d.prepare('UPDATE hub_sources SET name = ?, enabled = ?, is_default = ?, sort_order = ? WHERE host = ?').run(
            s.name || '', s.enabled ? 1 : 0, s.isDefault ? 1 : 0, Number(s.sortOrder) || 0, s.host,
          );
          count('hubSources', 1);
          continue;
        }
        ins.run(s.id || `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, s.host, s.name || '', s.enabled ? 1 : 0, s.isDefault ? 1 : 0, Number(s.sortOrder) || 0);
        count('hubSources', 1);
      }
    }

    // 3. 设置键值
    if (Array.isArray(payload.settings)) {
      for (const kv of payload.settings) {
        if (!kv || !kv.key) continue;
        try {
          d.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(kv.key, kv.value == null ? '' : String(kv.value));
          count('settings', 1);
        } catch {
          // 迁移缺失列等异常忽略
        }
      }
    }

    // 4. 引擎
    if (Array.isArray(payload.engines)) {
      for (const e of payload.engines) {
        if (!e || !e.id || !e.name || !e.endpoint) continue;
        const row = d.prepare('SELECT id FROM docker_engines WHERE id = ?').get(e.id) as any;
        if (row) {
          if (conflict === 'skip') { count('engines', 0); continue; }
          if (conflict === 'error') throw new Error(`引擎已存在: ${e.name}`);
          d.prepare('UPDATE docker_engines SET name = ?, endpoint = ?, is_current = ? WHERE id = ?').run(e.name, e.endpoint, e.isCurrent ? 1 : 0, e.id);
          count('engines', 1);
        } else {
          const now = Date.now();
          d.prepare('INSERT INTO docker_engines (id, name, endpoint, is_current, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(e.id, e.name, e.endpoint, e.isCurrent ? 1 : 0, now, now);
          count('engines', 1);
        }
        if (e.isCurrent) currentFlagged = true;
      }
    }

    // 5. Compose 模板（name 唯一）
    if (Array.isArray(payload.composeTemplates)) {
      for (const t of payload.composeTemplates) {
        if (!t || !t.name) continue;
        if (exists('SELECT id FROM compose_templates WHERE name = ?', [t.name])) {
          if (conflict === 'skip') { count('composeTemplates', 0); continue; }
          if (conflict === 'error') throw new Error(`Compose 模板已存在: ${t.name}`);
          d.prepare('UPDATE compose_templates SET description = ?, content = ?, updated_at = ? WHERE name = ?').run(t.description || '', t.content || '', Date.now(), t.name);
          count('composeTemplates', 1);
          continue;
        }
        const now = Date.now();
        d.prepare('INSERT INTO compose_templates (id, name, description, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          t.id || `ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, t.name, t.description || '', t.content || '', now, now,
        );
        count('composeTemplates', 1);
      }
    }

    // 6. 容器模板（name 唯一）
    if (Array.isArray(payload.containerTemplates)) {
      for (const t of payload.containerTemplates) {
        if (!t || !t.name) continue;
        if (exists('SELECT id FROM container_templates WHERE name = ?', [t.name])) {
          if (conflict === 'skip') { count('containerTemplates', 0); continue; }
          if (conflict === 'error') throw new Error(`容器模板已存在: ${t.name}`);
          d.prepare('UPDATE container_templates SET description = ?, image = ?, config = ?, updated_at = ? WHERE name = ?').run(t.description || '', t.image || '', t.config || '{}', Date.now(), t.name);
          count('containerTemplates', 1);
          continue;
        }
        const now = Date.now();
        d.prepare('INSERT INTO container_templates (id, name, description, image, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          t.id || `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, t.name, t.description || '', t.image || '', t.config || '{}', now, now,
        );
        count('containerTemplates', 1);
      }
    }

    // 7. 计划任务：重算 next_run_at，清空运行历史
    if (Array.isArray(payload.cronTasks)) {
      for (const t of payload.cronTasks) {
        if (!t || !t.name || !t.type) continue;
        const now = Date.now();
        const nextRun = nextRunTime(String(t.cron || ''), now) ?? (now + 3600000);
        if (exists('SELECT id FROM cron_tasks WHERE id = ?', [t.id])) {
          if (conflict === 'skip') { count('cronTasks', 0); continue; }
          if (conflict === 'error') throw new Error(`计划任务已存在: ${t.name}`);
          d.prepare('UPDATE cron_tasks SET name = ?, type = ?, cron = ?, enabled = ?, config = ?, next_run_at = ?, last_run_at = NULL, last_status = NULL, last_detail = NULL, updated_at = ? WHERE id = ?').run(
            t.name, t.type, t.cron || '', t.enabled ? 1 : 0, t.config || '{}', nextRun, now, t.id,
          );
          count('cronTasks', 1);
          continue;
        }
        d.prepare('INSERT INTO cron_tasks (id, name, type, cron, enabled, config, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          t.id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, t.name, t.type, t.cron || '', t.enabled ? 1 : 0, t.config || '{}', nextRun, now, now,
        );
        count('cronTasks', 1);
      }
    }

    // 8. 反代站点（domain 唯一；auth_password 为 {SHA} 哈希直接复用）
    if (Array.isArray(payload.sites)) {
      for (const s of payload.sites) {
        if (!s || !s.domain || missing(s.upstreamHost) || missing(s.upstreamPort)) continue;
        const upstreamPort = Number(s.upstreamPort);
        const listenPort = Number(s.listenPort) || (s.enableHttps ? 443 : 80);
        if (exists('SELECT id FROM sites WHERE domain = ?', [s.domain])) {
          if (conflict === 'skip') { count('sites', 0); continue; }
          if (conflict === 'error') throw new Error(`站点已存在: ${s.domain}`);
          d.prepare(
            'UPDATE sites SET upstream_host=?, upstream_port=?, listen_port=?, enable_https=?, cert_path=?, enabled=?, enable_ws=?, enable_gzip=?, enable_auth=?, auth_username=?, auth_password=?, rate_limit=?, client_max_body=?, proxy_timeout=?, extra_config=?, updated_at=? WHERE domain=?',
          ).run(
            s.upstreamHost, upstreamPort, listenPort, s.enableHttps ? 1 : 0, s.certPath || null, s.enabled === false ? 0 : 1,
            s.enableWs ? 1 : 0, s.enableGzip ? 1 : 0, s.enableAuth ? 1 : 0, s.authUsername || null, s.authPassword || null,
            s.rateLimit || null, s.clientMaxBody || '1m', Number(s.proxyTimeout) || 60, s.extraConfig || null, Date.now(), s.domain,
          );
          count('sites', 1);
          continue;
        }
        const now = Date.now();
        d.prepare(
          'INSERT INTO sites (id, domain, upstream_host, upstream_port, listen_port, enable_https, cert_path, enabled, enable_ws, enable_gzip, enable_auth, auth_username, auth_password, rate_limit, client_max_body, proxy_timeout, extra_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          s.id || `site-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, s.domain, s.upstreamHost, upstreamPort, listenPort,
          s.enableHttps ? 1 : 0, s.certPath || null, s.enabled === false ? 0 : 1, s.enableWs ? 1 : 0, s.enableGzip ? 1 : 0,
          s.enableAuth ? 1 : 0, s.authUsername || null, s.authPassword || null, s.rateLimit || null, s.clientMaxBody || '1m',
          Number(s.proxyTimeout) || 60, s.extraConfig || null, now, now,
        );
        count('sites', 1);
      }
    }

    // 9. 宿主告警规则（type 唯一）
    if (Array.isArray(payload.alertRules)) {
      for (const r of payload.alertRules) {
        if (!r || !r.type) continue;
        if (exists('SELECT type FROM alert_rules WHERE type = ?', [r.type])) {
          if (conflict === 'skip') { count('alertRules', 0); continue; }
          if (conflict === 'error') throw new Error(`告警规则已存在: ${r.type}`);
          d.prepare('UPDATE alert_rules SET enabled=?, warn_threshold=?, danger_threshold=?, silent_start=?, silent_end=?, workdays_only=?, work_start=?, work_end=?, updated_at=? WHERE type=?').run(
            r.enabled ? 1 : 0, Number(r.warnThreshold) || 0, Number(r.dangerThreshold) || 0, r.silentStart || null, r.silentEnd || null,
            r.workdaysOnly ? 1 : 0, r.workStart || null, r.workEnd || null, Date.now(), r.type,
          );
          count('alertRules', 1);
          continue;
        }
        d.prepare('INSERT INTO alert_rules (type, enabled, warn_threshold, danger_threshold, silent_start, silent_end, workdays_only, work_start, work_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          r.type, r.enabled ? 1 : 0, Number(r.warnThreshold) || 0, Number(r.dangerThreshold) || 0, r.silentStart || null, r.silentEnd || null,
          r.workdaysOnly ? 1 : 0, r.workStart || null, r.workEnd || null, Date.now(),
        );
        count('alertRules', 1);
      }
    }

    // 10. 容器级告警规则（(container_id, watch_type) 唯一，id 自增）
    if (Array.isArray(payload.containerAlertRules)) {
      for (const r of payload.containerAlertRules) {
        if (!r || !r.containerId || !r.watchType) continue;
        const now = Date.now();
        // 先尝试清掉同名旧规则（若 overwrite）；再插入
        if (conflict === 'overwrite') {
          d.prepare('DELETE FROM container_alert_rules WHERE container_id = ? AND watch_type = ?').run(r.containerId, r.watchType);
        }
        const dup = exists('SELECT id FROM container_alert_rules WHERE container_id = ? AND watch_type = ?', [r.containerId, r.watchType]);
        if (conflict === 'error' && dup) throw new Error(`容器告警规则已存在: ${r.containerId}/${r.watchType}`);
        if (dup && conflict === 'skip') { count('containerAlertRules', 0); continue; }
        d.prepare('INSERT INTO container_alert_rules (container_id, watch_type, enabled, port, silent_start, silent_end, workdays_only, work_start, work_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          r.containerId, r.watchType, r.enabled ? 1 : 0, r.port || null, r.silentStart || null, r.silentEnd || null,
          r.workdaysOnly ? 1 : 0, r.workStart || null, r.workEnd || null, now, now,
        );
        count('containerAlertRules', 1);
      }
    }

    // 11. 通知渠道（config 敏感字段：明文 → 重新加密落库）
    if (Array.isArray(payload.notifyChannels)) {
      for (const c of payload.notifyChannels) {
        if (!c || !c.name || !c.type) continue;
        const rawCfg = c.config && typeof c.config === 'object' ? { ...c.config } : {};
        const secretFields = CHANNEL_SECRET_FIELDS[c.type] || [];
        for (const k of secretFields) {
          const v = rawCfg[k];
          if (v !== undefined && v !== null && String(v) !== '') {
            rawCfg[k] = encryptChannelSecret(v);
          }
        }
        const cfgJson = JSON.stringify(rawCfg);
        if (exists('SELECT id FROM notify_channels WHERE id = ?', [c.id])) {
          if (conflict === 'skip') { count('notifyChannels', 0); continue; }
          if (conflict === 'error') throw new Error(`通知渠道已存在: ${c.name}`);
          d.prepare('UPDATE notify_channels SET name=?, type=?, enabled=?, config=?, updated_at=? WHERE id=?').run(c.name, c.type, c.enabled ? 1 : 0, cfgJson, Date.now(), c.id);
          count('notifyChannels', 1);
          continue;
        }
        const now = Date.now();
        d.prepare('INSERT INTO notify_channels (id, name, type, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          c.id || `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, c.name, c.type, c.enabled ? 1 : 0, cfgJson, now, now,
        );
        count('notifyChannels', 1);
      }
    }

    // 12. 云端备份目标（secret 明文 → 重新加密）
    if (Array.isArray(payload.cloudTargets)) {
      for (const t of payload.cloudTargets) {
        if (!t || !t.name || !t.type) continue;
        const now = Date.now();
        let secretEnc = t.secret ? encryptSecret(String(t.secret)) : null;
        if (!t.secret) secretEnc = null;
        if (exists('SELECT id FROM cloud_targets WHERE id = ?', [t.id])) {
          if (conflict === 'skip') { count('cloudTargets', 0); continue; }
          if (conflict === 'error') throw new Error(`云端备份目标已存在: ${t.name}`);
          d.prepare('UPDATE cloud_targets SET name=?, type=?, endpoint=?, bucket=?, path=?, access_key=?, secret_encrypted=?, region=?, updated_at=? WHERE id=?').run(
            t.name, t.type, t.endpoint || '', t.bucket || '', t.path || '', t.accessKey || '', secretEnc, t.region || '', now, t.id,
          );
          count('cloudTargets', 1);
          continue;
        }
        d.prepare('INSERT INTO cloud_targets (id, name, type, endpoint, bucket, path, access_key, secret_encrypted, region, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          t.id || `cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, t.name, t.type, t.endpoint || '', t.bucket || '', t.path || '', t.accessKey || '', secretEnc, t.region || '', now, now,
        );
        count('cloudTargets', 1);
      }
    }

    // 13. 数据库实例（口令明文 → 重新加密）
    if (Array.isArray(payload.databaseInstances)) {
      for (const t of payload.databaseInstances) {
        if (!t || !t.name || !t.type) continue;
        const now = Date.now();
        const credEnc = t.password ? encryptSecret(String(t.password)) : null;
        d.prepare('INSERT INTO database_instances (name, type, container_ref, host, port, user, cred_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          t.name, t.type, t.containerRef || null, t.host || 'localhost', Number(t.port) || 0, t.user || null, credEnc, now, now,
        );
        count('databaseInstances', 1);
      }
    }

    d.exec('COMMIT');
  } catch (err: any) {
    d.exec('ROLLBACK');
    throw err;
  }

  // 后处理（提交后执行，避免事务内做网络/子系统操作）
  if (currentFlagged || (payload.engines && payload.engines.length)) {
    try { resetDockerCache(); } catch { /* 忽略 */ }
    try { restartEventMonitor(); } catch { /* 忽略 */ }
  }
  if (Array.isArray(payload.sites) && payload.sites.length) {
    try { syncReverseProxy(); } catch { /* 同步失败由调用方汇总 */ }
  }

  return { imported };
}

/**
 * POST /api/system/config/import
 * 导入面板配置 JSON（管理员）。
 * body: { config: <buildExport 的完整返回> , conflict: 'skip'|'overwrite'|'error' }
 * 兼容直接传 config.data 子对象。
 */
router.post(
  '/config/import',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const conflict = ['skip', 'overwrite', 'error'].includes(String(body.conflict))
      ? (String(body.conflict) as 'skip' | 'overwrite' | 'error')
      : 'overwrite';
    // config 为完整导出对象时取 data；否则直接视为 data
    const raw = body.config || {};
    const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: '无效的配置内容' });
    }

    const result = performImport(data, conflict);
    logOperation(res.locals.username, '导入面板配置', '系统', '', `冲突策略: ${conflict}`);
    res.json({ ok: true, conflict, imported: result.imported, note: '已完成后处理（反代/引擎/计划任务）' });
  }),
);

export default router;
