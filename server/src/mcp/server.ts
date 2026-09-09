/**
 * MCP（Model Context Protocol）服务端 — Streamable HTTP 传输
 *
 * 端点：POST /api/mcp（JSON-RPC 2.0，响应按客户端 Accept 返回 SSE 单消息流或 JSON）
 * 鉴权：Authorization: Bearer <mcp.token>，且 mcp.enabled 开启；
 *       未启用/未配置 Token 时端点整体 404（不暴露能力）。
 * 会话：无状态（stateless），每次请求独立处理，不做会话保持。
 * 留痕：每次 tools/call 写入操作日志（操作人 = mcp）。
 *
 * 管理端点（复用会话鉴权，供设置页使用）：
 *  - GET  /api/mcp/status  → { enabled, tokenSet, endpoint }
 *  - POST /api/mcp/token   → 生成并保存新 Token（body.token 可选自定义）
 *
 * 支持方法：initialize / ping / tools/list / tools/call / notifications/*
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getSetting, setSetting } from '../settings';
import { requireAdmin, requireAuth } from '../auth';
import { logOperation } from '../operationLog';
import { mcpTools } from './tools';

const router = Router();

/** MCP 协议版本（2024-11-05 spec；initialize 时回显客户端版本以最大化兼容） */
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'docker-manager-mcp', version: '1.0.0' };

/** 是否启用 MCP */
export function isMcpEnabled(): boolean {
  return getSetting<boolean>('mcp.enabled') === true;
}

/** 读取当前 MCP Token */
function currentToken(): string {
  return String(getSetting<string>('mcp.token') || '');
}

/**
 * 生成随机 MCP Token（64 位 hex）
 */
export function generateMcpToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Bearer Token 常量时间比较
 */
function authorize(req: Request): boolean {
  const expected = currentToken();
  if (!expected) return false;
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!provided || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/** 构造 JSON-RPC 成功响应体 */
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** 构造 JSON-RPC 错误响应体 */
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * 按客户端 Accept 回写响应：默认 SSE 单消息流（spec 推荐），纯 JSON 客户端回 JSON
 */
function sendRpc(req: Request, res: Response, body: Record<string, unknown>): void {
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/event-stream')) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
  } else {
    res.status(200).json(body);
  }
}

/** MCP 主端点（自带 Token 鉴权，不走会话中间件） */
router.post('/', (req: Request, res: Response) => {
  // 未启用或未配置 Token：端点整体不暴露
  if (!isMcpEnabled() || !currentToken()) {
    return res.status(404).json({ error: 'MCP 服务未启用' });
  }
  if (!authorize(req)) {
    return res.status(401).json({ error: 'MCP Token 无效' });
  }

  const body: any = req.body;
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0' || !body.method) {
    return res.status(400).json(rpcError(null, -32600, 'Invalid Request'));
  }

  // 通知类消息（无 id）不回包
  if (body.id === undefined && String(body.method).startsWith('notifications/')) {
    return res.status(202).end();
  }
  const id = body.id ?? null;
  res.setHeader('Mcp-Session-Id', crypto.randomBytes(16).toString('hex'));

  switch (body.method) {
    case 'initialize': {
      const clientProtocol = String(body.params?.protocolVersion || '');
      sendRpc(req, res, rpcResult(id, {
        protocolVersion: clientProtocol || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      }));
      return;
    }
    case 'ping': {
      sendRpc(req, res, rpcResult(id, {}));
      return;
    }
    case 'tools/list': {
      sendRpc(req, res, rpcResult(id, {
        tools: mcpTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }));
      return;
    }
    case 'tools/call': {
      const name = String(body.params?.name || '');
      const tool = mcpTools.find((t) => t.name === name);
      if (!tool) {
        sendRpc(req, res, rpcError(id, -32602, `未知工具: ${name}`));
        return;
      }
      Promise.resolve(tool.handler(body.params?.arguments || {}))
        .then((text) => {
          sendRpc(req, res, rpcResult(id, { content: [{ type: 'text', text }] }));
        })
        .catch((err) => {
          logOperation('mcp', 'MCP 工具调用', 'mcp', name, String(err?.message || err).slice(0, 200), false);
          sendRpc(req, res, rpcResult(id, {
            content: [{ type: 'text', text: `工具执行失败: ${String(err?.message || err)}` }],
            isError: true,
          }));
        });
      return;
    }
    default:
      sendRpc(req, res, rpcError(id, -32601, `方法不存在: ${body.method}`));
  }
});

// Streamable HTTP：GET（服务器单向流）在无状态实现中不支持；DELETE（会话终止）直接放行
router.get('/', (_req: Request, res: Response) => {
  res.status(405).json({ error: 'Method Not Allowed（请使用 POST）' });
});
router.delete('/', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

/** GET /status — 设置页展示 MCP 状态（管理员） */
router.get('/status', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  res.json({
    enabled: isMcpEnabled(),
    tokenSet: !!currentToken(),
    endpoint: '/api/mcp',
  });
});

/** POST /token — 生成（或手填）并保存 MCP Token（管理员；Token 仅本次响应回显） */
router.post('/token', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const custom = String(req.body?.token || '').trim();
  if (custom && custom.length < 16) {
    return res.status(400).json({ error: '自定义 Token 长度至少 16 位' });
  }
  const token = custom || generateMcpToken();
  setSetting('mcp.token', token);
  logOperation(res.locals.username, '生成 MCP Token', 'system', 'mcp.token', '', true);
  res.json({ ok: true, token });
});

export default router;
