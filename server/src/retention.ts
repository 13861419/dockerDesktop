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
