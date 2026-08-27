/**
 * AI 智能助手 API 路由（挂 /api/ai）
 *
 * 提供：
 *  - GET/PUT /settings   ：读写 AI 配置（apiKey 加密脱敏）
 *  - POST /test          ：连通性测试
 *  - GET  /capabilities  ：可用工具能力清单
 *  - POST /chat          ：主对话入口，支持 tool 上下文注入（compose-infer / logs）
 *
 * 安全设计：
 *  - 全部 requireAuth；配置类写操作 requireAdmin。
 *  - AI 只"生成/建议"，绝不直接执行任何 Docker 写操作。
 *  - 未配置时 /chat 返回 503，不发任何外部请求。
 *  - 调用写入审计（operationLog）。
 */
import { Router, Request, Response } from 'express';
import {
  getAiConfig,
  updateAiConfig,
  buildSystemPrompt,
  chatCompletion,
  chatCompletionStream,
  testAiConnection,
  profileToAiConfig,
  parseActionsFromResponse,
  ACTION_SUGGEST_INSTRUCTION,
  getLocalModelStatus,
} from '../aiClient';
import type { AiConfig } from '../aiClient';
import { analyzeFile, MAX_FILE_CHARS } from '../aiFileAnalyzer';
import { getOllamaStatus, getOllamaRunning, pullOllamaModel, deleteOllamaModel } from '../ollamaClient';
import { createKnowledge, updateKnowledge, deleteKnowledge, getKnowledge, listKnowledge, getKnowledgeStats, searchKnowledge } from '../aiKnowledge';
import {
  ensureAiProfiles,
  listProfiles,
  getDefaultProfile,
  getProfileById,
  getProfileApiKey,
  createProfile,
  updateProfile,
  deleteProfile,
  setDefaultProfile,
  assertValidBaseUrl,
} from '../aiProfiles';
import type { AiProfilePublic } from '../aiProfiles';
import { AI_PRESETS } from '../aiPresets';
import { logOperation } from '../operationLog';
import { requireAdmin, requireAuth } from '../auth';
import { getDockerClient } from '../docker/client';
import { recordAiUsage, estimateTokens, summarizeAiUsage, listAiUsageByModel, listAiUsageByDay, clearAiUsage, getMonthlyUsage, listAiUsageByDayWithCost, listAiUsageByWeek, getAiPerformanceMetrics } from '../aiUsage';
import { getCache, setCache, getCacheStats, clearCache } from '../aiCache';
import { createAction, listPendingActions, getAction, approveAction, rejectAction, markExecuted, getActionStats, ACTION_TYPE_LABELS } from '../aiActions';
import {
  listChatSessions,
  getChatSession,
  createChatSession,
  updateChatSessionTitle,
  updateChatSessionMessages,
  deleteChatSession,
  searchChatSessions,
} from '../aiChatHistory';
import {
  listTemplates,
  getTemplate,
  listTemplateCategories,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from '../aiTemplates';

const router = Router();

/** 统一兜底错误处理（与其它路由一致） */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      res.status(status).json({ error: err?.message || '服务器内部错误' });
    });
  };
}

/** 全局开关（持久化于 ai_settings.enabled，向前兼容） */
function isEnabled(): boolean {
  return getAiConfig().enabled;
}

/** 默认 profile 是否已可供使用（存在且 baseUrl+model 合法） */
function isAiAvailable(): boolean {
  const prof = getDefaultProfile();
  if (!prof || !prof.baseUrl || !prof.model) return false;
  try {
    assertValidBaseUrl(prof.baseUrl);
    return true;
  } catch {
    return false;
  }
}

/** 取默认 profile 对应的 AiConfig（含解密 key）；无 profile 返回 null */
function profileAiConfig() {
  const prof = getDefaultProfile();
  if (!prof) return null;
  const cfg = profileToAiConfig(prof);
  cfg.apiKey = getProfileApiKey(prof.id);
  return cfg;
}

/** 当前默认 profile 元数据（用于用量记录的 provider 归集）；无则回退） */
function aiProfileMeta(profile?: AiProfilePublic | null) {
  const prof = profile ?? getDefaultProfile();
  return {
    id: prof?.id ?? null,
    provider: prof?.provider || '',
    model: prof?.model || '',
  };
}

/** 获取所有可用 profile 转为 AiConfig（按优先级排序，默认在前） */
function buildCandidateConfigs(): Array<{ cfg: AiConfig; profile: AiProfilePublic }> {
  const profiles = listProfiles();
  const out: Array<{ cfg: AiConfig; profile: AiProfilePublic }> = [];
  for (const p of profiles) {
    if (!p.baseUrl || !p.model) continue;
    const cfg = profileToAiConfig(p);
    cfg.apiKey = getProfileApiKey(p.id);
    out.push({ cfg, profile: p });
  }
  return out;
}

/** 检查 profile 月度预算是否超限；超限返回错误信息，否则返回 null */
function checkBudget(profile: AiProfilePublic): string | null {
  const { budgetMonthlyTokens, budgetMonthlyCost } = profile;
  if (!budgetMonthlyTokens && !budgetMonthlyCost) return null;
  const usage = getMonthlyUsage(profile.id);
  if (budgetMonthlyTokens > 0 && usage.tokens >= budgetMonthlyTokens) {
    return `${profile.name} 月度 token 预算已用完（${usage.tokens.toLocaleString()} / ${budgetMonthlyTokens.toLocaleString()}）`;
  }
  if (budgetMonthlyCost > 0 && usage.cost >= budgetMonthlyCost) {
    return `${profile.name} 月度费用预算已超限（¥${usage.cost.toFixed(2)} / ¥${budgetMonthlyCost.toFixed(2)}）`;
  }
  return null;
}

