/**
 * 操作审计日志模块（SQLite 持久化）
 *
 * 记录用户手动执行的关键操作（启停容器、删除镜像、创建/删除卷和网络、Compose/应用等），
 * 存储在 SQLite 的 operation_logs 表（<项目根>/data/docker-manager.db），可追溯、刷新不丢。
 *
 * 与实时"事件中心"不同：这里只记录**用户主动发起**的操作（含操作人、操作对象、结果），
 * 用于审计与排障，而非 Docker 引擎自动派发的运行事件。
 */
import { getDb } from './storage';
import { purgeExpiredTable } from './retention';

export interface OperationLogRecord {
  id: number;
  username: string;
  action: string;
  targetType: string;
  targetName: string | null;
  detail: string | null;
  success: boolean;
  createdAt: number;
}

interface LogRow {
  id: number;
  username: string;
  action: string;
  target_type: string;
  target_name: string | null;
  detail: string | null;
  success: number;
  created_at: number;
}

/** 分页查询参数 */
export interface LogQuery {
  page?: number;
  pageSize?: number;
  username?: string;
  targetType?: string;
  /** 起始时间戳（毫秒），含边界 */
  startTime?: number;
  /** 结束时间戳（毫秒），含边界 */
  endTime?: number;
  /** 结果过滤：仅查询成功(true)或失败(false)记录；不传则全部 */
  success?: boolean;
}

/**
 * 仅含过滤条件（不含分页字段）的查询参数
 * 供列表 / 统计 / 导出共用，保证过滤语义一致
 */
export type LogFilter = Pick<
  LogQuery,
  'username' | 'targetType' | 'startTime' | 'endTime' | 'success'
>;

/** 统计结果 */
export interface LogStats {
  /** 按目标类型分组 */
  byType: Array<{ target_type: string; count: number }>;
  /** 按结果分组（success: 1 成功 / 0 失败） */
  bySuccess: Array<{ success: number; count: number }>;
  /** 按操作动作分组（TOP 10，按 count 降序） */
  byAction: Array<{ action: string; count: number }>;
  /** 匹配过滤条件的总条数 */
  total: number;
}

/**
 * 根据过滤条件拼装 WHERE 子句与对应参数
 * @param query 过滤条件
 * @returns { where, params } 其中 where 为 'WHERE ...' 或空串，params 为按序绑定参数
 */
