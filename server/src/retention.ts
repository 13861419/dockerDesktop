/**
 * 数据保留自动清理（retention）
 *
 * 各业务表按"保留天数"惰性清理：由读取路径（列表/统计接口）触发，
 * 每日最多真正执行一次 DELETE，避免频繁扫表。
 * 上次清理时间存于 setting 表的隐藏键（不进设置注册中心，不暴露到设置接口）。
 */
import { getDb } from './storage';
import { getSetting } from './settings';

/** 节流窗口：24 小时 */
const PURGE_THROTTLE_MS = 86400_000;

function getLastPurgeAt(key: string): number {
  try {
    const row = getDb()
      .prepare('SELECT value FROM setting WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return Number(row?.value) || 0;
  } catch {
    return 0;
  }
}

function setLastPurgeAt(key: string, value: number): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

/**
 * 按保留天数清理表内 created_at（毫秒时间戳）过期的行
 * @param retentionDaysSetting 保留天数的设置键；值 <= 0 表示永久保留
 * @param throttleKey 节流时间戳在 setting 表中的键
 * @param table 表名（调用方传入字面量，仅用于白名单场景）
 */
export function purgeExpiredTable(retentionDaysSetting: string, throttleKey: string, table: string): void {
  const days = Number(getSetting<number>(retentionDaysSetting));
  if (!Number.isFinite(days) || days <= 0) return;

  const last = getLastPurgeAt(throttleKey);
  if (Date.now() - last < PURGE_THROTTLE_MS) return;

  try {
    getDb()
      .prepare(`DELETE FROM ${table} WHERE created_at < ?`)
      .run(Date.now() - days * 86400_000);
    setLastPurgeAt(throttleKey, Date.now());
  } catch {
    // 清理失败静默，不影响正常读取
  }
}

/**
 * 数据库空间维护（1.45.0）：
 *  - 每次调用先做 wal_checkpoint(TRUNCATE)（开销小，回收 WAL 文件）；
 *  - 每周最多一次惰性 VACUUM（回收删除后的空闲页，设置表记录上次时间）。
 * 由管理员页面打开路径（如任务列表）惰性触发。
 */
export function runDbMaintenance(): void {
  try {
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // checkpoint 失败不影响主流程
  }
  const last = getLastPurgeAt('db.lastVacuumAt');
  if (Date.now() - last < 7 * 86400_000) return;
  try {
    getDb().exec('VACUUM');
    setLastPurgeAt('db.lastVacuumAt', Date.now());
  } catch {
    // VACUUM 失败静默，下周再试
  }
}

/**
 * 按保留天数清理计划任务执行历史（cron_task_logs，时间列为 run_at）
 * 设置键 tasks.logRetentionDays（默认 90 天，<= 0 表示永久保留）
 */
export function purgeExpiredTaskLogs(): void {
  const days = Number(getSetting<number>('tasks.logRetentionDays'));
  if (!Number.isFinite(days) || days <= 0) return;

  const last = getLastPurgeAt('tasks.log.lastPurgeAt');
  if (Date.now() - last < PURGE_THROTTLE_MS) return;

  try {
    getDb()
      .prepare('DELETE FROM cron_task_logs WHERE run_at < ?')
      .run(Date.now() - days * 86400_000);
    setLastPurgeAt('tasks.log.lastPurgeAt', Date.now());
  } catch {
    // 清理失败静默，不影响正常读取
  }
}