/** 智能路由：根据消息复杂度对候选 profile 排序，简单消息优先用轻量模型 */
function smartRoute(candidates: Array<{ cfg: AiConfig; profile: AiProfilePublic }>, lastUserMsg: string, tool?: string): Array<{ cfg: AiConfig; profile: AiProfilePublic }> {
  if (candidates.length <= 1) return candidates;
  // 复杂度评估
  const msg = lastUserMsg || '';
  let complexity = 0;
  // 长消息更复杂
  if (msg.length > 500) complexity += 2;
  else if (msg.length > 100) complexity += 1;
  // 关键词触发
  const complexKeywords = ['生成', '分析', '解释', '调试', '优化', '重构', '设计', '架构', '安全', '性能', '诊断', 'generate', 'analyze', 'debug', 'optimize', 'explain', 'design', 'security'];
  for (const kw of complexKeywords) {
    if (msg.toLowerCase().includes(kw)) { complexity += 1; break; }
  }
  // 使用工具时更复杂
  if (tool === 'compose-infer' || tool === 'logs') complexity += 1;

  if (complexity <= 0) {
    // 简单消息：尝试按 id 升序（通常小 id = 轻量模型）排在前面
    return [...candidates].sort((a, b) => a.profile.id - b.profile.id);
  }
  // 复杂消息：保持默认顺序（默认 profile 优先）
  return candidates;
}

/** 工具能力清单（供前端快捷入口渲染） */
const CAPABILITIES = [
  {
    id: 'compose-infer',
    label: 'Compose 生成',
    description: '从运行中的容器一键生成 docker-compose 配置',
    prompt: '请帮我从当前运行中的容器生成 Compose 配置，先列出可选择逆向的容器。',
    tool: 'compose-infer',
  },
  {
    id: 'logs',
    label: '日志分析',
    description: '分析指定容器的日志，总结异常并给出建议',
    prompt: '请分析容器日志，总结异常并给出根因建议。',
    tool: 'logs',
  },
  {
    id: 'diagnose',
    label: '排障问答',
    description: '就容器报错/异常进行诊断',
    prompt: '请帮我诊断以下 Docker 运维问题。',
  },
  {
    id: 'command',
    label: '命令生成',
    description: '把需求转成 docker CLI / 面板操作命令',
    prompt: '请把下面的需求转成可执行的 docker 命令或面板操作步骤。',
  },
];

/** 提取日志 Buffufer 为纯文本（合并 stdout/stderr）供 AI 上下文使用 */
function logsBufferToText(buf: Buffer | any, tty = false): string {
  if (tty) {
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  }
  let buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const chunks: string[] = [];
  while (buffer.length >= 8) {
    const payloadLen = buffer.readUInt32BE(4);
    if (buffer.length < 8 + payloadLen) break;
    const payload = buffer.subarray(8, 8 + payloadLen).toString('utf8');
    chunks.push(payload);
    buffer = buffer.subarray(8 + payloadLen);
  }
  if (buffer.length > 0) chunks.push(buffer.toString('utf8'));
  return chunks.join('');
}

/** 读取单个容器最近日志（截断）作为 AI 上下文 */
async function fetchContainerLogContext(containerId: string): Promise<string> {
  const docker = await getDockerClient();
  const container = docker.getContainer(containerId);
  const info = await container.inspect().catch(() => null);
  const tty = !!info?.Config?.Tty;
  const logs = await container.logs({ stdout: true, stderr: true, tail: 300, follow: false }).catch(() => Buffer.alloc(0));
  const text = logsBufferToText(logs, tty);
  // 截断，避免上下文过大
  const MAX = 60000;
  const truncated = text.length > MAX;
  const name = Array.isArray(info?.Name) ? info.Name.join(',') : info?.Name || containerId.slice(0, 12);
  return `容器 ${name} 最近日志${truncated ? '（已截断）' : ''}：\n${text.slice(-MAX)}`;
}

/** 收集运行中容器清单作为 AI 上下文（最多 100 个，防止上下文过大） */
const MAX_COMPOSE_CONTAINERS = 100;

async function fetchContainersContext(): Promise<string> {
  const docker = await getDockerClient();
  const list = (await docker.listContainers({ all: false }).catch(() => [])) as any[];
  const truncated = list.length > MAX_COMPOSE_CONTAINERS;
  const sliced = truncated ? list.slice(0, MAX_COMPOSE_CONTAINERS) : list;
  const lines = sliced.map((c: any, i: number) => {
    const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12);
    const ports = Array.isArray(c.Ports)
      ? c.Ports.map((p: any) => (p.PublicPort ? `${p.PrivatePort}->${p.PublicPort}/${p.Type || 'tcp'}` : `${p.PrivatePort}/${p.Type || 'tcp'}`)).join(' ')
      : '';
    return `[${i + 1}] id=${c.Id?.slice(0, 12)} name=${name} image=${c.Image || ''} status=${c.State || ''}${ports ? ` ports=${ports}` : ''}`;
  });
  if (lines.length === 0) return '当前没有运行中的容器。';
  const hint = truncated ? `\n（共 ${list.length} 个运行中容器，已截取前 ${MAX_COMPOSE_CONTAINERS} 个）` : '';
  return `以下是当前运行中的容器（共 ${lines.length} 个）：\n${lines.join('\n')}${hint}`;
}

// ============ 配置读写 ============

/**
 * GET /api/ai/settings
 * 读取配置（apiKey 脱敏，仅 hasApiKey 布尔）
 */
router.get(
  '/settings',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    ensureAiProfiles();
    res.json({ enabled: isEnabled(), available: isAiAvailable(), defaultProfile: getDefaultProfile() });
  }),
);

/**
 * PUT /api/ai/settings
 * 写入配置（body 部分字段；apiKey 为空串=不修改）
 */
router.put(
  '/settings',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    ensureAiProfiles();
    // 仅更新全局开关（持久化到 ai_settings.enabled）+ 可选默认 profile
    updateAiConfig({ enabled: body.enabled });
    if (body.defaultProfileId !== undefined && body.defaultProfileId !== null && body.defaultProfileId !== '') {
      setDefaultProfile(Number(body.defaultProfileId));
    }
    logOperation(res.locals.username, '更新 AI 助手配置', 'ai', null);
    res.json({ enabled: isEnabled(), available: isAiAvailable(), defaultProfile: getDefaultProfile() });
  }),
);

// ============ 连通性测试 ============

/**
 * POST /api/ai/test
 * 连通性测试（发最小请求验证 base/model/key）
 * body 可选：{ baseUrl, model, apiKey, timeoutMs }（不持久化，仅测试用）；缺省用已存配置
 */
