/**
 * 容器管理 API 路由
 *
 * 提供容器的列表、启停、删除、日志、详情、创建等接口。
 */
import { Router, Request, Response } from 'express';
import net from 'net';
import { getDockerClient } from '../docker/client';
import { parseStats, ParsedStats } from '../docker/stats';
import { getContainerMetricsHistory } from '../docker/containerMetrics';
import Dockerode from 'dockerode';
import { StringDecoder } from 'string_decoder';
import { logOperation } from '../operationLog';
import { requireAdmin, requireOperator } from '../auth';

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
    // 健康检查状态（未配置 Healthcheck 时为 'none'）
    health: inspect.State?.Health?.Status || 'none',
    // CPU 限制（NanoCpus 纳核，0 表示不限制）
    cpuLimit: inspect.HostConfig?.NanoCpus || 0,
    // 内存限制（字节，0 表示不限制）
    memLimit: inspect.HostConfig?.Memory || 0,
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
/**
 * 行拆分器：跨多次 push 拼接尚未换行的残余内容（用于流式日志按行分发）
 */
function createLineSplitter(onLine: (line: string, streamType: number) => void) {
  let pending = '';
  let pendingType = 0;
  return {
    push(text: string, streamType: number) {
      pendingType = streamType;
      const combined = pending + text;
      let start = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] === '\n') {
          const line = combined.slice(start, i);
          if (line) onLine(line, pendingType);
          start = i + 1;
        }
      }
      pending = combined.slice(start);
    },
    end() {
      if (pending) onLine(pending, pendingType);
      pending = '';
    },
  };
}

/**
 * 解复用容器日志流（SSE 实时日志用）
 *
 * 根据容器 TTY 配置自适应：
 *  - TTY：日志为纯字节流，StringDecoder 直接 UTF-8 解码后按行分发；
 *  - 非 TTY：解析 8 字节帧头，取出各帧载荷后同样按行分发。
 * streamType: 1=stdout(0 兼容), 2=stderr。
 * @param stream dockerode 日志流
 * @param tty 容器是否为 TTY 模式
 * @param onLine 每行回调
 */
function demuxLogStream(
  stream: NodeJS.ReadableStream,
  tty: boolean,
  onLine: (text: string, streamType: number) => void
): void {
  const splitter = createLineSplitter(onLine);
  if (tty) {
    // TTY：纯字节流，UTF-8 解码后按行分发（TTY 下 stdout/stderr 合并，type 取 0）
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk: Buffer) => splitter.push(decoder.write(chunk), 0));
    stream.on('error', () => splitter.end());
    stream.on('end', () => {
      splitter.push(decoder.end(), 0);
      splitter.end();
    });
  } else {
    // 非 TTY：解析 8 字节帧头
    let buffer = Buffer.alloc(0);
    const decoder = new StringDecoder('utf8');
    const tryParse = () => {
      while (buffer.length >= 8) {
        const streamType = buffer[0];
        const payloadLen = buffer.readUInt32BE(4);
        if (buffer.length < 8 + payloadLen) break;
        splitter.push(decoder.write(buffer.subarray(8, 8 + payloadLen)), streamType);
        buffer = buffer.subarray(8 + payloadLen);
      }
    };
    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      tryParse();
    });
    stream.on('error', () => {
      buffer = Buffer.alloc(0);
      splitter.end();
    });
    stream.on('end', () => {
      splitter.push(decoder.end(), 0);
      splitter.end();
    });
  }
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
    // 并发 inspect 每个容器以提取健康检查状态（health）
    // 注意：会对每个容器发起一次 Docker Engine 请求，容器数量较多时可能略慢
    const containersWithHealth = await Promise.all(
      containers.map(async (c) => {
        try {
          const info = await docker.getContainer(c.Id).inspect();
          return {
            ...c,
            health: info.State?.Health?.Status || 'none',
            cpuLimit: info.HostConfig?.NanoCpus || 0,
            memLimit: info.HostConfig?.Memory || 0,
          };
        } catch {
          // inspect 失败时降级为 'none'，不影响列表整体返回
          return { ...c, health: 'none', cpuLimit: 0, memLimit: 0 };
        }
      }),
    );
    res.json(containersWithHealth);
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

