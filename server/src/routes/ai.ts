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
  assertAiEnabled,
  updateAiConfig,
  buildSystemPrompt,
  chatCompletion,
  testAiConnection,
  profileToAiConfig,
} from '../aiClient';
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
import { AI_PRESETS } from '../aiPresets';
import { logOperation } from '../operationLog';
import { requireAdmin, requireAuth } from '../auth';
import { getDockerClient } from '../docker/client';

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

/** /chat 用配置：优先默认 profile，否则回退旧单套配置；两者皆不可用抛 503 */
function assertChatConfig() {
  const prof = getDefaultProfile();
  if (prof) {
    if (!prof.baseUrl || !prof.model) {
      const e: any = new Error('AI 助手默认配置未完成（缺少 baseUrl 或模型）');
      e.statusCode = 503;
      throw e;
    }
    return profileAiConfig()!;
  }
  // 无默认 profile：回退旧单套配置
  return assertAiEnabled();
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

/** 收集运行中容器清单作为 AI 上下文 */
async function fetchContainersContext(): Promise<string> {
  const docker = await getDockerClient();
  const list = (await docker.listContainers({ all: false }).catch(() => [])) as any[];
  const lines = list.map((c: any, i: number) => {
    const name = (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12);
    const ports = Array.isArray(c.Ports)
      ? c.Ports.map((p: any) => (p.PublicPort ? `${p.PrivatePort}->${p.PublicPort}/${p.Type || 'tcp'}` : `${p.PrivatePort}/${p.Type || 'tcp'}`)).join(' ')
      : '';
    return `[${i + 1}] id=${c.Id?.slice(0, 12)} name=${name} image=${c.Image || ''} status=${c.State || ''}${ports ? ` ports=${ports}` : ''}`;
  });
  if (lines.length === 0) return '当前没有运行中的容器。';
  return `以下是当前运行中的容器（共 ${lines.length} 个）：\n${lines.join('\n')}`;
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
    const cfg = assertChatConfig();
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      return res.status(400).json({ error: '缺少 messages' });
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
          return res.status(400).json({ error: 'logs 工具需要指定容器（target）' });
        }
        context = await fetchContainerLogContext(String(target));
        toolContext = context;
      }
    } catch (err: any) {
      // 上下文采集失败不阻断对话，附加提示
      context = `（采集环境上下文失败：${err?.message || err}）`;
    }

    // 用户消息 = 用户文本 + （可选）上下文提示
    const userText = messages.filter((m: any) => m.role === 'user').map((m: any) => m.content).join('\n');
    const finalMessages = buildSystemPrompt(cfg, context, userText || '请继续。');

    const reply = await chatCompletion(cfg, finalMessages);
    logOperation(res.locals.username, 'AI 对话', 'ai', null, `tool=${tool || 'chat'}，输入 ${userText.length} 字`);
    res.json({ enabled: true, reply, toolContext });
  }),
);

export default router;