router.post(
  '/test',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    ensureAiProfiles();
    const body = req.body || {};
    let cfg = profileAiConfig();
    if (!cfg) cfg = getAiConfig();
    const testCfg = {
      ...cfg,
      baseUrl: body.baseUrl !== undefined ? String(body.baseUrl) : cfg.baseUrl,
      model: body.model !== undefined ? String(body.model) : cfg.model,
      apiKey: body.apiKey !== undefined && String(body.apiKey) ? String(body.apiKey) : cfg.apiKey,
      timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : cfg.timeoutMs,
    };
    const result = await testAiConnection(testCfg);
    logOperation(res.locals.username, 'AI 连通性测试', 'ai', null, result.ok ? '成功' : `失败: ${result.message}`);
    res.json({ ok: result.ok, message: result.message });
  }),
);

// ============ 提供商预设 ============

/**
 * GET /api/ai/presets
 * 返回内置 AI 提供商预设清单（只读）
 */
router.get(
  '/presets',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ presets: AI_PRESETS });
  }),
);

// ============ 多配置文件 ============

/**
 * GET /api/ai/profiles
 * 返回所有 AI 配置文件
 */
router.get(
  '/profiles',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    ensureAiProfiles();
    res.json({ profiles: listProfiles() });
  }),
);

/**
 * POST /api/ai/profiles
 * 新建 AI 配置文件
 */
router.post(
  '/profiles',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const p = createProfile(req.body || {});
    logOperation(res.locals.username, '新增 AI 配置', 'ai', null, p.name);
    res.json(p);
  }),
);

/**
 * PUT /api/ai/profiles/:id
 * 编辑 AI 配置文件
 */
router.put(
  '/profiles/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const p = updateProfile(id, req.body || {});
    logOperation(res.locals.username, '编辑 AI 配置', 'ai', null, p.name);
    res.json(p);
  }),
);

/**
 * DELETE /api/ai/profiles/:id
 * 删除 AI 配置文件（至少保留一条）
 */
router.delete(
  '/profiles/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    deleteProfile(Number(req.params.id));
    logOperation(res.locals.username, '删除 AI 配置', 'ai', null, String(req.params.id));
    res.json({ ok: true });
  }),
);

/**
 * POST /api/ai/profiles/:id/test
 * 连通性测试指定配置文件（不要求其为默认）
 */
router.post(
  '/profiles/:id/test',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const prof = getProfileById(id);
    if (!prof) return res.status(404).json({ error: '配置不存在' });
    const body = req.body || {};
    const cfg = profileToAiConfig(prof);
    cfg.apiKey = getProfileApiKey(id);
    const testCfg = {
      ...cfg,
      baseUrl: body.baseUrl !== undefined ? String(body.baseUrl) : cfg.baseUrl,
      model: body.model !== undefined ? String(body.model) : cfg.model,
      apiKey: body.apiKey !== undefined && String(body.apiKey) ? String(body.apiKey) : cfg.apiKey,
      timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : cfg.timeoutMs,
    };
    const result = await testAiConnection(testCfg);
    logOperation(res.locals.username, 'AI 配置测试', 'ai', null, result.ok ? '成功' : `失败: ${result.message}`);
    res.json({ ok: result.ok, message: result.message });
  }),
);

/**
 * PUT /api/ai/profiles/:id/default
 * 设为默认配置文件
 */
router.put(
  '/profiles/:id/default',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const p = setDefaultProfile(Number(req.params.id));
    logOperation(res.locals.username, '切换默认 AI 配置', 'ai', null, p.name);
    res.json(p);
  }),
);

// ============ 能力清单 ============

/**
 * GET /api/ai/capabilities
 * 返回可用工具能力清单
 */
router.get(
  '/capabilities',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    ensureAiProfiles();
    res.json({ available: isAiAvailable(), capabilities: CAPABILITIES });
  }),
);

// ============ 主对话 ============

/**
 * 解析对话请求：校验 + 采集 tool 上下文 + 构造最终消息（chat / chat/stream 共用）
 * @returns { finalMessages, toolContext, tool }
 */
async function resolveChatRequest(req: Request, res: Response, cfg: AiConfig) {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    const e: any = new Error('缺少 messages');
    e.statusCode = 400;
    throw e;
  }

  const tool = typeof body.tool === 'string' ? body.tool : '';
  let context = '';
  let toolContext: string | undefined;

  try {
    if (tool === 'compose-infer') {
      context = await fetchContainersContext();
      toolContext = context;
    } else if (tool === 'logs') {
      const target = body.target || body.containerId;
      if (!target) {
        const e: any = new Error('logs 工具需要指定容器（target）');
        e.statusCode = 400;
        throw e;
      }
      context = await fetchContainerLogContext(String(target));
      toolContext = context;
    }
  } catch (err: any) {
    if (err?.statusCode === 400) throw err;
    // 上下文采集失败不阻断对话，附加提示
    context = `（采集环境上下文失败：${err?.message || err}）`;
  }

  // 构造完整消息：system prompt + 对话历史
  const systemMsgs = buildSystemPrompt(cfg, context, '');
  // 对话历史：过滤掉前端可能带的 error 标记，保留 user/assistant 交替
  const history = messages
    .filter((m: any) => m.role === 'user' || m.role === 'assistant')
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content || '') }));
  const finalMessages = [...systemMsgs, ...history];

  // 兜底：如果历史为空（不应该），用最后一轮用户文本
  if (history.length === 0) {
    const lastUser = messages.filter((m: any) => m.role === 'user').pop();
    finalMessages.push({ role: 'user', content: lastUser?.content || '请继续。' });
  }

  return { finalMessages, toolContext, tool, historyCount: history.length };
}

/**
 * POST /api/ai/analyze
 * body: { filename, type?, content }
 * 分析上传的文件（Dockerfile/Compose/日志/配置）
 */
