/**
 * 镜像 GC 策略（纯函数模块，零依赖）
 *
 * 把「手动/全量清理」升级为「按策略自动回收」：
 *  - keepPerRepo   ：每个 repo 按创建时间保留最近 N 个标签，历史版本进入清理候选
 *  - olderThanDays ：创建时间超过阈值且"闲置"（未被引用、最近拉取亦超时）进入候选
 *  - pruneDangling ：清理悬空（无标签）镜像
 *  - 安全防线      ：被容器引用的镜像（usedByContainers）永远进入 keepers，绝不删除
 *
 * 全模块为纯函数（不触 Docker、不删对象），由 gc 路由层负责拉取列表与执行删除。
 */

/** 参与策略计算的单个镜像（由路由层从 listImages + 引用 + 拉取时间融合） */
export interface GcImage {
  id: string;
  /** 仓库标签，形如 ["nginx:1.25"]；空数组 = 悬空 */
  repoTags: string[];
  /** 创建时间（Unix 秒） */
  created: number;
  /** 最近拉取时间（Unix 秒），无记录为 undefined */
  lastPullAt?: number;
  /** 是否被容器引用 */
  usedByContainers: boolean;
  /** 镜像字节大小 */
  size: number;
}

/** 策略输入 */
export interface GcPolicy {
  /** 每 repo 保留最近 N 个标签（>=0）；未配置/0 表示不按此策略 */
  keepPerRepo?: number;
  /** 超过该天数才考虑清理（按 created，且 lastPullAt 亦超过视为闲置） */
  olderThanDays?: number;
  /** 清理悬空镜像 */
  pruneDangling?: boolean;
}

/** 清理候选中的单个项 */
export interface GcCandidate {
  id: string;
  tags: string[];
  size: number;
  created: number;
  lastPullAt?: number;
  reasons: string[];
}

/** 计划结果 */
export interface GcPlan {
  candidates: GcCandidate[];
  keepers: GcImage[];
  skipped: Array<{ name: string; reason: string }>;
  totals: { toFree: number; bytes: number };
  warnings: string[];
}

