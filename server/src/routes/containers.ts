/**
 * 容器管理 API 路由
 *
 * 提供容器的列表、启停、删除、日志、详情、创建等接口。
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { parseStats } from '../docker/stats';
import Dockerode from 'dockerode';
import { logOperation } from '../operationLog';

const router = Router();

/**
 * 从容器对象中提取精简的展示信息
 * @param container dockerode 容器对象
 * @param info 容器的详情信息（可选）
 * @returns 精简容器信息
 */
async function formatContainer(container: Dockerode.Container, info?: Dockerode.ContainerInspectInfo) {
  const inspect = info || (await container.inspect());
  return {
    id: inspect.Id,
    idShort: inspect.Id.slice(0, 12),
    name: (inspect.Name || '').replace(/^\//, ''),
    image: inspect.Config?.Image || '',
    imageId: inspect.Image || '',
    state: inspect.State?.Status || '',
    running: inspect.State?.Running || false,
    restarting: inspect.State?.Restarting || false,
    exited: inspect.State?.Status === 'exited',
    created: inspect.Created,
    startedAt: inspect.State?.StartedAt || '',
    exitCode: inspect.State?.ExitCode ?? null,
    ports: Object.entries(inspect.NetworkSettings?.Ports || {}).map(([port, bindings]) => ({
      internal: port,
      published: (bindings || []).map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`),
    })),
    // 根据配置生成一个主映射端口（用于列表展示）
    mainPort: buildMainPort(inspect.NetworkSettings?.Ports),
    networks: Object.keys(inspect.NetworkSettings?.Networks || {}),
    labels: inspect.Config?.Labels || {},
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
    command: (inspect.Config?.Cmd || []).join(' '),
  };
}

/**
 * 计算容器列表展示用的主端口（取第一个映射端口）
 * @param ports 端口映射对象
 * @returns 形如 "8080:80" 的字符串，无映射时返回空串
 */
function buildMainPort(ports: Dockerode.PortMap | undefined): string {
  if (!ports) return '';
  const entries = Object.entries(ports);
  if (entries.length === 0) return '';
  const [internal, bindings] = entries[0];
  if (!bindings || bindings.length === 0) return internal;
  const b = bindings[0];
  return `${b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '::' ? b.HostIp + ':' : ''}${b.HostPort}:${internal}`;
}

/**
 * 解析 Docker 多路复用日志流（stdout+stderr 混合时的 8 字节帧头）。
 * 逐行产生字符串，通过回调对外返回。
 *
 * Docker 日志帧格式：1 字节流类型(1=stdout,2=stderr) + 3 字节保留 + 4 字节长度 + 内容
 * @param stream dockerode 返回的日志流
 * @param onLine 每行内容回调 (text, streamType)
 */
function demuxLogStream(stream: NodeJS.ReadableStream, onLine: (text: string, streamType: number) => void): void {
  let buffer = Buffer.alloc(0);

  const tryParse = () => {
    while (buffer.length >= 8) {
      const streamType = buffer[0];
      const payloadLen = buffer.readUInt32BE(4);
      if (buffer.length < 8 + payloadLen) break;
      const payload = buffer.subarray(8, 8 + payloadLen).toString('utf8');
      buffer = buffer.subarray(8 + payloadLen);
      // 按行拆解（保留换行）
      let last = 0;
      for (let i = 0; i <= payload.length; i++) {
        if (i === payload.length || payload[i] === '\n') {
          if (i > last) {
            onLine(payload.slice(last, i), streamType);
          }
          last = i + 1;
        }
      }
    }
  };

  stream.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryParse();
  });

  stream.on('error', () => {
    buffer = Buffer.alloc(0);
  });
}

/** SSE 保活心跳间隔（毫秒） */
const PING_INTERVAL_MS = 15000;

/**
 * 统一兜底错误处理，保证所有异步路由异常都能被捕获并返回 JSON
 * @param fn 异步处理函数
 * @returns Express 中间件
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<any>,
  onFail?: (req: Request, err: any) => { action: string; targetType: string; targetName?: string | null; detail?: string | null } | null,
) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      // 操作失败：若提供了 onFail，则记录一条失败审计日志
      if (onFail) {
        try {
          const meta = onFail(req, err);
          if (meta) {
            logOperation(
              res.locals.username,
              meta.action,
              meta.targetType,
              meta.targetName ?? null,
              `失败: ${meta.detail || err?.message || '未知错误'}`,
              false,
            );
          }
        } catch {
          // 记录日志失败不影响错误响应
        }
      }
      const status = err?.statusCode || (err?.statusCode === 404 ? 404 : 500);
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

// ============ 容器列表 ============

/**
 * GET /api/containers?all=true
 * 获取容器列表，可通过 all 参数控制是否包含已停止容器
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const all = req.query.all !== 'false';
    const containers = await docker.listContainers({ all });
    res.json(containers);
  }),
);

// ============ 容器端口占用检测 ============

/**
 * GET /api/containers/ports
 * 返回宿主机端口占用映射，用于检测端口冲突。
 * 逐个遍历所有容器，收集每个容器发布的 HostPort，构建以 HostPort 为键的占用列表。
 * 注意：该静态路由必须放在 /:id 之前，否则会被 /:id 遮蔽。
 */
router.get(
  '/ports',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const containers = await docker.listContainers({ all: true });
    // 预收集所有容器的端口占用，便于后续筛除自身
    const entries: Array<{ id: string; name: string; hostPorts: Set<string> }> = containers.map((c) => {
      const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '');
      const hostPorts = new Set<string>();
      // 从列表返回的 Ports（已发布的映射）收集 HostPort
      for (const p of c.Ports || []) {
        if (p.PublicPort !== undefined && p.PublicPort !== null) {
          hostPorts.add(String(p.PublicPort));
        }
      }
      return { id: c.Id, name, hostPorts };
    });

    // 构建 HostPort -> 占用该端口的容器列表
    const portMap: Record<string, Array<{ containerId: string; containerName: string }>> = {};
    for (const e of entries) {
      for (const hostPort of e.hostPorts) {
        // 该端口已被其他容器占用，则将本容器记入该端口的占用者
        if (!portMap[hostPort]) portMap[hostPort] = [];
        portMap[hostPort].push({ containerId: e.id, containerName: e.name });
      }
    }
    // 仅保留存在冲突（占用者 >= 2）的端口
    const conflicts: Record<string, Array<{ containerId: string; containerName: string }>> = {};
    for (const [hostPort, owners] of Object.entries(portMap)) {
      if (owners.length >= 2) {
        conflicts[hostPort] = owners;
      }
    }
    res.json(conflicts);
  }),
);

// ============ 容器批量统计 ============

/**
 * GET /api/containers/stats
 * 批量获取所有运行中容器的实时资源统计（CPU / 内存百分比/用量）。
 * 返回：{ [containerId]: ParsedStats }
 * 注意：该静态路由必须放在 /:id 之前，否则会被 /:id 遮蔽（与 /ports 同段）。
 */
router.get(
  '/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    // 只统计 running 状态的容器（stats 对停止容器无意义且报错）
    const list = await docker.listContainers({ all: false });
    const running = (list || [])
      .map((c: any) => c.Id)
      .filter((id: string | undefined): id is string => !!id);
    // 并发拉取各容器 stats，逐项降级容错
    const entries = await Promise.all(
      running.map(async (id: string) => {
        let stats: any = null;
        try {
          stats = await docker.getContainer(id).stats({ stream: false });
        } catch {
          // 单个失败不影响整体
        }
        return [id, stats ? parseStats(stats) : null] as const;
      }),
    );
    const result: Record<string, any> = {};
    for (const [id, s] of entries) {
      if (s) result[id] = s;
    }
    res.json(result);
  }),
);

// ============ 容器详情 ============

/**
 * GET /api/containers/:id
 * 获取单个容器的详细信息
 */
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    const inspected = await container.inspect();
    res.json(await formatContainer(container, inspected));
  }),
);

// ============ 容器启停/删除 ============

/**
 * POST /api/containers/:id/start
 * 启动容器
 */
router.post(
  '/:id/start',
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const id = req.params.id;
      await docker.getContainer(id).start();
      logOperation(res.locals.username, '启动容器', 'container', id);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '启动容器', targetType: 'container', targetName: req.params.id }),
  ),
);

/**
 * POST /api/containers/:id/stop
 * 停止容器，可通过 body 传入 timeout（秒）
 */
router.post(
  '/:id/stop',
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const timeout = req.body?.timeout || 10;
      const id = req.params.id;
      await docker.getContainer(id).stop({ t: timeout });
      logOperation(res.locals.username, '停止容器', 'container', id);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '停止容器', targetType: 'container', targetName: req.params.id }),
  ),
);

/**
 * POST /api/containers/:id/restart
 * 重启容器
 */
router.post(
  '/:id/restart',
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const id = req.params.id;
      await docker.getContainer(id).restart();
      logOperation(res.locals.username, '重启容器', 'container', id);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '重启容器', targetType: 'container', targetName: req.params.id }),
  ),
);

/**
 * POST /api/containers/:id/rename
 * 重命名容器
 * body: { name: string } 新名称（dockerode 的 rename 要求不带前导斜杠）
 */
router.post(
  '/:id/rename',
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const rawName = (req.body?.name || '').toString().trim();
      // 名称必填校验
      if (!rawName) {
        res.status(400).json({ error: '新名称不能为空' });
        return;
      }
      // 去除非法的前导斜杠，避免传入 "/name" 导致错误
      const name = rawName.replace(/^\/+/, '');
      const id = req.params.id;
      await docker.getContainer(id).rename({ name });
      logOperation(res.locals.username, '重命名容器', 'container', id, `新名称: ${name}`);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '重命名容器', targetType: 'container', targetName: req.params.id }),
  ),
);

/**
 * POST /api/containers/:id/pause
 * 暂停容器
 */
router.post(
  '/:id/pause',
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const id = req.params.id;
      await docker.getContainer(id).pause();
      logOperation(res.locals.username, '暂停容器', 'container', id);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '暂停容器', targetType: 'container', targetName: req.params.id }),
  ),
);

/**
 * POST /api/containers/:id/unpause
 * 恢复（取消暂停）容器
 */
router.post(
  '/:id/unpause',
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const id = req.params.id;
      await docker.getContainer(id).unpause();
      logOperation(res.locals.username, '恢复容器', 'container', id);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '恢复容器', targetType: 'container', targetName: req.params.id }),
  ),
);

/**
 * DELETE /api/containers/:id?force=true&v=true
 * 删除容器，force 强制删除，v 同时删除匿名卷
 */
router.delete(
  '/:id',
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const force = req.query.force === 'true';
      const v = req.query.v === 'true';
      const id = req.params.id;
      await docker.getContainer(id).remove({ force, v });
      logOperation(res.locals.username, '删除容器', 'container', id, force ? '强制删除' : '');
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '删除容器', targetType: 'container', targetName: req.params.id }),
  ),
);

/**
 * POST /api/containers/:id/prune
 * 清理该容器的已停止状态（仅占位，实际清理使用系统级 prune）
 */
router.post(
  '/:id/prune',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ ok: true });
  }),
);

// ============ 容器日志 ============

/**
 * GET /api/containers/:id/logs?tail=100&since=&until=&timestamps=
 * 获取容器日志。默认返回尾部 tail 行（实时回放）；也可通过 since/until 拉取指定时间范围的历史日志（分页/复盘）。
 * 参数：
 *  - tail: 末尾行数（缺省 200；传 0 表示全部）
 *  - since: Unix 时间戳（秒），仅返回该时间点之后的日志
 *  - until: Unix 时间戳（秒），仅返回该时间点之前的日志
 *  - timestamps: 是否在每行前附带时间戳
 */
router.get(
  '/:id/logs',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    const tailRaw = req.query.tail;
    // tail 缺省 200；显式传 0 表示全部
    const tail = tailRaw === undefined ? 200 : Number(tailRaw);
    const logsOpts: any = {
      stdout: true,
      stderr: true,
      timestamps: req.query.timestamps === 'true',
    };
    if (Number.isFinite(tail) && tail > 0) {
      logsOpts.tail = tail;
    }
    // Docker 日志时间戳为 Unix 秒；支持 since/until 实现历史分页
    const since = Number(req.query.since);
    if (Number.isFinite(since) && since > 0) {
      logsOpts.since = since;
    }
    const until = Number(req.query.until);
    if (Number.isFinite(until) && until > 0) {
      logsOpts.until = until;
    }
    const logs = await container.logs(logsOpts);
    // 解析多路复用帧，返回纯文本日志
    const text = demuxBufferToText(logs);
    res.json({ logs: text });
  }),
);

/**
 * 将多路复用日志缓冲解析为纯文本（去除 8 字节帧头）
 * @param buf 原始多路复用缓冲
 * @returns 拼接后的纯文本日志
 */
function demuxBufferToText(buf: Buffer | any): string {
  if (!buf || buf.length === 0) return '';
  let buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let result = '';
  while (buffer.length >= 8) {
    const payloadLen = buffer.readUInt32BE(4);
    if (buffer.length < 8 + payloadLen) break;
    result += buffer.subarray(8, 8 + payloadLen).toString('utf8');
    buffer = buffer.subarray(8 + payloadLen);
  }
  return result;
}

/**
 * GET /api/containers/:id/logs/download
 * 下载容器完整日志为文本文件。
 * 使用 dockerode 的 logs({stdout,stderr,follow:false,timestamps:false}) 获取原始多路复用缓冲，
 * 解析后作为附件（text/plain）返回，文件名 <容器名>.log。
 */
router.get(
  '/:id/logs/download',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    // 获取容器名用于生成下载文件名
    const info = await container.inspect();
    const containerName = ((info.Name || '').replace(/^\//, '') || req.params.id).replace(/[^\w.-]/g, '_');
    const logs: Buffer = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
      timestamps: false,
    });
    // 解析多路复用帧，得到纯文本
    const text = demuxBufferToText(logs);
    // 设置附件下载响应头并写入日志内容
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${containerName}.log"`,
    );
    res.send(text);
  }),
);

/**
 * GET /api/containers/:id/logs/stream?tail=100&follow=true
 * SSE (Server-Sent Events) 实时日志流。
 * 客户端通过 EventSource 订阅，服务端持续推送日志行；客户端断开时自动停止。
 */
router.get(
  '/:id/logs/stream',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    const tail = Number(req.query.tail || '100');
    const follow = req.query.follow !== 'false';

    // SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 先取历史日志（尾部）
    let initial: any = Buffer.alloc(0);
    try {
      initial = await container.logs({ stdout: true, stderr: true, tail });
    } catch {
      initial = Buffer.alloc(0);
    }
    // flush 初始历史日志
    sendInitialLines(res, initial);

    if (!follow) {
      res.end();
      return;
    }

    // 心跳定时器（保持空闲 SSE 连接不被中间层/底层回收）
    let pingTimer: NodeJS.Timeout | null = null;
    // 持续日志流引用
    let stream: NodeJS.ReadableStream | null = null;
    let cleaned = false;

    /**
     * 幂等清理：清心跳、销毁 docker 流、结束响应
     */
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        if (pingTimer) clearInterval(pingTimer);
      } catch {
        // 忽略
      }
      try {
        if (stream && typeof (stream as any).destroy === 'function') (stream as any).destroy();
      } catch {
        // 忽略
      }
      try {
        if (!res.writableEnded) res.end();
      } catch {
        // 忽略
      }
    }

    // 判断容器是否运行：未运行时不建立会秒断的 follow 长连接，
    // 而是明确告知前端"容器已停止"，避免前端无限重连
    let running = false;
    try {
      running = !!(await container.inspect()).State?.Running;
    } catch {
      running = false;
    }

    if (!running) {
      writeEvent(res, { type: 'error', text: '容器已停止，仅展示历史日志', stopped: true });
      res.end();
      return;
    }

    // 订阅持续日志流
    try {
      stream = await container.logs({ stdout: true, stderr: true, follow: true });
    } catch (err) {
      writeEvent(res, { type: 'error', text: '无法连接日志流: ' + (err as Error).message });
      cleanup();
      return;
    }

    demuxLogStream(stream, (text, streamType) => {
      if (res.writableEnded) return;
      writeEvent(res, { type: streamType === 2 ? 'stderr' : 'stdout', text: text + '\n' });
    });

    stream.on('end', cleanup);
    stream.on('error', cleanup);

    // 客户端断开时清理
    req.on('close', cleanup);
    res.on('close', cleanup);

    // 每 15s 发送一次 SSE 注释行保活，避免空闲连接被回收
    pingTimer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, PING_INTERVAL_MS);
    (pingTimer as any).unref?.();
  }),
);

