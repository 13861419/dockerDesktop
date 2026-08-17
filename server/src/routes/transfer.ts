/**
 * 镜像跨引擎迁移 API 路由（挂载路径 /api/transfer）
 *
 * 提供将某个引擎上的镜像（docker save）直接以流式方式喂给另一个引擎（docker load）
 * 的能力，实现镜像在多个 Docker 引擎之间的迁移。全程使用管道直通，不把整份 tar
 * 读入内存，适合大镜像。引擎信息来自 docker_engines 表，按源/目标引擎 id 分别建立
 * 独立的 dockerode 实例（通过 getDockerClientForEndpoint），不影响"当前引擎"。
 */
import { Router, Request, Response } from 'express';
import { getDb } from '../storage';
import { getDockerClientForEndpoint } from '../docker/client';
import { logOperation } from '../operationLog';
import { requireOperator } from '../auth';

const router = Router();

/** 引擎行结构（仅取需要的字段） */
interface EngineEndpointRow {
  id: string;
  name: string;
  endpoint: string;
}

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
 * 解析 docker load 返回的响应流，提取"Loaded image: xxx"信息
 * @param stream docker load 输出的可读流（每行一个 JSON 对象）
 * @returns 提取到的已加载镜像引用列表
 */
function collectLoadedImages(stream: NodeJS.ReadableStream): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const loaded: string[] = [];
    let buffer = '';
    let settled = false;
    // 结束时的兜底回调，保证只结算一次
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(loaded);
    };
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      // 按换行切分 JSON 行
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const json = JSON.parse(line);
          const text = json?.stream || json?.status || json?.aux?.Digest || '';
          if (typeof text === 'string' && /Loaded image:/i.test(text)) {
            const m = text.match(/Loaded image:\s*(.+)/i);
            if (m?.[1]) loaded.push(m[1].trim());
          }
        } catch {
          /* 忽略非 JSON 行（如纯文本提示） */
        }
      }
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * POST /api/transfer/images
 * 将镜像从源引擎迁移到目标引擎（源端 docker save → 目标端 docker load，流式直通）
 * @body image          源引擎上的镜像引用（如 nginx:latest）
 * @body sourceEngineId 源引擎 id
 * @body targetEngineId 目标引擎 id
 * @body tag            目标引擎上的目标标签（可选，默认沿用源镜像的标签）
 */
router.post(
  '/images',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const { image, sourceEngineId, targetEngineId, tag } = req.body || {};

    // 参数校验
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: '缺少镜像引用 image' });
    }
    if (!sourceEngineId || !targetEngineId) {
      return res.status(400).json({ error: '缺少源引擎或目标引擎' });
    }
    if (sourceEngineId === targetEngineId) {
      return res.status(400).json({ error: '源引擎与目标引擎不能相同' });
    }

    const d = getDb();
    // 按 id 查询源/目标引擎的端点
    const srcRow = d
      .prepare('SELECT id, name, endpoint FROM docker_engines WHERE id = ?')
      .get(sourceEngineId) as EngineEndpointRow | undefined;
    if (!srcRow) {
      return res.status(400).json({ error: '源引擎不存在' });
    }
    const dstRow = d
      .prepare('SELECT id, name, endpoint FROM docker_engines WHERE id = ?')
      .get(targetEngineId) as EngineEndpointRow | undefined;
    if (!dstRow) {
      return res.status(400).json({ error: '目标引擎不存在' });
    }

    // 分别建立源/目标引擎的 dockerode 实例
    const srcDocker = getDockerClientForEndpoint(srcRow.endpoint);
    const dstDocker = getDockerClientForEndpoint(dstRow.endpoint);

    try {
      // 源引擎 docker save：得到 tar 格式的可读流（不会把整份 tar 读入内存）
      const stream = await srcDocker.getImage(image).get();
      // 目标引擎 docker load：把 save 流直接喂给 loadImage，实现流式直通
      const out = await dstDocker.loadImage(stream);
      // 解析 load 输出的"Loaded image: xxx"信息
      const loadedList = await collectLoadedImages(out);
      const loadedName = loadedList[0] || image;

      // 若指定了目标 tag 且与源不同，在目标引擎上为已加载镜像重新打 tag（容错：失败不阻断）
      if (tag && typeof tag === 'string' && tag.trim() && tag.trim() !== image.split('@')[0]) {
        try {
          await dstDocker.getImage(loadedName).tag({ repo: tag.split(':')[0], tag: tag.includes(':') ? tag.split(':').slice(1).join(':') : 'latest' });
        } catch {
          /* 打 tag 失败不影响迁移成功的整体结果 */
        }
      }

      logOperation(
        res.locals.username,
        '跨引擎迁移镜像',
        'image',
        image,
        `从 ${srcRow.name} 迁移到 ${dstRow.name}，目标标签: ${tag || image}`,
      );
      return res.json({ ok: true, loaded: tag && tag.trim() ? tag : loadedName });
    } catch (e: any) {
      const msg = e?.message || '镜像迁移失败';
      logOperation(
        res.locals.username,
        '跨引擎迁移镜像',
        'image',
        image,
        `失败: ${msg}`,
        false,
      );
      return res.json({ ok: false, error: msg });
    }
  }),
);

export default router;
