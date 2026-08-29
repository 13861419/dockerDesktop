/**
 * 统一 KV 配置中心
 *
 * 将散落的"环境变量默认值 + setting 表 KV + 模块默认值"收敛为统一的
 * 描述符注册中心。读取遵循三态回退：DB（已落库）> env（环境变量）> default（模块默认）。
 *
 * - 现有 setting 表结构不变，本模块仅在其上封装；
 * - secret 类型值经 encryptSecret 加密落库，读取不回显明文；
 * - 各模块按需迁移到 getSetting()，未迁移的保持原有环境变量行为，零回归。
 */
import { getDb, encryptSecret, decryptSecret } from './storage';

/** 设置描述符 */
export interface SettingDescriptor {
  /** �一键（如 auth.ttlHours） */
  key: string;
  /** 显示名 */
  label: string;
  /** 说明文字 */
  hint?: string;
  /** 值类型：number 数字 | string 字符串 | bool 布尔 | secret 敏感值（加密） */
  type: 'number' | 'string' | 'bool' | 'secret';
  /** 对应环境变量名（如 PORT），未落库时作为回退 */
  env?: string;
  /** 模块默认值（env 亦未设置时兜底） */
  def?: any;
  /** 分组（前端多 Tab 渲染） */
  group: 'general' | 'runtime' | 'security' | 'retention' | 'notification';
  /** 是否仅展示（如端口需要重启才能生效且不建议 UI 修改） */
  readonly?: boolean;
  /** 不出现在设置页通用列表（由专属界面读写的存储键） */
  hidden?: boolean;
}

/** 值来源 */
export type SettingSource = 'db' | 'env' | 'default';

/** 注册中心（key -> descriptor） */
const registry = new Map<string, SettingDescriptor>();

/**
 * 批量注册设置描述符（模块加载时调用；重复注册以后者为准）
 * @param descriptors 描述符数组
 */
export function registerSettings(descriptors: SettingDescriptor[]): void {
  for (const d of descriptors) {
    registry.set(d.key, d);
  }
}

/** 从环境变量读取并按类型归一化，env 未设置返回 undefined */
function fromEnv(d: SettingDescriptor): any | undefined {
  if (!d.env) return undefined;
  const raw = process.env[d.env];
  if (raw === undefined || raw === '') return undefined;
  return normalizeValue(d, raw);
}

/** 按描述符类型归一化值 */
function normalizeValue(d: SettingDescriptor, raw: any): any {
  if (d.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : d.def;
  }
  if (d.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    return raw === 'true' || raw === '1' || raw === 1;
  }
  return String(raw);
}

/**
 * 读取设置的原始信息（值 + 来源），三态回退：db > env > default
 * @param key 设置键
 * @returns 值与来源；未注册的键返回 null
 */
export function getSettingRaw(key: string): { value: any; source: SettingSource } | null {
  const d = registry.get(key);
  if (!d) return null;
  // db
  try {
    const row = getDb()
      .prepare('SELECT value FROM setting WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (row) {
      let stored = row.value;
      if (d.type === 'secret') stored = decryptSecret(stored) || '';
      return { value: normalizeValue(d, stored), source: 'db' };
    }
  } catch {
    // 表未就绪等异常时继续回退
  }
  // env
  const envVal = fromEnv(d);
  if (envVal !== undefined) return { value: envVal, source: 'env' };
  // default
  return { value: d.def, source: 'default' };
}

/**
 * 读取设置值（三态回退），未注册键返回 undefined
 * @param key 设置键
 */
export function getSetting<T = any>(key: string): T | undefined {
  const raw = getSettingRaw(key);
  return raw ? (raw.value as T) : undefined;
}

/**
 * 写入设置（落库；secret 类型经加密）
 * @param key 设置键（须已注册）
 * @param value 值
 * @throws 未注册的键抛错
 */