/**
 * 将历史日志缓冲的初始内容以 SSE 形式发送
 * @param res Express 响应
 * @param initial 原始多路复用日志缓冲
 */
function sendInitialLines(res: Response, initial: Buffer) {
  let buffer = initial;
  const lines: Array<[number, string]> = [];
  const tryParse = () => {
    while (buffer.length >= 8) {
      const streamType = buffer[0];
      const payloadLen = buffer.readUInt32BE(4);
      if (buffer.length < 8 + payloadLen) break;
      const payload = buffer.subarray(8, 8 + payloadLen).toString('utf8');
      buffer = buffer.subarray(8 + payloadLen);
      lines.push([streamType, payload]);
    }
  };
  tryParse();
  for (const [streamType, payload] of lines) {
    if (res.writableEnded) break;
    writeEvent(res, { type: streamType === 2 ? 'stderr' : 'stdout', text: payload });
  }
}

/**
 * 向 SSE 客户端写入一个事件
 * @param res Express 响应
 * @param data JSON 数据
 */
function writeEvent(res: Response, data: unknown) {
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

// ============ 容器完整详情 ============

/**
 * GET /api/containers/:id/detail
 * 获取容器完整详情（含环境变量、挂载卷、网络、端口、健康检查等）
 */
router.get(
  '/:id/detail',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();

    const mounts = (inspect.Mounts || []).map((m: any) => ({
      type: m.Type || '',
      source: m.Source || '',
      destination: m.Destination || '',
      mode: m.Mode || '',
      rw: m.RW,
    }));

    const netSettings = inspect.NetworkSettings || {};
    const networks = Object.entries(netSettings.Networks || {}).map(([name, n]: [string, any]) => ({
      name,
      ipAddress: n.IPAddress || '',
      gateway: n.Gateway || '',
      aliases: n.Aliases || [],
      macAddress: n.MacAddress || '',
    }));

    const ports = Object.entries(netSettings.Ports || {}).map(([internal, bindings]: [string, any[]]) => ({
      internal,
      published: (bindings || []).map((b) => ({
        hostIp: b.HostIp || '',
        hostPort: b.HostPort || '',
      })),
    }));

    const env = Object.fromEntries(
      (inspect.Config?.Env || []).map((e: string) => {
        const idx = e.indexOf('=');
        return idx > -1 ? [e.slice(0, idx), e.slice(idx + 1)] : [e, ''];
      }),
    );

    const health = inspect.State?.Health || null;

    res.json({
      id: inspect.Id,
      idShort: inspect.Id.slice(0, 12),
      name: (inspect.Name || '').replace(/^\//, ''),
      image: inspect.Config?.Image || '',
      imageId: inspect.Image || '',
      created: inspect.Created,
      state: inspect.State?.Status || '',
      startedAt: inspect.State?.StartedAt || '',
      finishedAt: inspect.State?.FinishedAt || '',
      exitCode: inspect.State?.ExitCode ?? null,
      // 重启次数（docker inspect 顶层 RestartCount 字段）
      restartCount: inspect.RestartCount ?? 0,
      // 配置
      command: (inspect.Config?.Cmd || []).join(' '),
      entrypoint: Array.isArray(inspect.Config?.Entrypoint)
        ? inspect.Config?.Entrypoint.join(' ')
        : inspect.Config?.Entrypoint || '',
      user: inspect.Config?.User || '',
      workingDir: inspect.Config?.WorkingDir || '',
      restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
      autoRemove: !!inspect.HostConfig?.AutoRemove,
      privileged: !!inspect.HostConfig?.Privileged,
      // 资源限制（用于在线更新弹窗预填）
      cpuLimit: inspect.HostConfig?.NanoCpus || 0,
      memLimit: inspect.HostConfig?.Memory || 0,
      // 资源
      env,
      labels: inspect.Config?.Labels || {},
      mounts,
      networks,
      ports,
      hostname: inspect.Config?.Hostname || '',
      // 健康检查
      health: health
        ? {
            status: health.Status || '',
            failingStreak: health.FailingStreak ?? 0,
            log: (health.Log || []).map((l: any) => ({
              start: l.Start || '',
              exit: l.ExitCode ?? null,
              output: l.Output || '',
            })),
          }
        : null,
    });
  }),
);