function buildWhere(query: LogFilter = {}): { where: string; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.username) {
    where.push('username = ?');
    params.push(query.username);
  }
  if (query.targetType) {
    where.push('target_type = ?');
    params.push(query.targetType);
  }
  if (query.startTime !== undefined) {
    where.push('created_at >= ?');
    params.push(query.startTime);
  }
  if (query.endTime !== undefined) {
    where.push('created_at <= ?');
    params.push(query.endTime);
  }
  if (query.success !== undefined) {
    where.push('success = ?');
    params.push(query.success ? 1 : 0);
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

/** 分页查询结果 */
export interface LogPageResult {
  items: OperationLogRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** 日志中出现的去重操作人列表（用于前端筛选下拉） */
  operators: string[];
}

/**
 * 记录一条操作日志
 * @param username 操作人（当前登录用户）
 * @param action 操作动作（中文语义，如"启动容器""删除镜像"；失败可追加"（失败）"）
 * @param targetType 目标类型（container/image/volume/network/compose/app）
 * @param targetName 目标名称（如容器名/镜像名），可空
 * @param detail 附加说明（如错误信息），可空
 * @param success 是否成功
 */
export function logOperation(
  username: string,
  action: string,
  targetType: string,
  targetName?: string | null,
  detail?: string | null,
  success = true,
): void {
  const d = getDb();
  d.prepare(
    'INSERT INTO operation_logs (username, action, target_type, target_name, detail, success, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    username || 'system',
    action,
    targetType,
    targetName ?? null,
    detail ?? null,
    success ? 1 : 0,
    Date.now(),
  );
}

/**
 * 分页查询操作日志，按时间倒序（最新在前）
 * @param query 查询条件
 */
export function listOperationLogs(query: LogQuery = {}): LogPageResult {
  purgeExpiredTable('logs.retentionDays', 'logs.lastPurgeAt', 'operation_logs');
  const d = getDb();
  const page = Math.max(1, query.page || 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize || 20));

  const { where: whereSql, params } = buildWhere(query);

  const total = (d.prepare(`SELECT count(*) AS c FROM operation_logs ${whereSql}`).get(...params) as { c: number }).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;

  const rows = d
    .prepare(
      `SELECT id, username, action, target_type, target_name, detail, success, created_at
       FROM operation_logs ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as unknown as LogRow[];

  // 供前端筛选下拉的去重操作人列表（与本次过滤条件无关，取库内全部出现过的操作人）
  const operatorRows = d
    .prepare('SELECT DISTINCT username FROM operation_logs WHERE username IS NOT NULL AND username != \'\'')
    .all() as unknown as Array<{ username: string }>;

  return {
    items: rows.map((r) => ({
      id: r.id,
      username: r.username,
      action: r.action,
      targetType: r.target_type,
      targetName: r.target_name,
      detail: r.detail,
      success: r.success === 1,
      createdAt: r.created_at,
    })),
    total,
    page,
    pageSize,
    totalPages,
    operators: operatorRows.map((r) => r.username),
  };
}

/**
 * 清空全部操作日志
 */
export function clearOperationLogs(): void {
  getDb().exec('DELETE FROM operation_logs');
}

/**
 * 按过滤条件导出全部操作日志为 CSV 字符串（不受分页限制，用于"导出"功能）
 * @param query 过滤条件（忽略 page/pageSize）
 * @returns CSV 文本，含表头（UTF-8 BOM，便于 Excel 正确识别中文）
 */
export function exportOperationLogsCsv(query: LogQuery = {}): string {
  const d = getDb();
  const { where: whereSql, params } = buildWhere(query);
  const rows = d
    .prepare(
      `SELECT username, action, target_type, target_name, detail, success, created_at
       FROM operation_logs ${whereSql}
       ORDER BY id DESC`,
    )
    .all(...params) as unknown as LogRow[];

  /** 转义 CSV 字段：含逗号/引号/换行时用双引号包裹并转义内部引号 */
  const esc = (v: string | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const fmt = (ts: number): string => {
    const dt = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
  };

  // 表头 + 数据行（属性顺序与表头一致）
  const header = ['操作时间', '操作人', '操作', '类型', '目标', '详情', '结果'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        esc(fmt(r.created_at)),
        esc(r.username),
        esc(r.action),
        esc(r.target_type),
        esc(r.target_name),
        esc(r.detail),
        r.success === 1 ? '成功' : '失败',
      ].join(','),
    );
  }
  // 前置 UTF-8 BOM，保证中文在 Excel 中不乱码
  return '\ufeff' + lines.join('\r\n');
}

/**
 * 按过滤条件统计操作日志（用于前端统计卡片展示）
 * @param query 过滤条件（忽略 page/pageSize）
 * @returns 按目标类型 / 结果 / 操作动作的分组统计及匹配总条数
 */
export function summarizeOperationLogs(query: LogQuery = {}): LogStats {
  const d = getDb();
  const { where: whereSql, params } = buildWhere(query);

  // 按目标类型分组（有记录的类型，按条数降序）
  const byType = d
    .prepare(
      `SELECT target_type, count(*) AS count FROM operation_logs ${whereSql}
       GROUP BY target_type ORDER BY count DESC`,
    )
    .all(...params) as unknown as Array<{ target_type: string; count: number }>;

  // 按结果分组（success: 1 成功 / 0 失败）
  const bySuccess = d
    .prepare(
      `SELECT success, count(*) AS count FROM operation_logs ${whereSql}
       GROUP BY success`,
    )
    .all(...params) as unknown as Array<{ success: number; count: number }>;

  // 按操作动作分组，仅取 TOP 10（按条数降序）
  const byAction = d
    .prepare(
      `SELECT action, count(*) AS count FROM operation_logs ${whereSql}
       GROUP BY action ORDER BY count DESC LIMIT 10`,
    )
    .all(...params) as unknown as Array<{ action: string; count: number }>;

  // 匹配过滤条件的总条数
  const total = (d.prepare(`SELECT count(*) AS c FROM operation_logs ${whereSql}`).get(...params) as { c: number }).c;

  return { byType, bySuccess, byAction, total };
}

/**
 * 按过滤条件导出全部操作日志为 JSON 数组字符串（不受分页限制，用于"导出 JSON"功能）
 * @param query 过滤条件（忽略 page/pageSize）
 * @returns JSON 数组文本（含 id/username/action/targetType/targetName/detail/success/createdAt）
 */
export function exportOperationLogsJson(query: LogQuery = {}): string {
  const d = getDb();
  const { where: whereSql, params } = buildWhere(query);
  const rows = d
    .prepare(
      `SELECT username, action, target_type, target_name, detail, success, created_at
       FROM operation_logs ${whereSql}
       ORDER BY id DESC`,
    )
    .all(...params) as unknown as LogRow[];

  // 属性名映射为驼峰式导出结构，createdAt 保留毫秒时间戳
  const data = rows.map((r) => ({
    id: r.id,
    username: r.username,
    action: r.action,
    targetType: r.target_type,
    targetName: r.target_name,
    detail: r.detail,
    success: r.success === 1,
    createdAt: r.created_at,
  }));
  return JSON.stringify(data, null, 2);
}

/**
 * 按操作者对操作日志分组统计（用于审计报表的"操作者排行"）
 * @param query 过滤条件（忽略 page/pageSize）
 * @returns 按操作者分组的统计数组（含总数/成功/失败，按总数降序）
 */
export function summarizeOperationLogsByUser(query: LogQuery = {}): Array<{
  username: string;
  count: number;
  success: number;
  fail: number;
}> {
  const d = getDb();
  const { where: whereSql, params } = buildWhere(query);
  const rows = d
    .prepare(
      `SELECT username,
              count(*) AS count,
              sum(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
              sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS fail
       FROM operation_logs ${whereSql}
       GROUP BY username
       ORDER BY count DESC`
    )
    .all(...params) as unknown as Array<{ username: string; count: number; success: number | null; fail: number | null }>;
  return rows.map((r) => ({
    username: r.username,
    count: r.count,
    success: r.success || 0,
    fail: r.fail || 0,
  }));
}

/**
 * 按天对操作日志进行趋势聚合（用于审计报表的"按天趋势"）
 * @param query 过滤条件（忽略 page/pageSize）
 * @returns 按天（YYYY-MM-DD）分组的统计数组，按日期升序
 */
export function summarizeOperationLogsTrend(query: LogQuery = {}): Array<{
  day: string;
  count: number;
  success: number;
  fail: number;
}> {
  const d = getDb();
  const { where: whereSql, params } = buildWhere(query);
  const rows = d
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              count(*) AS count,
              sum(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
              sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS fail
       FROM operation_logs ${whereSql}
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(...params) as unknown as Array<{ day: string; count: number; success: number | null; fail: number | null }>;
  return rows.map((r) => ({
    day: r.day,
    count: r.count,
    success: r.success || 0,
    fail: r.fail || 0,
  }));
}

/**
 * 将审计统计聚合结果导出为 CSV 字符串（用于"导出报表"功能）
 * @param groupBy 维度：user（按操作者）或 day（按天）
 * @param query 过滤条件（忽略 page/pageSize）
 * @returns CSV 文本，含表头（UTF-8 BOM，便于 Excel 正确识别中文）
 */
export function exportStatsCsv(groupBy: 'user' | 'day', query: LogQuery = {}): string {
  // 转义 CSV 字段（与 exportOperationLogsCsv 同规则）
  const esc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const header = groupBy === 'user' ? ['操作人', '操作次数', '成功', '失败'] : ['日期', '操作次数', '成功', '失败'];
  const lines = [header.join(',')];
  if (groupBy === 'user') {
    const rows = summarizeOperationLogsByUser(query);
    for (const r of rows) {
      lines.push([esc(r.username), esc(r.count), esc(r.success), esc(r.fail)].join(','));
    }
  } else {
    const rows = summarizeOperationLogsTrend(query);
    for (const r of rows) {
      lines.push([esc(r.day), esc(r.count), esc(r.success), esc(r.fail)].join(','));
    }
  }
  return '\ufeff' + lines.join('\r\n');
}