function warnArr(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * 按策略计算清理计划（纯函数，绝不删除）
 * @param images 镜像列表（含引用/拉取信息）
 * @param policy 策略
 */
export function planGc(images: GcImage[], policy: GcPolicy): GcPlan {
  const candidates: GcCandidate[] = [];
  const keepers: GcImage[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const warnings: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  // 1) 用容器引用的镜像永不删除
  for (const img of images) {
    if (img.usedByContainers) {
      keepers.push(img);
      const name = img.repoTags[0] || img.id.slice(0, 12);
      skipped.push({ name, reason: '有容器引用' });
    }
  }
  const usedSet = new Set(images.filter((i) => i.usedByContainers).map((i) => i.id));
  const unusedImages = images.filter((i) => !usedSet.has(i.id));

  // 2) keepPerRepo：每 repo 保留最近 N 个标签
  if (policy.keepPerRepo && policy.keepPerRepo > 0) {
    const keep = Math.floor(policy.keepPerRepo);
    const byRepo = new Map<string, GcImage[]>();
    for (const img of unusedImages) {
      // 一个镜像可能属同一 repo 的多个 tag（同一 id 通常单 tag，防御处理取首 tag）
      const tag = img.repoTags[0];
      if (!tag) continue;
      const repo = tag.split(':')[0];
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo)!.push(img);
    }
    for (const [repo, group] of byRepo) {
      const sorted = [...group].sort((a, b) => (b.created || 0) - (a.created || 0));
      const toKeep = new Set(sorted.slice(0, keep).map((i) => i.id));
      for (const img of sorted) {
        if (toKeep.has(img.id)) continue; // 保留
        const name = img.repoTags[0] || img.id.slice(0, 12);
        addCandidate(candidates, img, [`超出每 repos 保留 ${keep} 个（repo=${repo}）`]);
      }
    }
  }

  // 3) olderThanDays：超龄且闲置
  if (policy.olderThanDays && policy.olderThanDays > 0) {
    const days = Math.floor(policy.olderThanDays);
    for (const img of unusedImages) {
      // 已因 keepPerRepo 成为候选的跳过重复
      if (candidates.some((c) => c.id === img.id)) continue;
      const createdAge = img.created ? now - img.created : 0;
      const pullAge = img.lastPullAt ? now - img.lastPullAt : createdAge;
      if (createdAge > days * 86400 && pullAge > days * 86400) {
        const name = img.repoTags[0] || img.id.slice(0, 12);
        addCandidate(candidates, img, [`创建超过 ${days} 天且闲置`]);
      }
    }
  }

  // 4) pruneDangling：悬空（无标签）且未被引用
  if (policy.pruneDangling) {
    for (const img of unusedImages) {
      if (!img.repoTags || img.repoTags.length === 0) {
        if (candidates.some((c) => c.id === img.id)) continue;
        addCandidate(candidates, img, ['悬空镜像']);
      }
    }
  }

  if (candidates.length === 0) {
    warnings.push('本次策略没有找到可清理的镜像，请检查策略配置或确认镜像均为在用/保留状态');
  }

  const referenced = usedSet.size;
  if (referenced > 0) {
    warnings.push(`${referenced} 个镜像因被容器引用而被安全保留`);
  }

  return {
    candidates,
    keepers,
    skipped,
    totals: {
      toFree: candidates.length,
      bytes: candidates.reduce((s, c) => s + (c.size || 0), 0),
    },
    warnings: warnArr(warnings),
  };
}

function addCandidate(candidates: GcCandidate[], img: GcImage, reasons: string[]): void {
  candidates.push({
    id: img.id,
    tags: img.repoTags || [],
    size: img.size || 0,
    created: img.created || 0,
    lastPullAt: img.lastPullAt,
    reasons,
  });
}

/** 将清理计划汇总为可读文本（供定时任务 last_detail） */
export function summarizePlan(plan: GcPlan): string {
  const lines: string[] = [];
  lines.push(`候选清理镜像: ${plan.totals.toFree} 个, 可释放 ${bytesText(plan.totals.bytes)}`);
  if (plan.warnings.length) lines.push('提示: ' + plan.warnings.join('; '));
  return lines.join('\n');
}

/** 字节人类可读 */
export function bytesText(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

// ======== 依赖 Docker 的收集逻辑（供路由与定时任务 handler 复用，非纯函数） ========

import { getDockerClient } from './docker/client';
import { getPullTime } from './imagePullHistory';

type Docker = Awaited<ReturnType<typeof getDockerClient>>;

/**
 * 融合 listImages + 容器引用 + 拉取时间为 GcImage[]（供 planGc 使用）
 * @param docker dockerode 客户端
 */
export async function collectGcImages(docker: Docker): Promise<GcImage[]> {
  const [images, containers] = await Promise.all([
    docker.listImages({ all: false }).catch(() => [] as any[]),
    docker.listContainers({ all: true }).catch(() => [] as any[]),
  ]);
  const usedImageIds = new Set<string>();
  const usedImageNames = new Set<string>();
  for (const c of containers as any[]) {
    if (c.ImageID) usedImageIds.add(c.ImageID);
    if (c.Image) usedImageNames.add(c.Image);
  }
  const isUsed = (img: any): boolean => {
    if (img.Id && usedImageIds.has(img.Id)) return true;
    const tags = img.RepoTags || [];
    return tags.some((t: string) => usedImageNames.has(t));
  };
  return (images as any[]).map((img) => ({
    id: img.Id,
    repoTags: img.RepoTags || [],
    created: img.Created || 0,
    lastPullAt: img.Id ? getPullTime(img.Id) : undefined,
    usedByContainers: isUsed(img),
    size: img.Size || 0,
  }));
}