// ============ 容器配置导出 ============

/**
 * GET /api/containers/:id/config
 * 导出容器的完整可重建配置（用于迁移 / 备份 / 从配置重新创建）。
 * 返回结构与 POST /api/containers 创建接口兼容，额外含 entrypoint/user/workingDir/
 * hostname/labels/privileged/autoRemove 以完整还原配置。
 */
router.get(
  '/:id/config',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    const inspect = await container.inspect();

    // 端口映射：从 HostConfig.PortBindings 还原为创建接口的 ports 数组
    const ports: Array<{ host: string; container: string; protocol: string; hostIp: string }> = [];
    for (const [key, bindings] of Object.entries(inspect.HostConfig?.PortBindings || {})) {
      const [containerPort, protocol = 'tcp'] = key.split('/');
      for (const b of (bindings as Array<{ HostIp?: string; HostPort?: string }>) || []) {
        ports.push({
          host: b.HostPort || '',
          container: containerPort,
          protocol,
          hostIp: b.HostIp || '0.0.0.0',
        });
      }
    }

    // 挂载卷：从 HostConfig.Binds 还原为创建接口的 volumes 数组
    const volumes: Array<{ source: string; target: string; readonly: boolean }> = [];
    for (const bind of inspect.HostConfig?.Binds || []) {
      const parts = bind.split(':');
      // 形如 "source:target[:ro]"
      let source = parts[0] || '';
      let target = '';
      let readonly = false;
      if (parts.length >= 2) {
        target = parts[1];
        if (parts.length >= 3 && parts[2] === 'ro') readonly = true;
      } else {
        source = '';
        target = bind;
      }
      volumes.push({ source, target, readonly });
    }

    res.json({
      schema: 'docker-manager.container.config/v1',
      exportedAt: new Date().toISOString(),
      sourceId: inspect.Id,
      config: {
        name: (inspect.Name || '').replace(/^\//, ''),
        image: inspect.Config?.Image || '',
        command: Array.isArray(inspect.Config?.Cmd) ? inspect.Config?.Cmd.join(' ') : '',
        entrypoint: Array.isArray(inspect.Config?.Entrypoint)
          ? inspect.Config?.Entrypoint.join(' ')
          : inspect.Config?.Entrypoint || '',
        env: inspect.Config?.Env || [],
        ports,
        volumes,
        networkMode: inspect.HostConfig?.NetworkMode || 'default',
        restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
        tty: !!inspect.Config?.Tty,
        user: inspect.Config?.User || '',
        workingDir: inspect.Config?.WorkingDir || '',
        hostname: inspect.Config?.Hostname || '',
        labels: inspect.Config?.Labels || {},
        privileged: !!inspect.HostConfig?.Privileged,
        autoRemove: !!inspect.HostConfig?.AutoRemove,
      },
    });
  }),
);