/**
 * 探测宿主机某端口是否被本机进程或已发布容器监听（TCP connect 探测）
 * connect 成功即认为端口已被占用。@param port 端口号 1-65535
 * @returns 是否被监听
 */
function probeHostListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * POST /api/containers/port-check
 * 前置端口占用检测：对用户输入的宿主机端口做冲突检查（创建/编辑容器前提示）。
 * body: { ports: (number|string)[] } —— 待检测的宿主机端口列表
 * 逐个判定：
 *  - containerOccupied/containerNames：是否已被其它容器映射（含单容器占用，放宽于 /ports 的 ≥2 冲突口径）
 *  - hostListening：本机 127.0.0.1 是否有进程监听该端口
 *  - busy = 二者任一为 true
 * 注意：该静态路由必须放在 /:id 之前，否则会被 /:id 遮蔽。
 */
router.post(
  '/port-check',
  asyncHandler(async (req: Request, res: Response) => {
    const rawPorts: unknown[] = Array.isArray(req.body?.ports) ? req.body.ports : [];
    if (!rawPorts.length) {
      return res.status(400).json({ error: '缺少待检测的端口列表' });
    }
    // 归一化为去重的数字端口
    const ports: number[] = Array.from(
      new Set(
        rawPorts
          .map((p) => Number(p))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 65535),
      ),
    );

    // 收集所有容器已发布的 HostPort 至占用列表（单个容器占用也视为冲突）
    const docker = await getDockerClient();
    const containers = await docker.listContainers({ all: true });
    const portOwners: Record<string, string[]> = {};
    for (const c of containers) {
      const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '');
      for (const p of c.Ports || []) {
        if (p.PublicPort !== undefined && p.PublicPort !== null) {
          const key = String(p.PublicPort);
          if (!portOwners[key]) portOwners[key] = [];
          if (!portOwners[key].includes(name)) portOwners[key].push(name);
        }
      }
    }

    // 对每个端口做本机监听探测（并发）
    const listening = await Promise.all(
      ports.map((port) => probeHostListening(port)),
    );

    const results = ports.map((port, idx) => {
      const key = String(port);
      const containerNames = portOwners[key] || [];
      const hostListening = listening[idx];
      return {
        port,
        containerOccupied: containerNames.length > 0,
        containerNames,
        hostListening,
        busy: containerNames.length > 0 || hostListening,
      };
    });

    res.json({ results });
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

/**
 * GET /api/containers/stats/top?sort=cpu|mem&limit=10
 * 容器资源占用看板：编排含容器名/状态/镜像的资源统计，按 CPU%（默认）或内存%降序取 Top N。
 * 仅统计 running 容器（stats 对停止容器无意义），停止容器不在此榜中。
 */
router.get(
  '/stats/top',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const sortBy = req.query.sort === 'mem' ? 'mem' : 'cpu';
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;

    const list = (await docker.listContainers({ all: false })) as any[];

    // 并发拉取各运行容器 stats，并附名称/状态/镜像信息；逐项降级容错
    const entries = await Promise.all(
      list.map(async (c: any) => {
        let stats: ParsedStats | null = null;
        try {
          const raw = await docker.getContainer(c.Id).stats({ stream: false });
          stats = raw ? parseStats(raw) : null;
        } catch {
          // 单个失败不影响整体
        }
        if (!stats) return null;
        const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '') || (c.Id || '').slice(0, 12);
        return {
          id: c.Id,
          name,
          image: c.Image || '',
          state: c.State || 'running',
          cpuPercent: stats.cpuPercent,
          memPercent: stats.memory.percent,
          memUsageMB: Math.round(stats.memory.usage / 1024 / 1024),
          memLimitMB: Math.round(stats.memory.limit / 1024 / 1024),
          netRxMB: Number((stats.network.rx / 1024 / 1024).toFixed(2)),
          netTxMB: Number((stats.network.tx / 1024 / 1024).toFixed(2)),
          pids: stats.pids,
        };
      }),
    );

    const items = (entries.filter(Boolean) as any[]).sort((a, b) =>
      sortBy === 'mem' ? b.memPercent - a.memPercent : b.cpuPercent - a.cpuPercent,
    ).slice(0, limit);

    res.json({ items, sortBy });
  }),
);

