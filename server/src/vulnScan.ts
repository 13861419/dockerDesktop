/**
 * Trivy 定时漏洞扫描任务（1.2.0）
 *
 * - 任务类型 vulnScan：按 config.images 显式列表（CSV/数组）扫描，缺省取本地镜像前 N 个（默认 20）
 * - 扫描结果写入 vuln_scans 历史表（含每轮全部 CVE id 快照，上限 500 条）
 * - 与上一次同镜像记录按 CVE id 差集对比，新增 Critical / High 时推送告警到全部启用通知渠道
 * - Trivy 未安装时任务直接返回说明文本，不报错（与漏洞扫描页行为一致）
 */
import type { CronTaskRow, TaskRunResult } from './scheduler';
import { registerTaskHandler } from './scheduler';
import { scanImage, trivyAvailable } from './trivyCli';
import { getDockerClient } from './docker/client';
import { getDb } from './storage';
import { listChannels, sendAlert } from './notify';

/** 未显式指定镜像列表时的扫描上限 */
const DEFAULT_MAX_IMAGES = 20;

/** 写入历史表的 CVE id 快照上限（防超大镜像撑爆单行） */
const CVE_SNAPSHOT_LIMIT = 500;

/** 单条记录 new_cves 提示的上限 */
const NEW_CVES_LIMIT = 20;

/** 扫描历史记录（对外暴露） */
export interface VulnScanRecord {
  id: number;
  image: string;
  scannedAt: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
  /** 较上次新增的高危 CVE id */
  newCves: string[];
  summary: string;
}

/** 漏洞级别计数 */
interface VulnCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
}

/** 扫描到的单条漏洞（级别归一后） */
interface VulnEntry {
  id: string;
  severity: string;
}

/**
 * 列出本地镜像名（REPOSITORY:TAG），按名称去重排序
 */
async function listLocalImages(limit: number): Promise<string[]> {
  const docker = await getDockerClient();
  const images = await docker.listImages({});
  const names: string[] = [];
  for (const img of images) {
    for (const tag of img.RepoTags || []) {
      if (tag && !tag.includes('<none>')) names.push(tag);
    }
  }
  return [...new Set(names)].sort().slice(0, limit);
}

/**
 * 差集对比：返回 entries 中「上次不存在且级别为 Critical/High」的 CVE id（上限 NEW_CVES_LIMIT）
 *
 * @param prevCsv 上一次记录的 cve_ids CSV（首次扫描为空 = 视为全新，全部高危计入新增）
 * @param entries 本次扫描到的漏洞条目
 */
export function diffNewHigh(prevCsv: string, entries: VulnEntry[]): string[] {
  const prev = new Set(String(prevCsv || '').split(',').filter(Boolean));
  const out: string[] = [];
  for (const v of entries) {
    const sev = String(v.severity || '').toUpperCase();
    if (sev !== 'CRITICAL' && sev !== 'HIGH') continue;
    if (prev.has(v.id)) continue;
    if (!out.includes(v.id)) out.push(v.id);
    if (out.length >= NEW_CVES_LIMIT) break;
  }
  return out;
}

/**
 * 写入一条扫描记录并返回新增的高危 CVE id
 *
 * @param image 镜像名
 * @param counts 各级别数量
 * @param entries 本次扫描到的漏洞条目（id + severity）
 * @param summary 摘要文本
 * @returns 新增的高危 CVE id 数组
 */