/**
 * GET /api/containers/:id/stats
 * 获取容器实时资源统计（CPU / 内存 / 网络等）
 */
router.get(
  '/:id/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    const stats = await container.stats({ stream: false });
    res.json(await parseStats(stats));
  }),
);


// ============ 容器创建 ============

/**
 * POST /api/containers
 * 创建并启动一个新容器
 * body: { name, image, command, env, ports, volumes, networkMode, restartPolicy, tty }
 */
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const b = req.body || {};

    const portMap: Dockerode.PortMap = {};
    const exposedPorts: Record<string, Record<string, unknown>> = {};
    if (b.ports && Array.isArray(b.ports)) {
      for (const p of b.ports) {
        // p: { host: 8080, container: 80, protocol?: 'tcp'|'udp' }
        const protocol = p.protocol || 'tcp';
        const key = `${p.container}/${protocol}`;
        exposedPorts[key] = {};
        portMap[key] = [{ HostIp: p.hostIp || '0.0.0.0', HostPort: String(p.host) }];
      }
    }

    const binds: string[] = [];
    if (b.volumes && Array.isArray(b.volumes)) {
      for (const v of b.volumes) {
        // v: { source, target, readonly }
        binds.push(`${v.source}:${v.target}${v.readonly ? ':ro' : ''}`);
      }
    }

    const createOpts: Dockerode.ContainerCreateOptions = {
      name: b.name,
      Image: b.image,
      Cmd: b.command ? b.command.split(/\s+/).filter((s: string) => s) : undefined,
      Entrypoint: b.entrypoint && String(b.entrypoint).trim()
        ? String(b.entrypoint).split(/\s+/).filter((s: string) => s)
        : undefined,
      User: b.user || undefined,
      WorkingDir: b.workingDir || undefined,
      Hostname: b.hostname || undefined,
      Labels: b.labels && typeof b.labels === 'object' ? b.labels : undefined,
      Env: b.env && Array.isArray(b.env) ? b.env : undefined,
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      HostConfig: {
        Binds: binds.length ? binds : undefined,
        PortBindings: Object.keys(portMap).length ? portMap : undefined,
        RestartPolicy: b.restartPolicy
          ? { Name: b.restartPolicy, MaximumRetryCount: b.maxRetry || 0 }
          : undefined,
        NetworkMode: b.networkMode || 'default',
        Privileged: b.privileged === true,
        AutoRemove: b.autoRemove === true,
        // 资源限制：memLimit 字节 / cpuLimit 纳核（可通过前端留空不限制）
        Memory: b.memLimit ? Number(b.memLimit) : undefined,
        NanoCpus: b.cpuLimit ? Number(b.cpuLimit) : undefined,
      },
      // 健康检查：{ test, interval(ms), timeout(ms), retries }，Interval/Timeout 单位纳秒
      Healthcheck: b.healthcheck && Array.isArray(b.healthcheck.test) && b.healthcheck.test.length
        ? {
            Test: b.healthcheck.test,
            Interval: b.healthcheck.interval ? Number(b.healthcheck.interval) * 1e6 : 30000 * 1e6,
            Timeout: b.healthcheck.timeout ? Number(b.healthcheck.timeout) * 1e6 : 5000 * 1e6,
            Retries: b.healthcheck.retries ? Number(b.healthcheck.retries) : 3,
          }
        : undefined,
      Tty: b.tty !== false,
    };

    const container = await docker.createContainer(createOpts);
    if (b.start !== false) {
      await container.start();
    }
    const info = await container.inspect();
    logOperation(
      res.locals.username,
      '创建容器',
      'container',
      b.name,
      `镜像: ${b.image}${b.start === false ? '（不启动）' : ''}`,
    );
    res.status(201).json(await formatContainer(container, info));
  }),
);