router.post(
  '/analyze',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    ensureAiProfiles();
    const candidates = buildCandidateConfigs();
    if (candidates.length === 0) {
      const e: any = new Error('AI 助手未配置（缺少可用的模型配置）');
      e.statusCode = 503;
      throw e;
    }
    const filename = String(req.body?.filename || '').trim();
    const content = String(req.body?.content || '');
    if (!filename) {
      const e: any = new Error('缺少文件名');
      e.statusCode = 400;
      throw e;
    }
    if (!content) {
      const e: any = new Error('文件内容为空');
      e.statusCode = 400;
      throw e;
    }
    if (content.length > MAX_FILE_CHARS * 2) {
      const e: any = new Error('文件过大（最大 100KB 文本）');
      e.statusCode = 400;
      throw e;
    }

    const { cfg, profile } = candidates[0];
    // 智能路由：复杂分析用默认模型
    const routed = smartRoute(candidates, `分析文件 ${filename}`, 'analyze');
    const useCfg = routed[0].cfg;
    const useProfile = routed[0].profile;

    const result = await analyzeFile(useCfg, { filename, content, type: String(req.body?.type || '') });

    recordAiUsage({
      profileId: useProfile.id,
      provider: useProfile.provider || useCfg.baseUrl,
      model: useCfg.model,
      tool: 'analyze',
      promptTokens: estimateTokens(filename + content),
      completionTokens: estimateTokens(result.suggestions),
      totalTokens: estimateTokens(filename + content) + estimateTokens(result.suggestions),
      promptChars: content.length,
      completionChars: result.suggestions.length,
      success: true,
      username: res.locals.username,
    });
    logOperation(res.locals.username, 'AI 文件分析', 'ai', null, `分析 ${filename}（${result.fileType}）`);
    res.json({ ...result, cfg: { provider: useProfile.provider, model: useCfg.model } });
  }),
);

/**
 * POST /api/ai/chat
 * body: { messages: [{role, content}], tool?: 'compose-infer' | 'logs' | string }
 *  - tool='compose-infer'：注入运行中容器上下文
 *  - tool='logs'：body.target 指定容器 id/name，注入其日志上下文
 * 返回 { reply, enabled, toolContext? }
 */
router.post(
  '/chat',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    ensureAiProfiles();
    const candidates = buildCandidateConfigs();
    if (candidates.length === 0) {
      const e: any = new Error('AI 助手未配置（缺少可用的模型配置）');
      e.statusCode = 503;
      throw e;
    }
    const { finalMessages: baseMsgs, toolContext, tool, historyCount } = await resolveChatRequest(req, res, candidates[0].cfg);

    // 智能路由：根据消息复杂度排序候选
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUserMsg = messages.filter((m: any) => m.role === 'user').pop()?.content || '';
    const routed = smartRoute(candidates, lastUserMsg, tool);

    const username = res.locals.username;
    const promptChars = baseMsgs.reduce((n: number, m: any) => n + String(m.content || '').length, 0);
    const promptEst = estimateTokens(baseMsgs.map((m: any) => m.content).join('\n'));
    let reply = '';
    let usedProfile: AiProfilePublic = routed[0].profile;
    let fallback = false;

    // 语义缓存：检查最近一条用户消息是否命中
    const cacheKeyMsg = baseMsgs.filter((m: any) => m.role === 'user').pop()?.content || '';
    const cachedReply = getCache(cacheKeyMsg, routed[0].cfg.model);
    if (cachedReply) {
      reply = cachedReply;
      usedProfile = routed[0].profile;
      recordAiUsage({
        profileId: routed[0].profile.id,
        provider: routed[0].profile.provider || routed[0].cfg.baseUrl,
        model: routed[0].cfg.model,
        tool: tool || 'chat',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        username,
      });
    } else {

    for (let i = 0; i < routed.length; i++) {
      const { cfg, profile } = routed[i];
      if (i > 0) fallback = true;
      // 预算检查：跳过已超限的 profile
      const budgetErr = checkBudget(profile);
      if (budgetErr) {
        if (i === routed.length - 1) {
          const e: any = new Error(budgetErr);
          e.statusCode = 429;
          throw e;
        }
        continue;
      }
      const sysMsgs = buildSystemPrompt(cfg, '', '');
      // RAG：检索相关知识条目注入上下文
      const lastUserMsg = baseMsgs.filter((m) => m.role === 'user').pop()?.content || '';
      const ragResults = await searchKnowledge(lastUserMsg, 3);
      if (ragResults.length > 0) {
        const ragContext = ragResults.map((k) => `【${k.category}】${k.title}\n${k.content.slice(0, 500)}`).join('\n\n');
        sysMsgs[0] = { role: 'system' as const, content: sysMsgs[0].content + `\n\n## 参考知识\n以下运维知识可能与用户问题相关，请结合参考回答：\n\n${ragContext}` };
      }
      // 追加 action 建议指令（仅非流式）
      sysMsgs[0] = { role: 'system' as const, content: sysMsgs[0].content + ACTION_SUGGEST_INSTRUCTION };
      const finalMessages = [...sysMsgs, ...baseMsgs.filter((m) => m.role !== 'system')];
      try {
        reply = await chatCompletion(cfg, finalMessages);
        usedProfile = profile;
        break;
      } catch (err: any) {
        recordAiUsage({
          profileId: profile.id,
          provider: profile.provider || cfg.baseUrl,
          model: cfg.model,
          tool: tool || 'chat',
          success: false,
          errorMessage: `[故障转移] ${err?.message || '未知错误'}`,
          username,
        });
        if (i === routed.length - 1) throw err;
      }
    }

    // 写入缓存
    if (reply) setCache(cacheKeyMsg, usedProfile.model, reply);

    } // end cache else

    // 解析 action 块并存入数据库
    const { text: cleanReply, actions: parsedActions } = parseActionsFromResponse(reply);
    const createdActions: Array<{ id: number; type: string; label: string }> = [];
    for (const pa of parsedActions) {
      try {
        const action = createAction(username, pa.type, pa.params, cleanReply);
        createdActions.push({ id: action.id, type: pa.type, label: ACTION_TYPE_LABELS[pa.type] || pa.type });
      } catch { /* 忽略写入失败 */ }
    }
    if (createdActions.length > 0) {
      reply = cleanReply; // 返回清理后的纯文本
    }

    const meta = aiProfileMeta(usedProfile);
    logOperation(username, 'AI 对话', 'ai', null,
      `tool=${tool || 'chat'}，${historyCount} 轮消息${fallback ? '（故障转移）' : ''}`);
    recordAiUsage({
      profileId: meta.id,
      provider: meta.provider || usedProfile.baseUrl,
      model: usedProfile.model,
      tool: tool || 'chat',
      promptTokens: promptEst,
      completionTokens: estimateTokens(reply),
      totalTokens: promptEst + estimateTokens(reply),
      promptChars,
      completionChars: reply.length,
      success: true,
      username,
    });
    res.json({ enabled: true, reply, toolContext, fallback, actions: createdActions.length > 0 ? createdActions : undefined });
  }),
);

