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

const router = Router();

/** 构建日志最大收集长度（字符），超长截断防止内存溢出 */
const MAX_LOG_LEN = 200000;

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
 * POST /api/build/image
 * 从指定构建上下文目录构建镜像
 * @body name       镜像名称（可含 tag，如 myapp:latest）
 * @body context    宿主机构建上下文目录（必填，须存在且含 Dockerfile）
 * @body dockerfile 可选：覆盖构建上下文中的 Dockerfile 文件名（默认 Dockerfile）
 * @body args       可选：构建参数（名称 -> 值）
 * @body noCache    可选：构建时忽略缓存
 */
router.post(
  '/image',
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const context = String(body.context || '').trim();
    const dockerfile = String(body.dockerfile || 'Dockerfile').trim() || 'Dockerfile';
    const buildArgs: Record<string, string> = body.args || {};
    const noCache = !!body.noCache;

    // 参数校验
    if (!name) {
      return res.status(400).json({ error: '请填写镜像名称' });
    }
    if (!context) {
      return res.status(400).json({ error: '请填写构建上下文目录' });
    }
    const contextAbs = path.resolve(context);
    const stat = await fs.promises.stat(contextAbs).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return res.status(400).json({ error: `构建上下文目录不存在或不是目录: ${contextAbs}` });
    }
    const dockerfilePath = path.join(contextAbs, dockerfile);
    const dfStat = await fs.promises.stat(dockerfilePath).catch(() => null);
    if (!dfStat || !dfStat.isFile()) {
      return res.status(400).json({ error: `构建上下文目录中缺少 Dockerfile: ${dockerfilePath}` });
    }

    // 构造 buildargs：仅保留有值的参数
    const buildargs: { [key: string]: string } = {};
    for (const [k, v] of Object.entries(buildArgs)) {
      const s = String(v);
      if (s.length > 0) buildargs[k] = s;
    }

    const docker = await getDockerClient();
    const logs: string[] = [];
    let totalLen = 0;
    let error: string | null = null;

    const pushLog = (line: string) => {
      totalLen += line.length;
      if (totalLen > MAX_LOG_LEN) {
        if (!logs.includes('...(日志已截断)')) logs.push('...(日志已截断)');
        return;
      }
      logs.push(line);
    };

    try {
      const stream = await docker.buildImage(
        { context: contextAbs },
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
          // Docker 引擎普通返回 JSON 帧，也可能为纯文本；解析 stream/error 字段
          const json = tryParseJson(text);
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
            const t = text.trim();
            if (t) pushLog(t);
          }
        });
        stream.on('end', () => finish(error ? false : true, error || undefined));
        stream.on('error', (err: any) => {
          pushLog(`[错误] ${err?.message || err}`);
          finish(false, err?.message || '构建失败');
        });
      });

      res.json({
        success: true,
        name,
        logs: logs.slice(-2000),
      });
    } catch (err: any) {
      const msg = err?.message || '构建失败';
      if (!logs.some((l) => l.includes(msg))) {
        pushLog(`[错误] ${msg}`);
      }
      return res.json({
        success: false,
        name,
        logs: logs.slice(-2000),
        error: msg,
      });
    }
  }),
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
