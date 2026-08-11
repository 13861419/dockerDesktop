/**
 * 镜像拉取时间记录模块（SQLite 持久化）
 *
 * 记录每个镜像 ID 首次被本地拉取的 Unix 时间戳（秒），实现"拉取时间"展示。
 * 数据存储在 SQLite 的 image_pull_history 表（<项目根>/data/docker-manager.db）。
 * 注意：docker listImages 的 Created 字段是镜像构建时间，并非本地拉取时间，
 * 因此需要额外记录用户在本地拉取该镜像的时刻。
 */
import { getDb } from './storage';

/**
 * 记录某个镜像被本地拉取的时间（仅首次拉取时写入，保留最早时间）
 * @param imageId 镜像 ID（sha256 前缀形式）
 * @param ts 拉取时间戳（秒），缺省为当前时间
 */
export function recordPullTime(imageId: string, ts?: number): void {
  if (!imageId) return;
  const now = Math.floor((ts ?? Date.now()) / 1000);
  // 主键冲突时保留已有记录（镜像重建后 ID 会变，同一 ID 记录首次拉取时间最合理）
  getDb()
    .prepare('INSERT OR IGNORE INTO image_pull_history (image_id, pull_at) VALUES (?, ?)')
    .run(imageId, now);
}

/**
 * 读取单个镜像的拉取时间（秒），未记录时返回 undefined
 * @param imageId 镜像 ID
 */
export function getPullTime(imageId: string): number | undefined {
  const row = getDb().prepare('SELECT pull_at FROM image_pull_history WHERE image_id = ?').get(imageId) as
    | { pull_at: number }
    | undefined;
  return row ? row.pull_at : undefined;
}