export function saveScanResult(image: string, counts: VulnCounts, entries: VulnEntry[], summary: string): string[] {
  const db = getDb();
  const last = db
    .prepare('SELECT cve_ids FROM vuln_scans WHERE image = ? ORDER BY scanned_at DESC LIMIT 1')
    .get(image) as { cve_ids: string } | undefined;
  const newHigh = diffNewHigh(last?.cve_ids || '', entries);
  const cveIds = entries.map((e) => e.id).slice(0, CVE_SNAPSHOT_LIMIT);
  db.prepare(
    `INSERT INTO vuln_scans (image, scanned_at, critical, high, medium, low, unknown, total, new_cves, cve_ids, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    image,
    Date.now(),
    counts.critical,
    counts.high,
    counts.medium,
    counts.low,
    counts.unknown,
    counts.total,
    newHigh.join(','),
    cveIds.join(','),
    summary,
  );
  return newHigh;
}

/**
 * 执行一次定时漏洞扫描
 *
 * @param config.images 显式镜像列表（CSV 或数组）
 * @param config.maxImages 未指定 images 时的扫描上限（默认 20）
 * @param config.notify 是否推送新增高危告警（默认 true）
 * @returns 任务详情文本
 */
export async function runVulnScan(
  config: { images?: string | string[]; maxImages?: number; notify?: boolean } = {},
): Promise<string> {
  if (!(await trivyAvailable())) {
    return 'Trivy 未安装，跳过扫描（漏洞扫描依赖本机 Trivy 二进制）';
  }
  const rawImages = config.images;
  let images: string[];
  if (Array.isArray(rawImages) && rawImages.length > 0) {
    images = rawImages.map(String);
  } else if (typeof rawImages === 'string' && rawImages.trim()) {
    images = rawImages.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    images = await listLocalImages(Math.max(1, Number(config.maxImages) || DEFAULT_MAX_IMAGES));
  }
  if (images.length === 0) return '无可扫描的本地镜像';

  const db = getDb();
  const alerts: string[] = [];
  let scanned = 0;
  let failed = 0;
  for (const image of images) {
    let result;
    try {
      result = await scanImage(image);
    } catch (err) {
      failed += 1;
      db.prepare(
        `INSERT INTO vuln_scans (image, scanned_at, critical, high, medium, low, unknown, total, new_cves, cve_ids, summary)
         VALUES (?, ?, 0, 0, 0, 0, 0, 0, '', '', ?)`,
      ).run(image, Date.now(), `扫描失败: ${(err as Error)?.message || '未知错误'}`);
      continue;
    }
    scanned += 1;
    const vulns = result.vulnerabilities || [];
    const sum = result.summary;
    const counts: VulnCounts = {
      critical: sum?.critical ?? 0,
      high: sum?.high ?? 0,
      medium: sum?.medium ?? 0,
      low: sum?.low ?? 0,
      unknown: sum?.unknown ?? 0,
      total: vulns.length,
    };
    const entries: VulnEntry[] = vulns.map((v) => ({
      id: v.id,
      severity: String(v.severity || 'UNKNOWN').toUpperCase(),
    }));
    const summary = `critical ${counts.critical} / high ${counts.high} / medium ${counts.medium} / low ${counts.low}`;
    const newHigh = saveScanResult(image, counts, entries, summary);
    if (newHigh.length > 0) {
      alerts.push(
        `镜像 ${image} 新增 ${newHigh.length} 个高危漏洞（critical ${counts.critical} / high ${counts.high}）：${newHigh.slice(0, 5).join(', ')}`,
      );
    }
  }
  if (config.notify !== false && alerts.length > 0) {
    for (const ch of listChannels()) {
      if (!ch.enabled) continue;
      try {
        await sendAlert(ch.id, `【漏洞扫描告警】\n${alerts.join('\n')}`);
      } catch {
        // 单渠道失败不影响整体
      }
    }
  }
  const tail = alerts.length > 0 ? `，新增高危 ${alerts.length} 项并已推送告警` : '，未发现新增高危漏洞';
  const failTail = failed > 0 ? `（${failed} 个扫描失败）` : '';
  return `扫描 ${scanned}/${images.length} 个镜像${failTail}${tail}`;
}

/**
 * 查询扫描历史（image 缺省返回最近 50 条全量记录）
 */
export function listVulnHistory(image?: string, limit = 50): VulnScanRecord[] {
  try {
    const db = getDb();
    const rows = (
      image
        ? db
            .prepare(
              'SELECT id, image, scanned_at, critical, high, medium, low, unknown, total, new_cves, summary FROM vuln_scans WHERE image = ? ORDER BY scanned_at DESC LIMIT ?',
            )
            .all(image, limit)
        : db
            .prepare(
              'SELECT id, image, scanned_at, critical, high, medium, low, unknown, total, new_cves, summary FROM vuln_scans ORDER BY scanned_at DESC LIMIT ?',
            )
            .all(limit)
    ) as unknown as Array<Record<string, any>>;
    return rows.map((r) => ({
      id: r.id,
      image: r.image,
      scannedAt: r.scanned_at,
      critical: r.critical,
      high: r.high,
      medium: r.medium,
      low: r.low,
      unknown: r.unknown,
      total: r.total,
      newCves: String(r.new_cves || '').split(',').filter(Boolean),
      summary: r.summary,
    }));
  } catch {
    return [];
  }
}

/** 调度器 handler：漏洞定时扫描（config: { images?, maxImages?, notify? }） */
async function runVulnScanHandler(_task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const detail = await runVulnScan(config || {});
  return { ok: true, detail };
}

registerTaskHandler('vulnScan', runVulnScanHandler);
