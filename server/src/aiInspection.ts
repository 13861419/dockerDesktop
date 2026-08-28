/**
 * AI 定时巡检报告模块（ai_inspections 表）
 *
 * 采集 Docker 容器运行快照（状态/健康/镜像），调用默认 AI 配置生成巡检摘要，
 * 结果落库并可选推送通知渠道。作为调度器任务类型 aiInspection 注册，
 * 用户在「计划任务」中新建该类型任务即可按 cron 定期巡检。
 *
 * 零依赖：dockerode + 已有 aiClient / notify / storage。
 */
import { getDb } from './storage';
import { purgeExpiredTable } from './retention';
import { getDockerClient } from './docker/client';
import { chatCompletion, AiConfig } from './aiClient';
import { listChannels, sendAlert } from './notify';
import { registerTaskHandler, type CronTaskRow, type TaskRunResult } from './scheduler';

/** 单条巡检报告 */
export interface AiInspection {
  id: number;
  status: number; // 0=正常 1=异常 2=AI 不可用
  summary: string;
  snapshot: string;
  createdAt: number;
}

/** 采集容器运行快照（文本形式，供 AI 分析与落库） */
export async function collectContainerSnapshot(): Promise<string> {
  const docker = await getDockerClient();
  const list = (await docker.listContainers({ all: true })) as any[];
  if (!list.length) return '当前没有任何容器。';
  const lines = list.map((c) => {
    const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12) || 'unknown';
    const state = c.State || 'unknown';
    const status = c.Status || '';
    const image = c.Image || '';
    return `- ${name} | 镜像: ${image} | 状态: ${state} | 详情: ${status}`;
  });
  return `共 ${list.length} 个容器：\n${lines.join('\n')}`;
}

/** 根据快照构建巡检 prompt */
export function buildInspectionPrompt(snapshot: string): string {
  return `你是 Docker 运维巡检助手。以下是当前宿主机上全部容器的运行快照，请生成一份简明巡检报告，要求：
1. 概览：容器总数、运行中/异常数量；
2. 异常项：逐个列出非 running 或 unhealthy 的容器，并给出可能原因与处理建议；
3. 风险提示：镜像明显过期、重启频繁（Status 含 Restarting）等值得关注的点；
4. 结论：一句话总结整体健康度（健康/关注/需处理）。

容器快照：
${snapshot}

请用 Markdown 输出，控制在 500 字以内。`;
}

/** 简要判断快照中是否存在异常容器（用于落库状态标记） */
export function snapshotHasAbnormal(snapshot: string): boolean {
  return /\| 状态: (exited|dead|paused|restarting)/.test(snapshot) || /unhealthy/i.test(snapshot);
}

/** 将巡检结果写入 ai_inspections 表 */
export function saveInspection(status: number, summary: string, snapshot: string): number {
  const info = getDb()
    .prepare('INSERT INTO ai_inspections (status, summary, snapshot, created_at) VALUES (?, ?, ?, ?)')
    .run(status, summary, snapshot, Date.now());
  return Number(info.lastInsertRowid);
}

/** 最近巡检记录列表（倒序） */
export function listInspections(limit = 20): AiInspection[] {
  purgeExpiredTable('ai.inspection.retentionDays', 'ai.inspection.lastPurgeAt', 'ai_inspections');
  const rows = getDb()
    .prepare('SELECT id, status, summary, snapshot, created_at FROM ai_inspections ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    summary: r.summary || '',
    snapshot: r.snapshot || '',
    createdAt: r.created_at,
  }));
}

/** 获取单条巡检记录 */
export function getInspection(id: number): AiInspection | null {
  const r = getDb().prepare('SELECT id, status, summary, snapshot, created_at FROM ai_inspections WHERE id = ?').get(id) as any;
  if (!r) return null;
  return { id: r.id, status: r.status, summary: r.summary || '', snapshot: r.snapshot || '', createdAt: r.created_at };
}

/** 删除巡检记录；返回是否成功 */
export function deleteInspection(id: number): boolean {
  const res = getDb().prepare('DELETE FROM ai_inspections WHERE id = ?').run(id);
  return res.changes > 0;
}

/** 可选通知：把巡检摘要推送到所有启用的通知渠道 */
async function notifyAll(text: string): Promise<void> {
  for (const ch of listChannels()) {
    if (!ch.enabled) continue;
    try {
      await sendAlert(ch.id, text);
    } catch {
      // 单渠道失败不影响整体
    }
  }
}

/**
 * 执行一次 AI 巡检：采集快照 → AI 生成摘要 → 落库 → 可选通知。
 * @param opts.notify 是否推送通知渠道
 * @param cfg AI 配置（默认取默认 profile）；调度器调用时由内部解析
 */
export async function runInspection(opts: { notify?: boolean; username?: string } = {}, cfg?: AiConfig): Promise<{ ok: boolean; id?: number; summary: string; snapshot: string }> {
  const snapshot = await collectContainerSnapshot();
  const abnormal = snapshotHasAbnormal(snapshot);
  let summary = '';
  if (cfg) {
    try {
      summary = await chatCompletion(cfg, [
        { role: 'system', content: '你是资深的 Docker 运维专家，负责巡检报告生成。输出精炼、可执行的中文 Markdown。' },
        { role: 'user', content: buildInspectionPrompt(snapshot) },
      ]);
    } catch {
      summary = '';
    }
  }
  if (!summary) {
    // AI 不可用：降级为纯快照记录，不失败
    const status = abnormal ? 1 : 0;
    const fallback = abnormal ? 'AI 暂不可用，检测到容器存在异常状态，请人工核查。' : 'AI 暂不可用，所有容器状态正常。';
    const id = saveInspection(status, fallback, snapshot);
    return { ok: true, id, summary: fallback, snapshot };
  }
  const id = saveInspection(abnormal ? 1 : 0, summary, snapshot);
  if (opts.notify) {
    await notifyAll(`【AI 巡检报告】\n${summary}`);
  }
  return { ok: true, id, summary, snapshot };
}

/** 调度器 handler：AI 定时巡检（config: { notify?: boolean }） */
async function runInspectionHandler(_task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  // 延迟解析默认 profile 配置，避免循环依赖（与路由侧一致）
  const { getDefaultProfile, getProfileApiKey } = await import('./aiProfiles');
  const { profileToAiConfig } = await import('./aiClient');
  const prof = getDefaultProfile();
  let cfg: AiConfig | undefined;
  if (prof) {
    cfg = profileToAiConfig(prof);
    cfg.apiKey = getProfileApiKey(prof.id);
  }
  const r = await runInspection({ notify: config.notify === true }, cfg);
  return { ok: true, detail: r.summary };
}

// 注册到调度器（模块加载即注册）
registerTaskHandler('aiInspection', runInspectionHandler);
