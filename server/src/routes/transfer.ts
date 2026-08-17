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

/**
 * POST /api/transfer/batch
 * 将指定镜像从源引擎批量分发到多个目标引擎（逐个 save→load 流式直通）。
 *
 * 主体与单镜像迁移一致，但对目标引擎列表逐个执行；单个目标失败不影响其它目标，
 * 每个目标单独产出成功/失败结果。
 *
 * @body image           源引擎上的镜像引用（如 nginx:latest）
 * @body sourceEngineId  源引擎 id
 * @body targetEngineIds 目标引擎 id 数组
 * @body tag             （可选）到各目标引擎后的统一标签；未提供时沿用源镜像标签
 */
router.post(
  '/batch',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const { image, sourceEngineId, targetEngineIds, tag } = req.body || {};

    // 参数校验
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: '缺少镜像引用 image' });
    }
    if (!sourceEngineId || typeof sourceEngineId !== 'string') {
      return res.status(400).json({ error: '缺少源引擎 sourceEngineId' });
    }
    const targets: string[] = Array.isArray(targetEngineIds)
      ? (targetEngineIds as unknown[]).filter(
          (t): t is string => typeof t === 'string' && t.length > 0 && t !== (sourceEngineId as string),
        )
      : [];
    if (targets.length === 0) {
      return res.status(400).json({ error: '请至少选择一个与源引擎不同的目标引擎' });
    }

    const d = getDb();
    const srcRow = d
      .prepare('SELECT id, name, endpoint FROM docker_engines WHERE id = ?')
      .get(sourceEngineId) as EngineEndpointRow | undefined;
    if (!srcRow) {
      return res.status(400).json({ error: '源引擎不存在' });
    }

    // 准备目标引擎列表（跳过不存在或等于源引擎的项）
    const targetRows: EngineEndpointRow[] = [];
    for (const id of targets) {
      const row = d
        .prepare('SELECT id, name, endpoint FROM docker_engines WHERE id = ?')
        .get(id) as EngineEndpointRow | undefined;
      if (row) targetRows.push(row);
    }
    if (targetRows.length === 0) {
      return res.status(400).json({ error: '目标引擎均不存在或无效' });
    }

    const srcDocker = getDockerClientForEndpoint(srcRow.endpoint);

    // 逐个目标引擎执行迁移（串行，避免同一源端多个并发 save 占用资源）
    const results: Array<{ engineId: string; name: string; ok: boolean; loaded?: string; error?: string }> = [];
    for (const dst of targetRows) {
      try {
        const dstDocker = getDockerClientForEndpoint(dst.endpoint);
        const stream = await srcDocker.getImage(image).get();
        const out = await dstDocker.loadImage(stream);
        const loadedList = await collectLoadedImages(out);
        const loadedName = loadedList[0] || image;

        // 可选的目标标签重打（失败不阻断）
        if (tag && typeof tag === 'string' && tag.trim() && tag.trim() !== image.split('@')[0]) {
          try {
            await dstDocker.getImage(loadedName).tag({
              repo: tag.split(':')[0],
              tag: tag.includes(':') ? tag.split(':').slice(1).join(':') : 'latest',
            });
          } catch {
            /* 忽略打标签失败 */
          }
        }

        results.push({ engineId: dst.id, name: dst.name, ok: true, loaded: tag && tag.trim() ? tag : loadedName });
        logOperation(res.locals.username, '批量分发镜像', 'image', image, `→ ${dst.name} 成功`);
      } catch (e: any) {
        results.push({ engineId: dst.id, name: dst.name, ok: false, error: e?.message || '分发失败' });
        logOperation(res.locals.username, '批量分发镜像', 'image', image, `→ ${dst.name} 失败: ${e?.message || ''}`, false);
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    res.json({ ok: true, total: results.length, okCount, failedCount: results.length - okCount, results });
  }),
);

/**
 * 判断某引擎是否存在指定镜像引用
 * @param docker 目标 dockerode
 * @param ref 镜像引用（如 nginx:latest）
 * @returns 是否存在
 */
