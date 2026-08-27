/**
 * Dockerfile 独立镜像构建路由
 *
 * 通过 dockerode buildImage，以宿主机上指定目录为构建上下文执行镜像构建，
 * 返回完整构建日志。默认请求 Docker 经典构建器（version: "1"）以获得可逐行解析的输出。
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDockerClient } from '../docker/client';
import { requireAdmin, requireAuth } from '../auth';
import { logOperation } from '../operationLog';
import { getDb } from '../storage';

const router = Router();

/** 构建日志最大收集长度（字符），超长截断防止内存溢出 */
const MAX_LOG_LEN = 200000;

/** 历史记录保留的日志预览长度（取日志尾部，避免大字段） */
const LOG_PREVIEW_LEN = 4000;

/**
 * 统一兜底错误处理
 * @param fn 异步处理函数
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 写一条镜像构建历史记录
 * @param name 镜像名称
 * @param context 构建上下文目录
 * @param dockerfile Dockerfile 文件名
 * @param success 是否成功
 * @param logs 完整构建日志（内部截取预览）
 * @param durationMs 构建耗时（毫秒）
 */
function recordBuildHistory(
  name: string,
  context: string,
  dockerfile: string,
  success: boolean,
  logs: string[],
  durationMs: number,
): void {
  try {
    const preview = logs.slice(-200).join('\n').slice(-LOG_PREVIEW_LEN);
    getDb()
      .prepare(
        'INSERT INTO image_build_history (name, context, dockerfile, success, log_preview, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(name, context, dockerfile, success ? 1 : 0, preview, durationMs, Math.floor(Date.now() / 1000));
  } catch {
    // 历史写入失败不应影响构建结果返回
  }
}

/**
 * GET /api/build/history
 * 分页返回镜像构建历史（倒序）
 * @query limit 条数（默认 50）
 * @query offset 偏移（默认 0）
 */
router.get(
  '/history',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const rows = getDb()
      .prepare(
        'SELECT id, name, context, dockerfile, success, log_preview, duration_ms, created_at FROM image_build_history ORDER BY id DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as any[];
    res.json({ success: true, list: rows });
  }),
);

/**
 * DELETE /api/build/history
 * 清空全部构建历史（仅管理员）
 */
router.delete(
  '/history',
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    getDb().prepare('DELETE FROM image_build_history').run();
    res.json({ success: true, message: '构建历史已清空' });
  }),
);

/**
 * 构建参数
 */
interface BuildParams {
  name: string;
  context: string;
  dockerfile: string;
  buildargs: Record<string, string>;
  noCache: boolean;
  username: string;
}

/**
 * 执行镜像构建的核心流程（同步收集日志 / SSE 流式推送共用）
 *
 * @param params 构建参数
 * @param onLog 每解析出一行构建日志的回调（SSE 模式逐行推送；JSON 模式传 noop）
 * @returns 构建结果：success / error / 完整日志 / 耗时
 */
async function executeBuild(
  params: BuildParams,
  onLog: (line: string) => void,
): Promise<{ success: boolean; error?: string; logs: string[]; durationMs: number }> {
  const { name, context, dockerfile, buildargs, noCache, username } = params;
  const startedAt = Date.now();
  const docker = await getDockerClient();
  const logs: string[] = [];
  let totalLen = 0;
  let error: string | null = null;

  const pushLog = (line: string) => {
    totalLen += line.length;
    if (totalLen > MAX_LOG_LEN) {
      const truncated = '...(日志已截断)';
      if (!logs.includes(truncated)) {
        logs.push(truncated);
        onLog(truncated);
      }
      return;
    }
    logs.push(line);
    onLog(line);
  };

  try {
    const stream = await docker.buildImage(
      { context, src: ['.'] },
      {
        t: name,
        dockerfile,
        buildargs: Object.keys(buildargs).length ? buildargs : undefined,
        nocache: noCache,
        // 请求经典构建器以获得可逐行解析的 JSON 帧输出
        version: '1',
      },
    );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, msg?: string) => {
        if (settled) return;
        settled = true;
        if (ok) resolve();
        else reject(new Error(msg || '构建失败'));
      };

      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        // 一次 chunk 可能包含多个 JSON 帧（以 \r\n 分隔），按行拆分逐帧解析
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          const json = tryParseJson(t);
          if (json) {
            if (json.error) {
              error = json.error;
              pushLog(`[错误] ${json.error}`);
            }
            if (typeof json.stream === 'string' && json.stream.trim()) {
              pushLog(json.stream.trimEnd());
            }
            if (json.status && !json.progressDetail) {
              const id = json.id ? `#${json.id} ` : '';
              pushLog(`${id}${json.status}`);
            }
            if (json.aux?.ID) {
              pushLog(`已生成镜像: ${json.aux.ID}`);
            }
          } else {
            pushLog(t);
          }
        }
      });
      stream.on('end', () => finish(error ? false : true, error || undefined));
      stream.on('error', (err: any) => {
        pushLog(`[错误] ${err?.message || err}`);
        finish(false, err?.message || '构建失败');
      });
    });

    logOperation(username, '构建镜像', 'image', name, `上下文: ${context}; Dockerfile: ${dockerfile}; noCache: ${noCache}`);
    recordBuildHistory(name, context, dockerfile, true, logs, Date.now() - startedAt);
    return { success: true, logs, durationMs: Date.now() - startedAt };
  } catch (err: any) {
    const msg = err?.message || '构建失败';
    if (!logs.some((l) => l.includes(msg))) {
      pushLog(`[错误] ${msg}`);
    }
    recordBuildHistory(name, context, dockerfile, false, logs, Date.now() - startedAt);
    return { success: false, error: msg, logs, durationMs: Date.now() - startedAt };
  }
}