// ============ 容器重建（用于编辑环境变量等配置） ============

/**
 * POST /api/containers/:id/recreate
 * 基于现有容器重建，仅替换环境变量（其余配置如镜像、端口、挂载、网络、重启策略等均保留）
 * body: { env: Record<string,string> } 完整的新环境变量映射
 * body(可选): { image: string } 替换容器使用的镜像
 */
router.post(
  '/:id/recreate',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const old = docker.getContainer(req.params.id);
    const inspect = await old.inspect();
    const oldName = (inspect.Name || '').replace(/^\//, '');

    // 可选：替换容器使用的镜像（用于容器首页"编辑镜像"功能）
    const desiredImage: string | undefined =
      typeof req.body?.image === 'string' && req.body.image.trim()
        ? req.body.image.trim()
        : undefined;

    // 将前端传入的完整环境变量映射转为 "KEY=VALUE" 数组
    const desiredEnv: Record<string, string> =
      req.body?.env && typeof req.body.env === 'object' ? req.body.env : {};
    const newEnv = Object.entries(desiredEnv).map(([k, v]) => `${k}=${String(v)}`);

    // 可选：挂载卷覆盖（"source:destination[:ro]" 数组）与网络模式覆盖
    const desiredBinds: string[] = Array.isArray(req.body?.binds) ? req.body.binds : [];
    const desiredNetwork: string | undefined =
      typeof req.body?.network === 'string' && req.body.network ? req.body.network : undefined;

    // 可选：端口映射覆盖（参照创建接口格式：{ host, container, protocol?, hostIp? }）
    const desiredPorts: Array<any> | null = Array.isArray(req.body?.ports) ? req.body.ports : null;
    let exposedPorts: any = inspect.Config?.ExposedPorts;
    let portBindings = inspect.HostConfig?.PortBindings || undefined;
    if (desiredPorts) {
      const portMap: Dockerode.PortMap = {};
      const exposed: Record<string, {}> = {};
      for (const p of desiredPorts) {
        if (!p || !p.container) continue;
        const protocol = p.protocol || 'tcp';
        const key = `${p.container}/${protocol}`;
        exposed[key] = {};
        // 若未提供宿主机端口，则只暴露不发布
        if (p.host !== undefined && p.host !== null && p.host !== '') {
          portMap[key] = [{ HostIp: p.hostIp || '0.0.0.0', HostPort: String(p.host) }];
        }
      }
      exposedPorts = Object.keys(exposed).length ? exposed : undefined;
      portBindings = Object.keys(portMap).length ? portMap : undefined;
    }

    // 可选：重启策略覆盖
    const desiredRestartPolicy: Dockerode.HostRestartPolicy | undefined =
      typeof req.body?.restartPolicy === 'string' && req.body.restartPolicy
        ? {
            Name: req.body.restartPolicy,
            MaximumRetryCount: inspect.HostConfig?.RestartPolicy?.MaximumRetryCount || 0,
          }
        : inspect.HostConfig?.RestartPolicy || undefined;

    // 可选：特权模式覆盖
    const desiredPrivileged: boolean =
      typeof req.body?.privileged === 'boolean'
        ? req.body.privileged
        : !!inspect.HostConfig?.Privileged;

    // 复用原容器的各项配置（镜像可被 desiredImage 替换）
    const createOpts: Dockerode.ContainerCreateOptions = {
      Image: desiredImage || inspect.Config?.Image || '',
      Cmd: inspect.Config?.Cmd || undefined,
      Entrypoint: inspect.Config?.Entrypoint || undefined,
      WorkingDir: inspect.Config?.WorkingDir || undefined,
      User: inspect.Config?.User || undefined,
      Hostname: inspect.Config?.Hostname || undefined,
      Env: newEnv,
      Labels: inspect.Config?.Labels || {},
      ExposedPorts: exposedPorts,
      HostConfig: {
        Binds: desiredBinds.length ? desiredBinds : inspect.HostConfig?.Binds || undefined,
        PortBindings: portBindings,
        RestartPolicy: desiredRestartPolicy,
        NetworkMode: desiredNetwork || inspect.HostConfig?.NetworkMode || undefined,
        Privileged: desiredPrivileged,
        AutoRemove: !!inspect.HostConfig?.AutoRemove,
      },
      Tty: !!inspect.Config?.Tty,
    };

    // 先以临时名创建新容器，避免与旧容器名冲突
    const tmpName = `${oldName}-recreate-${Date.now()}`;
    const container = await docker.createContainer({ ...createOpts, name: tmpName });

    try {
      // 旧容器若在运行则先停止，再删除
      if (inspect.State?.Running) {
        try {
          await old.stop();
        } catch {
          // 忽略已停止
        }
      }
      await old.remove({ force: true });
      // 将新容器改名为原容器名（dockerode 需要对象参数，否则 name 为空导致失败）
      await container.rename({ name: oldName });
      // 启动新容器；原容器可能为停止状态则保持停止
      if (inspect.State?.Running) {
        await container.start();
      }
      const info = await container.inspect();
      logOperation(res.locals.username, '重建容器', 'container', oldName);
      res.json(await formatContainer(container, info));
    } catch (err) {
      // 重建失败：清理临时新容器，保留错误信息
      try {
        await container.remove({ force: true });
      } catch {
        // ignore
      }
      throw err;
    }
  }),
);