async function imageExistsOn(docker: any, ref: string): Promise<boolean> {
  const imgs = await docker.listImages();
  return (imgs || []).some((i: any) => (i.RepoTags || []).includes(ref));
}

/**
 * 判断字符串是否为 Window 或 POSIX 绝对路径
 * @param s 字符串
 * @returns 是否绝对路径
 */
function isAbsolutePath(s: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/');
}

/**
 * POST /api/transfer/container
 * 跨引擎迁移容器：从源引擎读取容器配置并在目标引擎重建（镜像缺失时自动 save→load 传输）。
 *
 * 首版范围：还原镜像/命令/entrypoint/环境/端口/挂载/重启策略/标签/用户/工作目录/hostname/tty/privileged/autoRemove。
 * 卷处理：
 *  - 源为宿主机绝对路径的绑定挂载 → 原样保留（要求目标引擎可访问该宿主路径）。
 *  - 源为命名卷 → 在目标引擎创建同名卷（空卷；卷数据不随迁移，后续可用卷备份恢复数据）。
 * 网络：container: 引用的网络模式跨引擎不可直接映射，自动降级为 default 并提示。
 *
 * @body containerId   源引擎上要迁移的容器 id
 * @body sourceEngineId 源引擎 id
 * @body targetEngineId 目标引擎 id
 * @body newName        目标容器名（可选，默认沿用原名）
 * @body start          是否启动目标容器（默认 true）
 */
