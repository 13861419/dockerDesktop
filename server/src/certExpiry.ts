/**
 * 站点证书到期检测（1.44.0）
 *
 * 每日一次扫描 sites 表中配置了证书路径的站点，用 Node 内置 X509Certificate
 * 解析有效期：剩余 ≤ 7 天 → danger；≤ 30 天 → warn，推送到已启用的通知渠道。
 * 同一站点同一级别 24 小时内不重复推送（内存去重，重启清零）。
 */
import crypto from 'crypto';
import fs from 'fs';
import { getDb } from './storage';
import { pushToTargets } from './alerting';

/** 到期告警去重：siteId -> { level, at } */
const lastPushAt = new Map<string, { level: 'warn' | 'danger'; at: number }>();

/**
 * 从 PEM 文本解析证书到期时间（纯函数，便于单测）
 * @returns 到期时间戳；解析失败返回 null
 */
export function parseCertExpiry(pem: string): number | null {
  try {
    const x509 = new crypto.X509Certificate(pem);
    const t = new Date(x509.validTo).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * 扫描全部站点证书并推送临期告警（内部 24 小时去重，由告警 check() 周期调用）
 */
export async function checkSiteCertExpiry(): Promise<void> {
  let rows: Array<{ id: string; domain: string; cert_path: string | null }> = [];
  try {
    rows = getDb()
      .prepare('SELECT id, domain, cert_path FROM sites WHERE cert_path IS NOT NULL AND cert_path != \'\'')
      .all() as unknown as Array<{ id: string; domain: string; cert_path: string | null }>;
  } catch {
    return;
  }
  const now = Date.now();
  for (const row of rows) {
    try {
      if (!row.cert_path || !fs.existsSync(row.cert_path)) continue;
      const pem = fs.readFileSync(row.cert_path, 'utf8');
      const expires = parseCertExpiry(pem);
      if (!expires) continue;
      const daysLeft = Math.floor((expires - now) / 86400_000);
      if (daysLeft > 30) continue; // 30 天内才提醒
      const level: 'warn' | 'danger' = daysLeft <= 7 ? 'danger' : 'warn';
      const prev = lastPushAt.get(row.id);
      if (prev && prev.level === level && now - prev.at < 86400_000) continue;
      lastPushAt.set(row.id, { level, at: now });
      await pushToTargets(
        level,
        `Docker 面板【证书到期】站点 ${row.domain} 的证书将在 **${daysLeft} 天后到期**（${new Date(expires).toISOString().slice(0, 10)}），请及时续期。`,
      );
    } catch {
      // 单个站点失败不影响其余
    }
  }
}