export function setSetting(key: string, value: any): void {
  const d = registry.get(key);
  if (!d) {
    throw Object.assign(new Error(`未知的设置键: ${key}`), { statusCode: 400 });
  }
  let stored: string;
  if (d.type === 'bool') {
    stored = (value === true || value === 'true' || value === '1' || value === 1) ? 'true' : 'false';
  } else {
    stored = String(value ?? '');
  }
  if (d.type === 'number' && !Number.isFinite(Number(stored))) {
    throw Object.assign(new Error(`${d.label} 必须是数字`), { statusCode: 400 });
  }
  if (d.type === 'secret') {
    stored = encryptSecret(String(value ?? ''));
  }
  getDb()
    .prepare(
      'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, stored);
}

/**
 * 恢复默认：清除某键的落库值（回退到 env/default）
 * @param key 设置键
 */
export function resetSetting(key: string): void {
  getDb().prepare('DELETE FROM setting WHERE key = ?').run(key);
}

/**
 * 校验待写入的设置值（不落库）
 * @param key 设置键
 * @param value 值
 * @returns 合法返回 null；非法返回错误消息
 */
export function validateSetting(key: string, value: any): string | null {
  const d = registry.get(key);
  if (!d) return `未知的设置键: ${key}`;
  if (d.readonly) return `${d.label} 为只读项，不可修改`;
  if (d.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${d.label} 必须是数字`;
    if (n < 0) return `${d.label} 不能为负数`;
  }
  if (d.type === 'secret' && value != null && String(value).length > 10000) {
    return `${d.label} 内容过长`;
  }
  return null;
}

/**
 * 列出全部已注册设置（含当前值与来源）
 *
 * secret 类型不回显明文：返回 { configured: boolean } 形态。
 * @returns 描述符 + 值/来源 的数组，按 group、key 排序
 */
export function listSettings(): Array<
  SettingDescriptor & { value: any; source: SettingSource; configured?: boolean }
> {
  const items: Array<SettingDescriptor & { value: any; source: SettingSource; configured?: boolean }> = [];
  for (const d of registry.values()) {
    if (d.hidden) continue; // 专属界面读写的存储键不在通用列表展示
    const raw = getSettingRaw(d.key);
    if (!raw) continue;
    if (d.type === 'secret') {
      items.push({ ...d, configured: String(raw.value || '').length > 0, value: undefined, source: raw.source });
    } else {
      items.push({ ...d, value: raw.value, source: raw.source });
    }
  }
  return items.sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
}

// ============ 首批注册的键 ============

registerSettings([
  {
    key: 'server.port',
    label: '服务端口',
    hint: '面板后端服务监听端口，修改后需重启服务生效',
    type: 'number',
    env: 'PORT',
    def: 9528,
    group: 'runtime',
    readonly: true,
  },
  {
    key: 'auth.ttlHours',
    label: '会话有效期（小时）',
    hint: '登录会话的过期时间，修改后对新登录生效',
    type: 'number',
    env: 'AUTH_TTL_HOURS',
    def: 24,
    group: 'security',
  },
  {
    key: 'logs.defaultTail',
    label: '容器日志默认行数',
    hint: '查看容器日志时默认加载的末尾行数',
    type: 'number',
    def: 200,
    group: 'retention',
  },
  {
    key: 'logs.retentionDays',
    label: '操作日志保留天数',
    hint: '超过该天数的操作日志自动清理；0 表示永久保留',
    type: 'number',
    def: 90,
    group: 'retention',
  },
  {
    key: 'ai.usage.retentionDays',
    label: 'AI 用量明细保留天数',
    hint: '超过该天数的 AI 调用用量明细自动清理；0 表示永久保留',
    type: 'number',
    def: 30,
    group: 'retention',
  },
  {
    key: 'ai.inspection.retentionDays',
    label: 'AI 巡检记录保留天数',
    hint: '超过该天数的 AI 巡检记录自动清理；0 表示永久保留',
    type: 'number',
    def: 30,
    group: 'retention',
  },
  {
    key: 'db.backup.retentionCount',
    label: '面板数据库备份保留份数',
    hint: '面板自身 SQLite 数据库备份（<数据目录>/db-backups/）超过该份数时自动清理最旧的；0 表示不自动清理',
    type: 'number',
    def: 7,
    group: 'retention',
  },
  {
    key: 'metrics.token',
    label: 'Prometheus 抓取 Token',
    hint: '配置后 /metrics 端点要求携带 ?token= 或 Authorization: Bearer；留空表示开放访问',
    type: 'secret',
    group: 'security',
  },
  {
    key: 'approvals.enabled',
    label: '高危操作审批流',
    hint: '开启后非管理员的删除容器/镜像/卷与网络清理操作需管理员审批后执行',
    type: 'bool',
    def: false,
    group: 'security',
  },
  {
    key: 'approvals.ttlHours',
    label: '审批超时时间（小时）',
    hint: '待审批超过该时长未处理将自动作废并留痕；0 表示不过期',
    type: 'number',
    def: 72,
    group: 'security',
  },
  {
    key: 'alerts.aiDiagnosis',
    label: '告警自动 AI 诊断',
    hint: 'danger 级别告警推送成功后，自动调用 AI 分析根因并把诊断作为后续消息推送到同一渠道',
    type: 'bool',
    def: true,
    group: 'notification',
  },
  {
    key: 'alerts.pushAggWindowSec',
    label: '告警推送聚合窗口（秒）',
    hint: '窗口内多条 warn/danger 推送合并为一条摘要防止消息风暴，0 = 关闭聚合逐条推送；恢复通知始终即时推送；聚合推送不触发 AI 诊断',
    type: 'number',
    def: 60,
    group: 'notification',
  },
  {
    key: 'alerts.channelMode',
    label: '告警推送路由策略',
    hint: 'first=仅首个启用渠道（兼容旧版）；all=全部启用渠道；byLevel=按级别路由（结合 alerts.route.* 路由表，在告警中心「推送路由」卡片配置）',
    type: 'string',
    def: 'first',
    group: 'notification',
    hidden: true,
  },
  {
    key: 'alerts.route.warn',
    label: 'warn 级别路由渠道',
    hint: 'byLevel 模式下 warn 告警推送的渠道 ID 列表（逗号分隔）',
    type: 'string',
    def: '',
    group: 'notification',
    hidden: true,
  },
  {
    key: 'alerts.route.danger',
    label: 'danger 级别路由渠道',
    hint: 'byLevel 模式下 danger 告警推送的渠道 ID 列表（逗号分隔）',
    type: 'string',
    def: '',
    group: 'notification',
    hidden: true,
  },
  {
    key: 'alerts.route.recovery',
    label: 'recovery 级别路由渠道',
    hint: 'byLevel 模式下恢复通知推送的渠道 ID 列表（逗号分隔）',
    type: 'string',
    def: '',
    group: 'notification',
    hidden: true,
  },
]);