/**
 * POST /api/ai/chat/stream
 * body 同 /chat；流式返回 SSE 逐块文本（打字机效果）
 * 事件:
 *  - data: {"type":"context","toolContext":string}  可选，先于正文
 *  - data: {"type":"chunk","text":string}            正文增量
 *  - data: {"type":"done"}                            结束
 *  - data: {"type":"error","message":string}         出错
 */
router.post(
  '/chat/stream',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    ensureAiProfiles();
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const candidates = buildCandidateConfigs();
    if (candidates.length === 0) {
      send({ type: 'error', message: 'AI 助手未配置（缺少可用的模型配置）' });
      return res.end();
    }

    // 提前解析请求（上下文采集与 profile 无关）
    let toolContext: string | undefined;
    let tool = '';
    let historyCount = 0;
    let baseMsgs;
    const username = res.locals.username;
    try {
      const r = await resolveChatRequest(req, res, candidates[0].cfg);
      baseMsgs = r.finalMessages;
      toolContext = r.toolContext;
      tool = r.tool;
      historyCount = r.historyCount;
    } catch (err: any) {
      send({ type: 'error', message: err?.message || '请求错误' });
      return res.end();
    }

    if (toolContext) {
      send({ type: 'context', toolContext });
    }

    // 智能路由：根据消息复杂度排序候选
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const lastUserMsg = messages.filter((m: any) => m.role === 'user').pop()?.content || '';
    const routed = smartRoute(candidates, lastUserMsg, tool);

    // 语义缓存：检查最近一条用户消息是否命中
    const streamCacheMsg = baseMsgs.filter((m: any) => m.role === 'user').pop()?.content || '';
    const streamCached = getCache(streamCacheMsg, routed[0].cfg.model);
    if (streamCached) {
      send({ type: 'delta', content: streamCached });
      send({ type: 'done', model: routed[0].cfg.model, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      recordAiUsage({
        profileId: routed[0].profile.id,
        provider: routed[0].profile.provider || routed[0].cfg.baseUrl,
        model: routed[0].cfg.model,
        tool: tool || 'chat',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        username,
      });
      return res.end();
    }

    // 故障转移：逐个尝试候选配置，首个成功即锁定
    let usedProfile: AiProfilePublic = routed[0].profile;
    let fallback = false;
    let firstChunk: string | null = null;
    let streamGen: AsyncGenerator<string, void, unknown> | null = null;
    const capturedUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};

    for (let i = 0; i < routed.length; i++) {
      const { cfg, profile } = routed[i];
      if (i > 0) fallback = true;
      // 预算检查：跳过已超限的 profile
      const budgetErr = checkBudget(profile);
      if (budgetErr) {
        if (i === routed.length - 1) {
          send({ type: 'error', message: budgetErr });
          return res.end();
        }
        continue;
      }
      const sysMsgs = buildSystemPrompt(cfg, '', '');
      // RAG：检索相关知识条目注入上下文
      const lastUserMsgStream = baseMsgs.filter((m) => m.role === 'user').pop()?.content || '';
      const ragResultsStream = await searchKnowledge(lastUserMsgStream, 3);
      if (ragResultsStream.length > 0) {
        const ragContext = ragResultsStream.map((k) => `【${k.category}】${k.title}\n${k.content.slice(0, 500)}`).join('\n\n');
        sysMsgs[0] = { role: 'system' as const, content: sysMsgs[0].content + `\n\n## 参考知识\n以下运维知识可能与用户问题相关，请结合参考回答：\n\n${ragContext}` };
      }
      const finalMessages = [...sysMsgs, ...baseMsgs.filter((m) => m.role !== 'system')];
      try {
        const gen = chatCompletionStream(cfg, finalMessages, (u) => {
          if (u.prompt_tokens !== undefined) capturedUsage.prompt_tokens = u.prompt_tokens;
          if (u.completion_tokens !== undefined) capturedUsage.completion_tokens = u.completion_tokens;
          if (u.total_tokens !== undefined) capturedUsage.total_tokens = u.total_tokens;
        });
        const first = await gen.next();
        if (!first.done && first.value) {
          firstChunk = first.value;
          streamGen = gen;
          usedProfile = profile;
          break;
        }
      } catch (err: any) {
        recordAiUsage({
          profileId: profile.id,
          provider: profile.provider || cfg.baseUrl,
          model: cfg.model,
          tool: tool || 'chat',
          success: false,
          errorMessage: `[故障转移] ${err?.message || '未知错误'}`,
          username,
        });
        if (i === routed.length - 1) {
          send({ type: 'error', message: err?.message || '流式响应失败' });
          return res.end();
        }
      }
    }

    // 流式输出已锁定的 stream
    if (streamGen && firstChunk !== null) {
      let full = firstChunk;
      send({ type: 'chunk', text: firstChunk });
      try {
        for await (const chunk of streamGen) {
          full += chunk;
          send({ type: 'chunk', text: chunk });
        }
        // 写入缓存
        if (full) setCache(streamCacheMsg, usedProfile.model, full);
        send({ type: 'done' });
        const meta = aiProfileMeta(usedProfile);
        logOperation(username, 'AI 对话（流式）', 'ai', null,
          `tool=${tool || 'chat'}，${historyCount} 轮消息${fallback ? '（故障转移）' : ''}`);
        recordAiUsage({
          profileId: meta.id,
          provider: meta.provider || usedProfile.baseUrl,
          model: usedProfile.model,
          tool: tool || 'chat',
          promptTokens: capturedUsage.prompt_tokens ?? estimateTokens(full),
          completionTokens: capturedUsage.completion_tokens ?? estimateTokens(full),
          totalTokens: capturedUsage.total_tokens ?? estimateTokens(full) + estimateTokens(full),
          promptChars: baseMsgs.reduce((n: number, m: any) => n + String(m.content || '').length, 0),
          completionChars: full.length,
          success: true,
          username,
        });
      } catch (err: any) {
        recordAiUsage({
          profileId: null,
          provider: usedProfile.provider || usedProfile.baseUrl,
          model: usedProfile.model,
          tool: tool || 'chat',
          success: false,
          errorMessage: err?.message || '流式传输中断',
          username,
        });
        send({ type: 'error', message: err?.message || '流式响应失败' });
      }
    }
    res.end();
  }),
);