/**
 * 批量容器操作投递函数：对一组容器 id 并发执行同一 dockerode 操作，逐项容错。
 * 任一容器失败不影响其他容器，返回每个容器的执行结果与成败计数。
 * @param ids 容器 id 数组
 * @param op 针对单个容器执行并返回 Promise 的操作函数
 * @returns 统一结果结构
 */
async function runBatch(
  ids: string[],
  op: (id: string) => Promise<void>,
): Promise<{ success: number; fail: number; results: Array<{ id: string; ok: boolean; error?: string }> }> {
  const docker = await getDockerClient();
  const settled = await Promise.all(
    ids.map(async (id: string) => {
      try {
        await op(id);
        return { id, ok: true } as const;
      } catch (err: any) {
        return { id, ok: false, error: err?.message || '操作失败' } as const;
      }
    }),
  );
  return {
    success: settled.filter((r) => r.ok).length,
    fail: settled.filter((r) => !r.ok).length,
    results: settled.map((r) => ({ id: r.id, ok: r.ok, error: r.ok ? undefined : r.error })),
  };
}

/**
 * POST /api/containers/batch/start
 * 批量启动容器，body: { ids: string[] }
 * 并发执行 start，逐项容错，返回轻量统计结果。
 * 注意：静态路由必须放在 /:id 之前，否则会被 /:id 遮蔽。
 */
router.post(
  '/batch/start',
  asyncHandler(async (req: Request, res: Response) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '未指定容器' });
    const docker = await getDockerClient();
    const r = await runBatch(ids, (id) => docker.getContainer(id).start());
    res.json({ ok: r.fail === 0, ...r });
  }),
);

/**
 * POST /api/containers/batch/stop
 * 批量停止容器，body: { ids: string[] }
 * 并发执行 stop，逐项容错，返回轻量统计结果。
 */
router.post(
  '/batch/stop',
  asyncHandler(async (req: Request, res: Response) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '未指定容器' });
    const docker = await getDockerClient();
    const r = await runBatch(ids, (id) => docker.getContainer(id).stop({ t: 10 }));
    res.json({ ok: r.fail === 0, ...r });
  }),
);

/**
 * POST /api/containers/batch/restart
 * 批量重启容器，body: { ids: string[] }
 * 并发执行 restart，逐项容错，返回轻量统计结果。
 */
router.post(
  '/batch/restart',
  asyncHandler(async (req: Request, res: Response) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '未指定容器' });
    const docker = await getDockerClient();
    const r = await runBatch(ids, (id) => docker.getContainer(id).restart({ t: 10 }));
    res.json({ ok: r.fail === 0, ...r });
  }),
);

/**
 * POST /api/containers/batch/delete
 * 批量删除容器，body: { ids: string[], force?: boolean, v?: boolean }
 * 仅 operator 及以上可调用（与单容器删除权限一致）。并发执行 remove，逐项容错。
 */
router.post(
  '/batch/delete',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '未指定容器' });
    const docker = await getDockerClient();
    const force = req.body?.force === true;
    const v = req.body?.v === true;
    const r = await runBatch(ids, (id) => docker.getContainer(id).remove({ force, v }));
    res.json({ ok: r.fail === 0, ...r });
  }),
);

/**
 * POST /api/containers/batch/update
 * 批量在线更新容器资源限制与重启策略，body: { ids, memLimit?, cpuLimit?, restartPolicy?, maxRetry? }
 * 逐容器组装 HostConfig 增量（与单容器 /:id/update 共用 applyUpdateBodyToHostConfig），
 * 并发执行 update，逐项容错，返回 { ok, success, fail, results }。
 * 仅 operator 及以上可调用（与单容器 update 一致的运维操作语义）。
 * 注意：静态路由必须放在 /:id 之前，否则会被 /:id 遮蔽。
 */
