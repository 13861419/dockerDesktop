/**
 * 应用商店 Compose 套件「保留数据升级」（1.72.0）
 *
 * 数据安全模型：Compose 应用的持久数据在 named volume / bind mount 中，
 * `up -d --force-recreate` 只重建容器不动卷，数据天然保留；
 * 升级真正的风险是「新版本起不来」。因此本模块提供：
 *  1. 升级前快照：记录各服务当前镜像 ID 与 compose 文件内容（落盘 data/appstore-snapshots）
 *  2. 健康检查窗口：重建后轮询 compose ps，确认全部服务处于 running
 *  3. 自动回滚：把旧镜像 ID 重新打回原 tag → 还原 compose 文件 → 再次重建
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** 单个服务的镜像引用（升级前快照用） */
export interface ComposeImageRef {
  service: string;
  repository: string;
  tag: string;
  id: string;
}

/** 应用升级快照 */
export interface AppUpgradeSnapshot {
  appId: string;
  createdAt: number;
  version: string;
  /** compose 文件名（不含路径） */
  composeFile: string;
  /** 升级前 compose 文件内容 */
  composeContent: string;
  /** 升级前各服务镜像 ID（按 service 去重） */
  images: ComposeImageRef[];
}

/** 快照目录（数据目录下，随用户数据持久化） */
function snapshotDir(): string {
  const base = process.env.DOCKERMANAGER_DATA || path.join(os.tmpdir(), 'docker-manager-data');
  return path.join(base, 'appstore-snapshots');
}

function snapshotFile(appId: string): string {
  return path.join(snapshotDir(), `${appId}.json`);
}

/** 保存升级前快照（每个应用保留最近一次） */
export function saveUpgradeSnapshot(snap: AppUpgradeSnapshot): void {
  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(snapshotFile(snap.appId), JSON.stringify(snap, null, 2), 'utf8');
}

/** 读取升级前快照（无快照返回 null） */
export function loadUpgradeSnapshot(appId: string): AppUpgradeSnapshot | null {
  try {
    return JSON.parse(fs.readFileSync(snapshotFile(appId), 'utf8')) as AppUpgradeSnapshot;
  } catch {
    return null;
  }
}

/** 升级成功后清除快照 */
export function clearUpgradeSnapshot(appId: string): void {
  try {
    fs.unlinkSync(snapshotFile(appId));
  } catch {
    // 无快照或已清除
  }
}

/**
 * 解析 docker compose images --format json 输出（兼容整段 JSON 与逐行 JSON 两种格式）
 */
export function parseComposeImages(text: string): ComposeImageRef[] {
  const out: ComposeImageRef[] = [];
  if (!text || !text.trim()) return out;
  const collect = (rows: any[]) => {
    for (const row of rows) {
      if (!row) continue;
      const service = String(row.Service || row.service || '');
      const repository = String(row.Repository || row.repository || '');
      const tag = String(row.Tag || row.tag || '');
      const id = String(row.ID || row.id || '');
      if (!service || (!repository && !id)) continue;
      out.push({ service, repository, tag, id });
    }
  };
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) collect(parsed);
    else collect([parsed]);
  } catch {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        collect([JSON.parse(t)]);
      } catch {
        // 忽略非 JSON 行
      }
    }
  }
  // 同一服务取第一条（去重）
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.service) ? false : (seen.add(r.service), true)));
}

/** 执行命令并返回 stdout（失败抛错带 stderr） */
async function run(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * 采集升级前快照：当前镜像 ID + compose 文件内容
 */
export async function captureSnapshot(
  appId: string,
  version: string,
  dir: string,
  composeFileName: string,
): Promise<AppUpgradeSnapshot> {
  const composeFile = path.join(dir, composeFileName);
  let images: ComposeImageRef[] = [];
  try {
    const out = await run(`docker compose -f "${composeFile}" images --format json`, dir);
    images = parseComposeImages(out);
  } catch {
    // compose images 失败不阻断升级（快照尽力而为）
  }
  let composeContent = '';
  try {
    composeContent = fs.readFileSync(composeFile, 'utf8');
  } catch {
    // 读不到则回滚时保留现文件
  }
  return { appId, createdAt: Date.now(), version, composeFile: composeFileName, composeContent, images };
}

/**
 * 检查 compose 项目健康状态：全部服务 running 视为健康
 * @returns { healthy, detail } detail 为首个异常服务描述
 */
export async function checkComposeHealth(
  dir: string,
  composeFileName: string,
): Promise<{ healthy: boolean; detail: string }> {
  const composeFile = path.join(dir, composeFileName);
  let text = '';
  try {
    text = await run(`docker compose -f "${composeFile}" ps --format json`, dir);
  } catch (e: any) {
    return { healthy: false, detail: String(e?.stderr || e?.message || 'compose ps 失败') };
  }
  const rows: any[] = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) rows.push(...parsed);
    else rows.push(parsed);
  } catch {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        // 忽略非 JSON 行
      }
    }
  }
  if (rows.length === 0) {
    return { healthy: false, detail: '未发现运行中的服务容器' };
  }
  for (const row of rows) {
    const service = String(row.Service || row.service || row.Name || row.name || '?');
    const state = String(row.State || row.state || row.Status || row.status || '').toLowerCase();
    if (state && state !== 'running') {
      return { healthy: false, detail: `服务 ${service} 状态为 ${state}` };
    }
  }
  return { healthy: true, detail: `${rows.length} 个服务运行中` };
}

/**
 * 自动回滚：旧镜像重新打回原 tag → 还原 compose 文件 → 强制重建
 */
export async function rollbackUpgrade(appId: string, dir: string): Promise<{ steps: string[] }> {
  const snap = loadUpgradeSnapshot(appId);
  const steps: string[] = [];
  if (!snap) {
    steps.push('未找到升级前快照，无法自动回滚');
    return { steps };
  }
  // 1. 旧镜像 ID 重新打回原 tag（pull 同名 tag 会顶掉旧引用，镜像本体仍在）
  for (const img of snap.images) {
    if (!img.id || !img.repository) continue;
    const ref = img.tag ? `${img.repository}:${img.tag}` : img.repository;
    try {
      await run(`docker tag "${img.id}" "${ref}"`, dir);
      steps.push(`已将镜像 ${img.id.slice(0, 12)} 重新标记为 ${ref}`);
    } catch (e: any) {
      steps.push(`镜像 ${ref} 重新标记失败：${String(e?.message || e)}`);
    }
  }
  // 2. 还原 compose 文件
  const composePath = path.join(dir, snap.composeFile);
  if (snap.composeContent) {
    try {
      fs.writeFileSync(composePath, snap.composeContent, 'utf8');
      steps.push('已还原升级前 compose 配置');
    } catch {
      steps.push('compose 文件还原失败（目录不可写？）');
    }
  }
  // 3. 按旧配置重建
  try {
    await run(`docker compose -f "${composePath}" up -d --remove-orphans --force-recreate`, dir);
    steps.push('已按升级前配置重建容器');
  } catch (e: any) {
    steps.push(`回滚重建失败：${String(e?.stderr || e?.message || e)}`);
  }
  return { steps };
}