/**
 * GET /api/ai/usage
 * 返回 AI 用量聚合汇总、按模型分布、按天趋势
 */
router.get(
  '/usage',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      summary: summarizeAiUsage(),
      byModel: listAiUsageByModel(),
      byDay: listAiUsageByDay(30),
    });
  }),
);

/**
 * GET /api/ai/usage/monthly?profileId=xxx
 * 返回指定 profile 当月 token 用量（用于预算进度条）
 */
router.get(
  '/usage/monthly',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const profileId = Number(req.query.profileId);
    if (!Number.isFinite(profileId)) return res.status(400).json({ error: '无效的 profileId' });
    const usage = getMonthlyUsage(profileId);
    res.json(usage);
  }),
);

/**
 * DELETE /api/ai/usage
 * 清空全部 AI 用量记录（需管理员）
 */
router.delete(
  '/usage',
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    clearAiUsage();
    logOperation(res.locals.username, '清空 AI 用量', 'ai', null, '已清空全部 AI 用量统计');
    res.json({ ok: true });
  }),
);

/**
 * GET /api/ai/usage/dashboard
 * 返回仪表盘数据：按天成本趋势 + 按周汇总 + 按模型分布
 */
router.get(
  '/usage/dashboard',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const days = Number(req.query.days) || 30;
    const weeks = Number(req.query.weeks) || 12;
    const byDayCost = listAiUsageByDayWithCost(Math.min(days, 90));
    const byWeek = listAiUsageByWeek(Math.min(weeks, 52));
    const byModel = listAiUsageByModel();
    const summary = summarizeAiUsage();
    const totalCost = byDayCost.reduce((sum, r) => sum + (r.cost || 0), 0);
    res.json({ summary, byDayCost, byWeek, byModel, totalCost });
  }),
);

/**
 * GET /api/ai/usage/performance
 * 返回 AI 性能指标（按模型聚合：成功率、平均 token 等）
 */
router.get(
  '/usage/performance',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const metrics = getAiPerformanceMetrics();
    res.json({ metrics });
  }),
);

// ============ 语义缓存 ============

/**
 * GET /api/ai/cache/stats
 * 返回缓存统计信息
 */
router.get(
  '/cache/stats',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getCacheStats());
  }),
);

/**
 * DELETE /api/ai/cache
 * 清空全部缓存（需管理员）
 */
router.delete(
  '/cache',
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    clearCache();
    logOperation(res.locals.username, '清空 AI 缓存', 'ai', null, '已清空全部 AI 语义缓存');
    res.json({ ok: true });
  }),
);

/**
 * POST /api/ai/local/status
 * 检查本地模型服务状态（Ollama / vLLM / LM Studio）
 */
router.post(
  '/local/status',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const baseUrl = req.body?.baseUrl || '';
    if (!baseUrl) return res.status(400).json({ error: '请提供 baseUrl' });
    const status = await getLocalModelStatus(baseUrl);
    res.json(status);
  }),
);

// ============ Ollama 模型管理 ============

/**
 * GET /api/ai/ollama/status
 * 获取 Ollama 服务状态 + 已安装模型列表
 */
router.get(
  '/ollama/status',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const host = (req.query.host as string) || undefined;
    const status = await getOllamaStatus(host);
    res.json(status);
  }),
);

/**
 * GET /api/ai/ollama/running
 * 获取运行中的模型
 */
router.get(
  '/ollama/running',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const host = (req.query.host as string) || undefined;
    const status = await getOllamaRunning(host);
    res.json(status);
  }),
);

/**
 * POST /api/ai/ollama/pull
 * 拉取模型
 */
router.post(
  '/ollama/pull',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { model, host } = req.body || {};
    if (!model) return res.status(400).json({ error: '请提供模型名称' });
    const result = await pullOllamaModel(model, host);
    logOperation(res.locals.username, 'ai.ollama.pull', `拉取模型 ${model}: ${result.message}`);
    res.json(result);
  }),
);

/**
 * POST /api/ai/ollama/delete
 * 删除模型
 */
router.post(
  '/ollama/delete',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { model, host } = req.body || {};
    if (!model) return res.status(400).json({ error: '请提供模型名称' });
    const result = await deleteOllamaModel(model, host);
    logOperation(res.locals.username, 'ai.ollama.delete', `删除模型 ${model}: ${result.message}`);
    res.json(result);
  }),
);

// ============ 运维知识库 ============

/**
 * GET /api/ai/knowledge
 * 查询知识列表
 */
router.get(
  '/knowledge',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { category, keyword, limit, offset } = req.query as any;
    const result = listKnowledge({
      category: category || undefined,
      keyword: keyword || undefined,
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  }),
);

/**
 * GET /api/ai/knowledge/stats
 * 知识分类统计
 */
router.get(
  '/knowledge/stats',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getKnowledgeStats());
  }),
);

/**
 * GET /api/ai/knowledge/search
 * 全文检索知识（TF-IDF）
 */
router.get(
  '/knowledge/search',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { q, limit } = req.query as any;
    if (!q) return res.status(400).json({ error: '请提供搜索关键词' });
    const results = await searchKnowledge(q, limit ? Number(limit) : 5);
    res.json(results);
  }),
);

/**
 * GET /api/ai/knowledge/:id
 * 获取单条知识
 */
router.get(
  '/knowledge/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const entry = getKnowledge(id);
    if (!entry) return res.status(404).json({ error: '知识条目不存在' });
    res.json(entry);
  }),
);

/**
 * POST /api/ai/knowledge
 * 新增知识条目
 */
