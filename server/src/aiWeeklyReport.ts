/**
 * AI 使用周报模块（调度器任务类型 aiWeeklyReport）
 *
 * 汇总最近 7 天 AI 用量（调用次数、token、费用估算、按模型分布、按用户统计），
 * 生成文本周报并推送到所有启用的通知渠道。可在「计划任务」中新建该类型任务，
 * 配合 cron（如 `0 9 * * 1` 每周一 09:00）实现每周自动推送。
 */
import { listAiUsageByDayWithCost, listAiUsageByModel, getAiChatStats, type AiChatStats } from './aiUsage';
import { listChannels, sendAlert } from './notify';
import { registerTaskHandler, type CronTaskRow, type TaskRunResult } from './scheduler';

/** 周报输入（与 aiUsage 查询结果对齐的最小结构，便于测试） */
export interface WeeklyReportInput {
  byDay: Array<{ day: string; calls: number; totalTokens: number; cost: number }>;
  byModel: Array<{ model: string; calls: number; totalTokens: number }>;
  chatStats: AiChatStats[];
}

/** 生成周报文本（纯函数，便于单测） */
export function buildWeeklyReport(input: WeeklyReportInput): string {
  const { byDay, byModel, chatStats } = input;
  const totalCalls = byDay.reduce((n, d) => n + d.calls, 0);
  const totalTokens = byDay.reduce((n, d) => n + d.totalTokens, 0);
  const totalCost = byDay.reduce((n, d) => n + (d.cost || 0), 0);
  const lines: string[] = [];
  lines.push('【AI 使用周报（近 7 天）】');
  lines.push(`总调用: ${totalCalls} 次 | 总 Token: ${totalTokens.toLocaleString()} | 估算费用: $${totalCost.toFixed(4)}`);
  if (byModel.length > 0) {
    lines.push('');
    lines.push('模型分布:');
    const top = [...byModel].sort((a, b) => b.calls - a.calls).slice(0, 5);
    for (const m of top) {
      const pct = totalCalls > 0 ? Math.round((m.calls / totalCalls) * 100) : 0;
      lines.push(`- ${m.model || '(未知)'}: ${m.calls} 次（${pct}%）, ${m.totalTokens.toLocaleString()} tok`);
    }
  }
  if (chatStats.length > 0) {
    lines.push('');
    lines.push('用户统计:');
    for (const s of chatStats.slice(0, 5)) {
      lines.push(`- ${s.username || '匿名'}: ${s.totalMessages} 次调用, ${s.totalTokens.toLocaleString()} tok, $${(s.totalCost || 0).toFixed(4)}`);
    }
  }
  if (totalCalls === 0) {
    lines.push('');
    lines.push('本周暂无 AI 调用记录。');
  }
  return lines.join('\n');
}

/** 推送到所有启用的通知渠道 */
async function notifyAll(text: string): Promise<number> {
  let sent = 0;
  for (const ch of listChannels()) {
    if (!ch.enabled) continue;
    try {
      const r = await sendAlert(ch.id, text);
      if (r.ok) sent++;
    } catch {
      // 单渠道失败不影响整体
    }
  }
  return sent;
}

/** 生成并推送周报；返回推送的渠道数 */
export async function sendWeeklyReport(): Promise<{ ok: boolean; report: string; sent: number }> {
  const byDay = listAiUsageByDayWithCost(7);
  const byModel = listAiUsageByModel();
  const chatStats = getAiChatStats();
  const report = buildWeeklyReport({ byDay, byModel, chatStats });
  const sent = await notifyAll(report);
  return { ok: true, report, sent };
}

/** 调度器 handler */
async function runWeeklyReportHandler(_task: CronTaskRow, _config: Record<string, any>): Promise<TaskRunResult> {
  const r = await sendWeeklyReport();
  return { ok: true, detail: `周报已生成${r.sent > 0 ? `并推送至 ${r.sent} 个渠道` : '（无启用的通知渠道）'}` };
}

// 注册到调度器（模块加载即注册）
registerTaskHandler('aiWeeklyReport', runWeeklyReportHandler);