// ============ 容器在线更新（docker update） ============

/**
 * POST /api/containers/:id/update
 * 在线更新运行中容器的资源限制与重启策略（对应 docker update，无需重建、不改变容器 ID）。
 * 仅覆盖请求中显式提供的字段，未提供的保持现状。
 * body: {
 *   restartPolicy?: string  'no'|'always'|'on-failure'|'unless-stopped'
 *   maxRetry?: number       重启策略最大重试次数（仅 on-failure 有效）
 *   memLimit?: number       内存上限（字节；传 0/空 表示取消）
 *   memReservation?: number 内存预留（字节）
 *   cpuLimit?: number       CPU 限制（NanoCpus 纳核，例如 1.5 核 = 1.5e9）
 *   cpuShares?: number      CPU 权重
 *   cpusetCpus?: string     允许使用的 CPU 集，形如 "0-1"
 * }
 */
router.post(
  '/:id/update',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    const b = req.body || {};
    const inspect = await container.inspect();
    const name = (inspect.Name || '').replace(/^\//, '');

    // 以当前 HostConfig 为基线，避免把未提供的字段清空
    const hc: any = { ...(inspect.HostConfig || {}) };

    // 重启策略
    if (typeof b.restartPolicy === 'string' && b.restartPolicy) {
      hc.RestartPolicy = { Name: b.restartPolicy, MaximumRetryCount: Number(b.maxRetry) || 0 };
    }

    // 内存相关：显式传 memLimit 才更新；同时按 docker 默认 swap=2x 内存同步 MemorySwap，避免 EINVAL
    if (b.memLimit !== undefined && b.memLimit !== null && b.memLimit !== '') {
      const mem = Number(b.memLimit) || 0;
      hc.Memory = mem > 0 ? mem : 0;
      if (b.memSwap === undefined || b.memSwap === null || b.memSwap === '') {
        hc.MemorySwap = mem > 0 ? mem * 2 : 0;
      }
    }
    if (b.memSwap !== undefined && b.memSwap !== null && b.memSwap !== '') {
      hc.MemorySwap = Number(b.memSwap) || 0;
    }
    if (b.memReservation !== undefined && b.memReservation !== null && b.memReservation !== '') {
      hc.MemoryReservation = Number(b.memReservation) || 0;
    }

    // CPU 相关
    if (b.cpuLimit !== undefined && b.cpuLimit !== null && b.cpuLimit !== '') {
      const ncpus = Number(b.cpuLimit) || 0;
      if (ncpus > 0) {
        hc.NanoCpus = ncpus;
        delete hc.CpuQuota;
      } else {
        hc.NanoCpus = 0;
      }
    }
    if (b.cpuShares !== undefined && b.cpuShares !== null && b.cpuShares !== '') {
      hc.CpuShares = Number(b.cpuShares) || 0;
    }
    if (typeof b.cpusetCpus === 'string') {
      hc.CpusetCpus = b.cpusetCpus.trim() || undefined;
    }

    // 在线更新（docker update）；失败会抛出，由 asyncHandler 统一处理
    await container.update(hc);
    logOperation(res.locals.username, '更新容器配置', 'container', name);
    const info = await container.inspect();
    res.json(await formatContainer(container, info));
  }),
);