router.post(
  '/batch/update',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '未指定容器' });
    const docker = await getDockerClient();
    const r = await runBatch(ids, async (id) => {
      const container = docker.getContainer(id);
      // 以当前 HostConfig 为基线，避免把未提供的字段清空
      const inspect = await container.inspect();
      const hc: any = { ...(inspect.HostConfig || {}) };
      // 复用与单容器 update 一致的增量组装逻辑
      applyUpdateBodyToHostConfig(req.body || {}, hc);
      await container.update(hc);
    });
    res.json({ ok: r.fail === 0, ...r });
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
  requireAdmin,
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
  requireOperator,
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
    // 解析日志（按容器 TTY 配置区分纯流 / 多路复用帧），返回纯文本日志
    let tty = false;
    try {
      tty = !!(await container.inspect()).Config?.Tty;
    } catch {
      tty = false;
    }
    const text = demuxBufferToText(logs, tty);
    res.json({ logs: text });
  }),
);

/**
 * 将容器日志缓冲解析为纯文本。
 *
 * Docker 日志存在两种格式，需按容器 TTY 配置区分：
 *  - TTY 容器（创建默认即 TTY）：日志为纯字节流，无帧头，直接按 UTF-8 解码；
 *  - 非 TTY 容器：8 字节帧头（streamType + payloadLen）的多路复用格式。
 *
 * 解析均使用 StringDecoder，避免 UTF-8 多字节字符在帧/块边界被截断导致乱码。
 * @param buf 原始日志缓冲
 * @param tty 容器是否为 TTY 模式
 * @returns 拼接后的纯文本日志
 */
/**
 * ANSI 转义序列正则（SGR 颜色 / 样式码等，用于彩色日志输出）
 */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * 剥离 ANSI 转义序列，返回纯文本（避免容器彩色日志在面板中显示为乱码）
 * @param s 原始字符串
 * @returns 去除 ANSI 控制序列后的纯文本
 */
function stripAnsi(s: string): string {
  return String(s).replace(ANSI_RE, '');
}