router.post(
  '/container',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const { containerId, sourceEngineId, targetEngineId, newName, start } = req.body || {};
    if (!containerId || typeof containerId !== 'string') {
      return res.status(400).json({ error: '缺少源容器 containerId' });
    }
    if (!sourceEngineId || !targetEngineId) {
      return res.status(400).json({ error: '缺少源引擎或目标引擎' });
    }
    if (sourceEngineId === targetEngineId) {
      return res.status(400).json({ error: '源引擎与目标引擎不能相同' });
    }

    const d = getDb();
    const srcRow = d
      .prepare('SELECT id, name, endpoint FROM docker_engines WHERE id = ?')
      .get(sourceEngineId) as EngineEndpointRow | undefined;
    if (!srcRow) return res.status(400).json({ error: '源引擎不存在' });
    const dstRow = d
      .prepare('SELECT id, name, endpoint FROM docker_engines WHERE id = ?')
      .get(targetEngineId) as EngineEndpointRow | undefined;
    if (!dstRow) return res.status(400).json({ error: '目标引擎不存在' });

    const srcDocker = getDockerClientForEndpoint(srcRow.endpoint);
    const dstDocker = getDockerClientForEndpoint(dstRow.endpoint);

    // 读取源容器完整配置
    let inspect: any;
    try {
      inspect = await srcDocker.getContainer(containerId).inspect();
    } catch {
      return res.status(404).json({ error: '源容器不存在' });
    }
    const srcCfg = inspect.Config || {};
    const hostCfg = inspect.HostConfig || {};

    // 端口映射：HostConfig.PortBindings → dockerode PortMap
    const portMap: Record<string, Array<{ HostIp?: string; HostPort?: string }>> = {};
    const exposedPorts: Record<string, Record<string, unknown>> = {};
    for (const [key, bindings] of Object.entries(hostCfg.PortBindings || {})) {
      exposedPorts[key] = {};
      portMap[key] = (bindings as Array<{ HostIp?: string; HostPort?: string }>).map((b) => ({
        HostIp: b?.HostIp || '0.0.0.0',
        HostPort: b?.HostPort || '',
      }));
    }

    // 挂载：还原绑定/卷
    const binds: string[] = [];
    const namedVolumes: Array<{ name: string; target: string; readonly: boolean }> = [];
    for (const bind of hostCfg.Binds || []) {
      const parts = bind.split(':');
      const source = parts[0] || '';
      const target = parts[1] || bind;
      const readonly = parts.length >= 3 && parts[2] === 'ro';
      if (isAbsolutePath(source)) {
        binds.push(`${source}:${target}${readonly ? ':ro' : ''}`);
      } else if (source) {
        namedVolumes.push({ name: source, target, readonly });
      } else {
        binds.push(bind);
      }
    }

    // 确保目标镜像存在（缺失则流式 save→load）
    const imageRef = srcCfg?.Image || '';
    let imageReady = imageRef ? await imageExistsOn(dstDocker, imageRef) : false;
    if (imageRef && !imageReady) {
      try {
        const stream = await srcDocker.getImage(imageRef).get();
        const out = await dstDocker.loadImage(stream);
        await collectLoadedImages(out);
        imageReady = true;
      } catch (err: any) {
        return res.status(500).json({ error: `镜像 ${imageRef} 传输失败: ${err?.message || err}` });
      }
    }

    // 目标容器名
    const desiredName = newName && String(newName).trim()
      ? String(newName).trim()
      : String(inspect.Name || '').replace(/^\//, '');

    // 网络模式：container: 引用跨引擎不可直接用，降级为 default
    let networkMode: string = hostCfg.NetworkMode || 'default';
    let networkWarn = '';
    if (/^container:/.test(networkMode)) {
      networkMode = 'default';
      networkWarn = `源容器网络模式为 ${hostCfg.NetworkMode}，跨引擎无法复用，已降级为 default`;
    }

    // 在目标引擎创建同名卷（空卷）
    for (const nv of namedVolumes) {
      try {
        await dstDocker.createVolume({ Name: nv.name });
      } catch {
        // 已存在或创建失败均忽略（存在则复用）
      }
      binds.push(`${nv.name}:${nv.target}${nv.readonly ? ':ro' : ''}`);
    }

    const createOpts: any = {
      name: desiredName,
      Image: imageRef || undefined,
      Cmd: Array.isArray(srcCfg.Cmd) && srcCfg.Cmd.length ? srcCfg.Cmd : undefined,
      Entrypoint: Array.isArray(srcCfg.Entrypoint) && srcCfg.Entrypoint.length ? srcCfg.Entrypoint : srcCfg.Entrypoint || undefined,
      User: srcCfg.User || undefined,
      WorkingDir: srcCfg.WorkingDir || undefined,
      Hostname: srcCfg.Hostname || undefined,
      Labels: srcCfg.Labels || undefined,
      Env: Array.isArray(srcCfg.Env) && srcCfg.Env.length ? srcCfg.Env : undefined,
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      HostConfig: {
        Binds: binds.length ? binds : undefined,
        PortBindings: Object.keys(portMap).length ? portMap : undefined,
        RestartPolicy: hostCfg.RestartPolicy?.Name ? { Name: hostCfg.RestartPolicy.Name, MaximumRetryCount: hostCfg.RestartPolicy.MaximumRetryCount || 0 } : undefined,
        NetworkMode: networkMode,
        Privileged: hostCfg.Privileged === true,
        AutoRemove: hostCfg.AutoRemove === true,
        Memory: hostCfg.Memory || undefined,
        NanoCpus: hostCfg.NanoCpus || undefined,
      },
      Tty: !!srcCfg.Tty,
    };

    let container: any;
    try {
      container = await dstDocker.createContainer(createOpts);
    } catch (err: any) {
      return res.status(500).json({ error: `目标引擎创建容器失败: ${err?.message || err}` });
    }
    const shouldStart = start !== false;
    let started = false;
    let startError: string | undefined;
    if (shouldStart) {
      try {
        await container.start();
        started = true;
      } catch (err: any) {
        startError = err?.message || '启动失败';
      }
    }

    const id = container.id;
    logOperation(
      res.locals.username,
      '跨引擎迁移容器',
      'container',
      desiredName,
      `${srcRow.name} → ${dstRow.name}${started ? '（已启动）' : startError ? '（启动失败）' : '（未启动）'}`,
      started,
    );
    res.json({
      ok: true,
      id,
      name: desiredName,
      imageTransferred: imageRef && !imageReady ? true : false,
      started,
      startError,
      warnings: [],
      ...(networkWarn ? { warning: networkWarn } : {}),
      note:
        '命名卷将创建为空卷，数据未随迁移迁移。如需恢复卷数据，请在目标引擎用卷备份恢复。',
    });
  }),
);

export default router;