// ============ 容器克隆 ============

/**
 * POST /api/containers/:id/clone
 * 基于现有容器克隆出一个新容器，保留镜像、命令、环境变量、端口、挂载、网络等配置，不删除原容器。
 * body: { name?, start? } name 必填或自动生成（<原名>-clone），start 默认 true。
 * 端口映射若导致宿主端口冲突，dockerode 会在启动时报错并返回。
 */
router.post(
  '/:id/clone',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const old = docker.getContainer(req.params.id);
    const inspect = await old.inspect();
    const oldName = (inspect.Name || '').replace(/^\//, '');

    // 目标容器名：优先使用前端传入的 name，否则自动生成 <原名>-clone
    const desiredName: string = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : `${oldName || req.params.id}-clone`;

    // 复用原容器的各项配置（参照 recreate 的字段提取逻辑）
    const createOpts: Dockerode.ContainerCreateOptions = {
      Image: inspect.Config?.Image || '',
      Cmd: inspect.Config?.Cmd || undefined,
      Entrypoint: inspect.Config?.Entrypoint || undefined,
      WorkingDir: inspect.Config?.WorkingDir || undefined,
      User: inspect.Config?.User || undefined,
      Hostname: inspect.Config?.Hostname || undefined,
      Env: inspect.Config?.Env || undefined,
      Labels: inspect.Config?.Labels || {},
      ExposedPorts: inspect.Config?.ExposedPorts || undefined,
      HostConfig: {
        Binds: inspect.HostConfig?.Binds || undefined,
        PortBindings: inspect.HostConfig?.PortBindings || undefined,
        RestartPolicy: inspect.HostConfig?.RestartPolicy || undefined,
        NetworkMode: inspect.HostConfig?.NetworkMode || undefined,
        Privileged: !!inspect.HostConfig?.Privileged,
        AutoRemove: !!inspect.HostConfig?.AutoRemove,
      },
      Tty: !!inspect.Config?.Tty,
    };

    // 创建克隆容器，不删除原容器
    const container = await docker.createContainer({ ...createOpts, name: desiredName });
    // 按 start 参数决定是否启动（默认 true）
    if (req.body?.start !== false) {
      await container.start();
    }
    const info = await container.inspect();
    logOperation(res.locals.username, '克隆容器', 'container', desiredName, `来源: ${req.params.id.slice(0, 12)}`);
    res.status(201).json(await formatContainer(container, info));
  }),
);