function demuxBufferToText(buf: Buffer | any, tty = false): string {
  if (!buf || buf.length === 0) return '';
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  // TTY：纯字节流，直接 UTF-8 解码
  if (tty) {
    return stripAnsi(new StringDecoder('utf8').write(buffer));
  }
  // 非 TTY：解析多路复用帧
  const decoder = new StringDecoder('utf8');
  let result = '';
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const payloadLen = buffer.readUInt32BE(offset + 4);
    if (buffer.length - offset < 8 + payloadLen) break;
    result += decoder.write(buffer.subarray(offset + 8, offset + 8 + payloadLen));
    offset += 8 + payloadLen;
  }
  result += decoder.end();
  return stripAnsi(result);
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
    // 解析日志（按容器 TTY 配置区分纯流 / 多路复用帧），得到纯文本
    const text = demuxBufferToText(logs, !!info.Config?.Tty);
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

    // 先探测容器 TTY 配置（决定日志是纯流还是多路复用帧）与运行状态
    let inspectInfo: any = null;
    try {
      inspectInfo = await container.inspect();
    } catch {
      inspectInfo = null;
    }
    const tty = !!inspectInfo?.Config?.Tty;

    // 先取历史日志（尾部）
    let initial: any = Buffer.alloc(0);
    try {
      initial = await container.logs({ stdout: true, stderr: true, tail });
    } catch {
      initial = Buffer.alloc(0);
    }
    // flush 初始历史日志
    sendInitialLines(res, initial, tty);

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
      running = !!inspectInfo?.State?.Running;
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

    demuxLogStream(stream, tty, (text, streamType) => {
      if (res.writableEnded) return;
      writeEvent(res, { type: streamType === 2 ? 'stderr' : 'stdout', text: stripAnsi(text) + '\n' });
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
function sendInitialLines(res: Response, initial: Buffer, tty: boolean) {
  if (tty) {
    // TTY：纯字节流，整段作为 stdout 输出（保留换行，由前端渲染）
    const text = new StringDecoder('utf8').write(initial);
    if (text && !res.writableEnded) writeEvent(res, { type: 'stdout', text });
    return;
  }
  let buffer = initial;
  const decoder = new StringDecoder('utf8');
  const lines: Array<[number, string]> = [];
  const tryParse = () => {
    while (buffer.length >= 8) {
      const streamType = buffer[0];
      const payloadLen = buffer.readUInt32BE(4);
      if (buffer.length < 8 + payloadLen) break;
      const payload = decoder.write(buffer.subarray(8, 8 + payloadLen));
      buffer = buffer.subarray(8 + payloadLen);
      lines.push([streamType, payload]);
    }
  };
  tryParse();
  const tail = decoder.end();
  if (tail) lines.push([0, tail]);
  for (const [streamType, payload] of lines) {
    if (res.writableEnded) break;
    if (payload) writeEvent(res, { type: streamType === 2 ? 'stderr' : 'stdout', text: stripAnsi(payload) });
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
      // 健康检查配置（供编辑弹窗预填；纳秒转毫秒便于输入）
      healthcheck: inspect.Config?.Healthcheck
        ? {
            test: inspect.Config.Healthcheck.Test || [],
            interval: Math.round((inspect.Config.Healthcheck.Interval || 0) / 1e6),
            timeout: Math.round((inspect.Config.Healthcheck.Timeout || 0) / 1e6),
            retries: inspect.Config.Healthcheck.Retries ?? 0,
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

/**
 * GET /api/containers/:id/stats/history?range=1h|24h|7d
 * 获取容器历史资源指标趋势（从 container_metrics 降采样查询）。
 *
 * range 取值：1h（默认，每 60 秒一点）/ 24h（每 600 秒一点）/ 7d（每 1800 秒一点）。
 * 返回：{ points: ContainerMetricPoint[] }
 */
router.get(
  '/:id/stats/history',
  asyncHandler(async (req: Request, res: Response) => {
    const rawRange = String(req.query.range || '1h');
    const range = rawRange === '24h' || rawRange === '7d' ? rawRange : '1h';
    const points = getContainerMetricsHistory(req.params.id, range);
    res.json({ points });
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
  requireOperator,
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
  requireAdmin,
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

    // 可选：健康检查配置覆盖（interval/timeout 单位 ms，转纳秒；Test=['NONE'] 表示禁用）
    let desiredHealthcheck: Dockerode.HealthConfig | undefined =
      inspect.Config?.Healthcheck || undefined;
    if (typeof req.body?.healthcheck === 'object' && req.body.healthcheck) {
      const hc = req.body.healthcheck;
      const test = Array.isArray(hc.test) ? hc.test : [];
      desiredHealthcheck = {
        Test: test.length ? test : ['NONE'],
        Interval: (Number(hc.interval) || 0) * 1e6,
        Timeout: (Number(hc.timeout) || 0) * 1e6,
        Retries: Number(hc.retries) || 0,
      };
    }

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
      Healthcheck: desiredHealthcheck,
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
 * 将「更新配置」请求体对 HostConfig 的增量改动应用到基线 hc 上。
 *
 * 仅覆盖请求中显式提供的字段（null/undefined/'' 视为未提供），未提供的字段保持 hc 现状。
 * 供单容器 /:id/update 与批量 /batch/update 复用，保证两者组装逻辑完全一致。
 *
 * 内存处理：显式传 memLimit 时设 Memory，若未显式传 memSwap 则按 docker 默认 swap=2x 内存
 * 同步 MemorySwap，避免 EINVAL。
 * CPU 处理：显式传 cpuLimit 时，>0 设 NanoCpus 并删除 CpuQuota（NanoCpus 与 CpuQuota 不能并存），
 * 0 则清空（取消限制）。
 *
 * @param b 请求体（可能包含 restartPolicy/maxRetry/memLimit/memSwap/memReservation/cpuLimit/cpuShares/cpusetCpus）
 * @param hc 以当前 HostConfig 为基线的目标对象（会被原地修改）
 */
function applyUpdateBodyToHostConfig(b: any, hc: any): void {
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
}

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
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const container = docker.getContainer(req.params.id);
    const b = req.body || {};
    const inspect = await container.inspect();
    const name = (inspect.Name || '').replace(/^\//, '');

    // 以当前 HostConfig 为基线，避免把未提供的字段清空
    const hc: any = { ...(inspect.HostConfig || {}) };
    // 将请求体中的增量改动应用到 hc（与批量更新共用同一组装逻辑）
    applyUpdateBodyToHostConfig(b, hc);

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
  requireOperator,
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
  requireAdmin,
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
  requireAdmin,
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