router.post(
  '/knowledge',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { title, category, content, tags } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: '标题和内容必填' });
    const entry = await createKnowledge(title, category || 'general', content, tags || []);
    logOperation(res.locals.username, '创建 AI 知识', 'ai', null, `知识#${entry.id}: ${entry.title}`);
    res.json(entry);
  }),
);

/**
 * PUT /api/ai/knowledge/:id
 * 更新知识条目
 */
router.put(
  '/knowledge/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const updated = await updateKnowledge(id, req.body || {});
    if (!updated) return res.status(404).json({ error: '知识条目不存在' });
    logOperation(res.locals.username, '更新 AI 知识', 'ai', null, `知识#${id}: ${updated.title}`);
    res.json(updated);
  }),
);

/**
 * DELETE /api/ai/knowledge/:id
 * 删除知识条目
 */
router.delete(
  '/knowledge/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const ok = deleteKnowledge(id);
    if (!ok) return res.status(404).json({ error: '知识条目不存在' });
    logOperation(res.locals.username, '删除 AI 知识', 'ai', null, `知识#${id}`);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/ai/knowledge/import
 * 批量导入知识条目（JSON 数组）
 */
router.post(
  '/knowledge/import',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '请提供 items 数组' });
    if (items.length > 100) return res.status(400).json({ error: '单次最多导入 100 条' });
    const results: Array<{ ok: boolean; id?: number; title: string; error?: string }> = [];
    for (const item of items) {
      try {
        const title = (item.title || '').trim();
        const content = (item.content || '').trim();
        if (!title || !content) { results.push({ ok: false, title: title || '(空)', error: '标题或内容为空' }); continue; }
        const entry = await createKnowledge(title, item.category || 'general', content, item.tags || []);
        results.push({ ok: true, id: entry.id, title: entry.title });
      } catch (e: any) {
        results.push({ ok: false, title: item.title || '(未知)', error: e?.message || '导入失败' });
      }
    }
    const success = results.filter((r) => r.ok).length;
    logOperation(res.locals.username, '批量导入 AI 知识', 'ai', null, `成功 ${success}/${items.length}`);
    res.json({ total: items.length, success, results });
  }),
);

// ============ Action 审批 ============

/**
 * GET /api/ai/actions
 * 查询待审批操作列表
 */
router.get(
  '/actions',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    const username = res.locals.username;
    let actions;
    if (status === 'all') {
      const d = require('../storage').getDb();
      const rows = d.prepare('SELECT * FROM ai_actions WHERE username = ? ORDER BY created_at DESC LIMIT 50').all(username);
      actions = rows.map((r: any) => ({
        id: r.id,
        username: r.username,
        actionType: r.action_type,
        params: JSON.parse(r.params || '{}'),
        status: r.status,
        aiMessage: r.ai_message,
        result: r.result,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }));
    } else {
      actions = listPendingActions(username);
    }
    res.json({ actions, actionTypes: ACTION_TYPE_LABELS });
  }),
);

/**
 * GET /api/ai/actions/stats
 * 操作审批统计
 */
router.get(
  '/actions/stats',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(getActionStats());
  }),
);

/**
 * POST /api/ai/actions/:id/approve
 * 批准操作
 */
router.post(
  '/actions/:id/approve',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的 ID' });
    const action = getAction(id);
    if (!action) return res.status(404).json({ error: '操作不存在' });
    if (action.username !== res.locals.username) return res.status(403).json({ error: '无权操作' });
    if (action.status !== 'pending') return res.status(400).json({ error: '该操作已处理' });
    const updated = approveAction(id);
    logOperation(res.locals.username, '批准 AI 操作', 'ai', null, `操作 #${id}: ${ACTION_TYPE_LABELS[action.actionType] || action.actionType}`);
    res.json({ ok: true, action: updated });
  }),
);

/**
 * POST /api/ai/actions/:id/reject
 * 拒绝操作
 */
router.post(
  '/actions/:id/reject',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的 ID' });
    const action = getAction(id);
    if (!action) return res.status(404).json({ error: '操作不存在' });
    if (action.username !== res.locals.username) return res.status(403).json({ error: '无权操作' });
    if (action.status !== 'pending') return res.status(400).json({ error: '该操作已处理' });
    const updated = rejectAction(id);
    logOperation(res.locals.username, '拒绝 AI 操作', 'ai', null, `操作 #${id}: ${ACTION_TYPE_LABELS[action.actionType] || action.actionType}`);
    res.json({ ok: true, action: updated });
  }),
);

/**
 * POST /api/ai/actions/:id/execute
 * 执行已批准的 AI 操作
 */
router.post(
  '/actions/:id/execute',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: '无效操作 ID' });
    const action = getAction(id);
    if (!action) return res.status(404).json({ error: '操作不存在' });
    if (action.username !== res.locals.username) return res.status(403).json({ error: '无权操作' });
    if (action.status !== 'approved') return res.status(400).json({ error: `操作状态为 ${action.status}，需先批准` });
    const { executeAction } = await import('../aiActionExecutor');
    const result = await executeAction(id);
    logOperation(res.locals.username, result.ok ? '执行 AI 操作' : '执行 AI 操作（失败）', 'ai', null, `操作 #${id}: ${result.message}`);
    res.json(result);
  }),
);

// ============ 对话历史（会话持久化） ============

/**
 * GET /api/ai/sessions
 * 返回当前用户的会话列表（按更新时间倒序）
 */
router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (keyword) {
      const sessions = searchChatSessions(res.locals.username, keyword);
      res.json({ sessions });
    } else {
      const sessions = listChatSessions(res.locals.username);
      res.json({ sessions });
    }
  }),
);

/**
 * POST /api/ai/sessions
 * body: { title?, tool?, target? } 可选
 * 创建新会话，返回完整会话
 */
router.post(
  '/sessions',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const session = createChatSession(res.locals.username, {
      title: typeof body.title === 'string' ? body.title : undefined,
      tool: typeof body.tool === 'string' ? body.tool : '',
      target: typeof body.target === 'string' ? body.target : '',
    });
    logOperation(res.locals.username, '新建 AI 对话', 'ai', null, `session#${session.id}`);
    res.json(session);
  }),
);

/**
 * GET /api/ai/sessions/:id
 * 获取会话详情（含消息）
 */