// ============ 容器提交为镜像 ============

/**
 * POST /api/containers/:id/commit
 * 将容器的当前文件系统状态提交为一个新镜像。
 * body: { repo, tag?, comment?, author?, pause? } repo 必填，tag 默认 latest。
 */
router.post(
  '/:id/commit',
  asyncHandler(
    async (req: Request, res: Response) => {
      const docker = await getDockerClient();
      const container = docker.getContainer(req.params.id);

      const repo: string = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
      // repo 必填校验
      if (!repo) {
        res.status(400).json({ error: '镜像仓库名 repo 不能为空' });
        return;
      }
      const tag: string = typeof req.body?.tag === 'string' && req.body.tag.trim()
        ? req.body.tag.trim()
        : 'latest';

      // 使用 Promise 封装 dockerode 的 commit 回调式 API
      await new Promise<void>((resolve, reject) => {
        container.commit(
          {
            repo,
            tag,
            comment: typeof req.body?.comment === 'string' && req.body.comment ? req.body.comment : undefined,
            author: typeof req.body?.author === 'string' && req.body.author ? req.body.author : undefined,
            pause: typeof req.body?.pause === 'boolean' ? req.body.pause : undefined,
          },
          (err: any, _data: any) => (err ? reject(err) : resolve()),
        );
      });

      logOperation(res.locals.username, '提交为镜像', 'container', req.params.id, `镜像: ${repo}:${tag}`);
      res.json({ ok: true, image: `${repo}:${tag}` });
    },
    (req: Request) => ({ action: '提交为镜像', targetType: 'container', targetName: req.params.id }),
  ),
);

// ============ 容器单命令执行 ============

/** exec 单命令执行的超时时间（毫秒） */
const EXEC_TIMEOUT_MS = 10000;

/**
 * POST /api/containers/:id/exec
 * 在运行中的容器内执行一条非交互式命令，并收集其 stdout/stderr 文本与退出码。
 * body: { cmd: string } 如 "ls -la /" 或 "cat /etc/os-release"。
 * 非运行容器返回 400「容器未运行」；命令超时（默认 10s）时销毁 exec 流并返回超时提示。
 */
router.post(
  '/:id/exec',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);

    // 命令必填校验
    const cmd: string = typeof req.body?.cmd === 'string' ? req.body.cmd.trim() : '';
    if (!cmd) {
      res.status(400).json({ error: '命令 cmd 不能为空' });
      return;
    }

    // 校验容器存在且处于运行状态，未运行则明确返回 400
    try {
      const info = await container.inspect();
      if (!info.State?.Running) {
        res.status(400).json({ error: '容器未运行' });
        return;
      }
    } catch (err: any) {
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '容器不存在';
      res.status(400).json({ error: message });
      return;
    }

    // 创建非交互式 exec：按空白拆分命令参数，仅附加输出
    const exec = await container.exec({
      Cmd: cmd.split(/\s+/).filter((s: string) => s),
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    } as any);

    // 启动 exec 并获取混合输出流（hijack 模式）
    const stream = (await exec.start({ hijack: true, stdin: false, Tty: false })) as unknown as NodeJS.ReadableStream;

    // 收集 stdout + stderr 文本。
    // 注意：Tty=false 时 Docker 输出为「多路复用帧」（8 字节头 + payload），
    // 需按帧剥离头后拼接，否则会出现二进制帧头残留。
    let output = '';
    // 滚动缓冲区：暂存尚未构成完整帧的字节
    let frameBuf = Buffer.alloc(0);

    try {
      // 等 exec 流结束，期间做超时控制
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        // 超时定时器：超时销毁流并按错误处理
        const timer = setTimeout(() => {
          settled = true;
          try { (stream as any).destroy(); } catch { /* ignore */ }
          reject(new Error('命令执行超时（10 秒）'));
        }, EXEC_TIMEOUT_MS);
        (timer as any).unref?.();

        /**
         * 将新到达的 chunk 并入滚动缓冲，解析出一个个完整多路复用帧并提取 payload 文本
         * @param chunk 新到达的二进制块
         */
        const feed = (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          frameBuf = Buffer.concat([frameBuf, buf]);
          // 循环剥离完整帧（8 字节头 + payload）
          while (frameBuf.length >= 8) {
            const payloadLen = frameBuf.readUInt32BE(4);
            if (frameBuf.length < 8 + payloadLen) break;
            output += frameBuf.subarray(8, 8 + payloadLen).toString('utf8');
            frameBuf = frameBuf.subarray(8 + payloadLen);
          }
        };

        stream.on('data', (chunk: Buffer | string) => {
          // 数据到达时仍计入活跃（重置超时由 Promise 逻辑统一处理，这里仅做剥帧）
          feed(chunk);
        });
        stream.on('error', (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });
      });

      // 查询 exec 的最终退出码
      let exitCode: number | null = null;
      try {
        const inspect = await exec.inspect();
        exitCode = inspect?.ExitCode ?? null;
      } catch {
        // 退出码查询失败时置空，不影响返回结果
        exitCode = null;
      }

      res.json({ ok: true, exitCode, output });
    } finally {
      // 尽力销毁 exec 流，避免资源泄漏
      try { (stream as any).destroy(); } catch { /* ignore */ }
    }
  }),
);

export default router;