/**
 * 校验并归一化构建参数
 * @param body 请求体
 * @returns 校验失败返回错误消息；成功返回归一化参数
 */
function normalizeBuildParams(body: any): { error?: string; params?: BuildParams } {
  const name = String(body?.name || '').trim();
  const context = String(body?.context || '').trim();
  const dockerfile = String(body?.dockerfile || 'Dockerfile').trim() || 'Dockerfile';
  const buildArgs: Record<string, string> = body?.args || {};
  const noCache = !!body?.noCache;

  if (!name) return { error: '请填写镜像名称' };
  if (!context) return { error: '请填写构建上下文目录' };
  const contextAbs = path.resolve(context);
  const stat = fs.statSync(contextAbs, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    return { error: `构建上下文目录不存在或不是目录: ${contextAbs}` };
  }
  const dockerfilePath = path.join(contextAbs, dockerfile);
  const dfStat = fs.statSync(dockerfilePath, { throwIfNoEntry: false });
  if (!dfStat || !dfStat.isFile()) {
    return { error: `构建上下文目录中缺少 Dockerfile: ${dockerfilePath}` };
  }
  // 构造 buildargs：仅保留有值的参数
  const buildargs: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(buildArgs)) {
    const s = String(v);
    if (s.length > 0) buildargs[k] = s;
  }
  return { params: { name, context: contextAbs, dockerfile, buildargs, noCache, username: '' } };
}

/**
 * POST /api/build/image
 * 从指定构建上下文目录构建镜像（阻塞式，返回完整日志）
 * @body name       镜像名称（可含 tag，如 myapp:latest）
 * @body context    宿主机构建上下文目录（必填，须存在且含 Dockerfile）
 * @body dockerfile 可选：覆盖构建上下文中的 Dockerfile 文件名（默认 Dockerfile）
 * @body args       可选：构建参数（名称 -> 值）
 * @body noCache    可选：构建时忽略缓存
 */
router.post(
  '/image',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { error, params } = normalizeBuildParams(req.body || {});
    if (error || !params) {
      return res.status(400).json({ error: error || '参数错误' });
    }
    params.username = res.locals.username;
    const result = await executeBuild(params, () => {});
    res.json({
      success: result.success,
      name: params.name,
      logs: result.logs.slice(-2000),
      error: result.error,
    });
  }),
);

/**
 * POST /api/build/image/stream
 * SSE 流式构建：逐行推送构建日志（配合前端 fetch 流式读取，EventSource 不支持 POST）。
 * 事件帧：
 *  - { type: 'log', text }       构建日志行
 *  - { type: 'done', success, name, durationMs, error? } 构建结束
 */
router.post(
  '/image/stream',
  requireAdmin,
  (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (payload: Record<string, unknown>) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const { error, params } = normalizeBuildParams(req.body || {});
    if (error || !params) {
      send({ type: 'done', success: false, name: String(req.body?.name || ''), error: error || '参数错误' });
      res.end();
      return;
    }
    params.username = res.locals.username;
    send({ type: 'start', name: params.name });

    executeBuild(params, (line) => send({ type: 'log', text: line }))
      .then((result) => {
        send({
          type: 'done',
          success: result.success,
          name: params.name,
          durationMs: result.durationMs,
          error: result.error,
        });
        res.end();
      })
      .catch((err) => {
        send({ type: 'done', success: false, name: params.name, error: err?.message || '构建失败' });
        res.end();
      });
  },
);

/**
 * 尝试解析 JSON 字符串，失败返回 null
 * @param text 输入
 * @returns 解析结果或 null
 */
function tryParseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default router;