router.get(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的会话 ID' });
    const session = getChatSession(id, res.locals.username);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    res.json(session);
  }),
);

/**
 * PUT /api/ai/sessions/:id
 * body: { title? } 或 { messages: [{role,content,error?}] }
 * 更新标题或消息
 */
router.put(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的会话 ID' });
    const body = req.body || {};
    const username = res.locals.username;
    let ok = false;
    if (Array.isArray(body.messages)) {
      const cleaned = body.messages
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m: any) => ({ role: m.role, content: m.content, error: m.error ? true : undefined }));
      ok = updateChatSessionMessages(id, username, cleaned);
    } else if (typeof body.title === 'string') {
      ok = updateChatSessionTitle(id, username, body.title);
    }
    if (!ok) return res.status(404).json({ error: '会话不存在或无权修改' });
    res.json({ ok: true });
  }),
);

/**
 * DELETE /api/ai/sessions/:id
 * 删除会话
 */
router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的会话 ID' });
    const ok = deleteChatSession(id, res.locals.username);
    if (!ok) return res.status(404).json({ error: '会话不存在' });
    logOperation(res.locals.username, '删除 AI 对话', 'ai', null, `session#${id}`);
    res.json({ ok: true });
  }),
);

/**
 * GET /api/ai/sessions/:id/export
 * 导出会话为 Markdown 文件
 */
router.get(
  '/sessions/:id/export',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的会话 ID' });
    const session = getChatSession(id, res.locals.username);
    if (!session) return res.status(404).json({ error: '会话不存在' });

    const lines: string[] = [];
    lines.push(`# ${session.title || 'AI 对话'}`);
    lines.push('');
    lines.push(`> 导出时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    lines.push(`> 消息数：${session.messages.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of session.messages) {
      const role = msg.role === 'user' ? '**用户**' : '**AI 助手**';
      lines.push(`### ${role}`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
      if (msg.error) {
        lines.push('> ⚠️ 此消息包含错误');
        lines.push('');
      }
    }

    const md = lines.join('\n');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-session-${id}.md"`);
    res.send(md);
  }),
);

/**
 * GET /api/ai/sessions/backup
 * 备份当前用户所有会话为 JSON 文件
 */
router.get(
  '/sessions/backup',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = listChatSessions(res.locals.username);
    const fullSessions = sessions.map((s) => getChatSession(s.id, res.locals.username)).filter(Boolean);
    const backup = {
      version: 1,
      username: res.locals.username,
      exportedAt: new Date().toISOString(),
      sessions: fullSessions,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-sessions-backup-${Date.now()}.json"`);
    res.json(backup);
  }),
);

// ============ Prompt 模板 ============

/**
 * GET /api/ai/templates
 * 获取模板列表（可选 ?category=xxx 按分类过滤）
 */
router.get(
  '/templates',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const templates = listTemplates(category, res.locals.username);
    res.json({ templates });
  }),
);

/**
 * GET /api/ai/templates/categories
 * 获取所有分类
 */
router.get(
  '/templates/categories',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const categories = listTemplateCategories();
    res.json({ categories });
  }),
);

/**
 * POST /api/ai/templates
 * 创建自定义模板
 */
router.post(
  '/templates',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!name || !prompt) {
      const e: any = new Error('名称和 prompt 内容不能为空');
      e.statusCode = 400;
      throw e;
    }
    const category = typeof body.category === 'string' ? body.category.trim() : '自定义';
    const t = createTemplate({ name, category, prompt, username: res.locals.username });
    logOperation(res.locals.username, '创建 AI 模板', 'ai', null, `模板#${t.id}: ${t.name}`);
    res.json({ template: t });
  }),
);

/**
 * PUT /api/ai/templates/:id
 * 更新自定义模板（预置模板不可修改）
 */
router.put(
  '/templates/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的模板 ID' });
    const body = req.body || {};
    const input: { name?: string; category?: string; prompt?: string } = {};
    if (body.name !== undefined) input.name = String(body.name).trim();
    if (body.category !== undefined) input.category = String(body.category).trim();
    if (body.prompt !== undefined) input.prompt = String(body.prompt).trim();
    const t = updateTemplate(id, input, res.locals.username);
    if (!t) return res.status(404).json({ error: '模板不存在、是预置模板或无权修改' });
    logOperation(res.locals.username, '更新 AI 模板', 'ai', null, `模板#${t.id}: ${t.name}`);
    res.json({ template: t });
  }),
);

/**
 * DELETE /api/ai/templates/:id
 * 删除自定义模板（预置模板不可删除）
 */
router.delete(
  '/templates/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的模板 ID' });
    const ok = deleteTemplate(id, res.locals.username);
    if (!ok) return res.status(404).json({ error: '模板不存在、是预置模板或无权删除' });
    logOperation(res.locals.username, '删除 AI 模板', 'ai', null, `模板#${id}`);
    res.json({ ok: true });
  }),
);

/**
 * GET /api/ai/templates/export
 * 导出所有自定义模板为 JSON
 */
router.get(
  '/templates/export',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const templates = listTemplates(undefined, res.locals.username);
    const custom = templates.filter((t) => !t.isSystem);
    const data = custom.map((t) => ({ name: t.name, category: t.category, prompt: t.prompt }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ai-templates.json"');
    res.json(data);
  }),
);

/**
 * POST /api/ai/templates/import
 * body: { templates: [{ name, category?, prompt }] } — 批量导入模板（最多 50 条）
 */
router.post(
  '/templates/import',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const arr = Array.isArray(body.templates) ? body.templates : [];
    if (arr.length === 0) return res.status(400).json({ error: '请提供模板数组' });
    if (arr.length > 50) return res.status(400).json({ error: '单次最多导入 50 条模板' });

    let imported = 0;
    const errors: string[] = [];
    for (const item of arr) {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
      if (!name || !prompt) {
        errors.push(`跳过: 名称或内容为空`);
        continue;
      }
      const category = typeof item.category === 'string' ? item.category.trim() : '导入';
      createTemplate({ name, category, prompt, username: res.locals.username });
      imported++;
    }

    logOperation(res.locals.username, '导入 AI 模板', 'ai', null, `导入 ${imported} 个模板`);
    res.json({ imported, errors });
  }),
);

export default router;
