/**
 * AI 告警诊断模块
 *
 * 告警触发后（danger 级别）异步调用 AI 分析根因，生成诊断建议并作为后续消息
 * 推送到同一通知渠道。设计原则：
 *  - 不阻塞告警本体推送：先发告警，AI 诊断作为 follow-up 异步补充
 *  - AI 不可用/超时则静默跳过，不影响告警链路
 *  - 零依赖：复用 dockerode / aiClient / notify
 */
import { getDockerClient } from './docker/client';
import { chatCompletion, AiConfig, profileToAiConfig } from './aiClient';
import { sendAlert } from './notify';
import { getDefaultProfile, getProfileApiKey } from './aiProfiles';

/** 采集容器运行快照（精简版） */
async function collectSnapshot(): Promise<string> {
  try {
    const docker = await getDockerClient();
    const list = (await docker.listContainers({ all: true })) as any[];
    if (!list.length) return '当前没有任何容器。';
    return list
      .map((c) => {
        const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12) || 'unknown';
        return `- ${name} | 镜像: ${c.Image || ''} | 状态: ${c.State || ''} | 详情: ${c.Status || ''}`;
      })
      .join('\n');
  } catch {
    return '（无法获取容器快照）';
  }
}

/** 构建诊断 prompt */
export function buildDiagnosePrompt(alert: { type: string; level: string; message: string; value: number | null }, snapshot: string): string {
  return `你是资深 Docker 运维专家。系统刚触发了一条告警，请结合容器快照分析可能根因并给出处理建议。

告警信息：
- 类型: ${alert.type}
- 级别: ${alert.level}
- 内容: ${alert.message}
- 数值: ${alert.value ?? '-'}

容器快照：
${snapshot}

请用 Markdown 输出，格式：
## 可能根因
（2-4 条，按可能性排序）
## 处理建议
（2-4 条可执行命令或步骤）
控制在 300 字以内，不要复述告警内容。`;
}

/**
 * 生成告警诊断文本；AI 不可用时返回 null
 */
export async function diagnoseAlert(alert: { type: string; level: string; message: string; value: number | null }): Promise<string | null> {
  const prof = getDefaultProfile();
  if (!prof) return null;
  const cfg: AiConfig = profileToAiConfig(prof);
  cfg.apiKey = getProfileApiKey(prof.id);
  if (!cfg.baseUrl || !cfg.model) return null;
  const snapshot = await collectSnapshot();
  try {
    const text = await chatCompletion(cfg, [
      { role: 'system', content: '你是资深 Docker 运维专家，输出精炼可执行的中文诊断。' },
      { role: 'user', content: buildDiagnosePrompt(alert, snapshot) },
    ]);
    return text || null;
  } catch {
    return null;
  }
}

/**
 * 告警后异步推送 AI 诊断（fire-and-forget）
 * @param channelId 告警已推送成功的渠道 id
 * @param alert 告警上下文
 */
export function pushAiDiagnosis(channelId: string, alert: { type: string; level: string; message: string; value: number | null }): void {
  // 异步执行，不阻塞告警主链路
  (async () => {
    const diagnosis = await diagnoseAlert(alert);
    if (!diagnosis) return;
    await sendAlert(channelId, `【AI 诊断】${alert.message}\n\n${diagnosis}`);
  })().catch(() => {
    // 诊断失败静默
  });
}
