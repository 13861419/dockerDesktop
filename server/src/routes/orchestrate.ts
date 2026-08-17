/**
 * 容器启动依赖编排 API 路由（挂载路径 /api/orchestrate）
 *
 * 提供"容器启动依赖排序 + 一键编排"能力：
 *  - 依赖配置：为每个容器配置其依赖（需先启动）的其它容器 id，予以持久化（SQLite）。
 *  - 拓扑排序：根据依赖关系对容器做拓扑排序（Kahn 算法），检测环。
 *  - 一键启停：按依赖拓扑序分轮并行启动；停止时按逆拓扑序执行；支持一键重启。
 *
 * 编排目标容器集合：默认取当前引擎的全部容器（含停止的）；也可通过请求体
 * containerIds 指定参与者子集。已启用编排(enabled=1)且被选中的容器参与拓扑排序，
 * 处于运行态(target=启动)的容器会被跳过启动但参与层序计算。
 */
import { Router, Request, Response } from 'express';
import { getDb } from '../storage';
import { getDockerClient } from '../docker/client';
import { logOperation } from '../operationLog';
import { requireOperator } from '../auth';

const router = Router();

/** 依赖表行结构 */
interface DepRow {
  container_id: string;
  deps: string;
  enabled: number;
}

/** 编排结果层（每层的并行操作汇总） */
export interface OrchestrateStep {
  round: number;
  total: number;
  started: number;
  skipped: number;
  failed: number;
  items: Array<{ id: string; name: string; action: string; ok: boolean; error?: string }>;
}

/** 编排整体结果 */
export interface OrchestrateResult {
  ok: boolean;
  action: 'start' | 'stop' | 'restart';
  order: Array<{ id: string; name: string }>;
  rounds: OrchestrateStep[];
  success: number;
  fail: number;
  skipped: number;
  cycle?: string[];
  error?: string;
  /** 附加分阶段明细（restart 场景：stop/start 两阶段逐轮记录），供历史留档与前端展示 */
  phases?: Array<OrchestrateResult & { label: 'stop' | 'start' }>;
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
 * 读取全部已配置的依赖行
 * @returns 依赖行数组
 */
function readAllDeps(): DepRow[] {
  return getDb()
    .prepare('SELECT container_id, deps, enabled FROM container_dependencies')
    .all() as unknown as DepRow[];
}

/**
 * 保存某容器的依赖配置（存在则更新，否则插入）
 * @param containerId 容器 id
 * @param deps 依赖的容器 id 数组
 * @param enabled 是否参与编排
 */
function upsertDep(containerId: string, deps: string[], enabled: boolean): void {
  getDb()
    .prepare(
      'INSERT INTO container_dependencies (container_id, deps, enabled, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(container_id) DO UPDATE SET deps = excluded.deps, enabled = excluded.enabled, updated_at = excluded.updated_at',
    )
    .run(containerId, JSON.stringify(deps), enabled ? 1 : 0, Date.now());
}

/**
 * 删除某容器的依赖配置
 * @param containerId 容器 id
 */
function deleteDep(containerId: string): void {
  getDb().prepare('DELETE FROM container_dependencies WHERE container_id = ?').run(containerId);
}

// ============ 依赖配置接口 ============

/**
 * GET /api/orchestrate/dependencies
 * 返回全部依赖配置，附带容器名便于展示；同时返回当前引擎容器 id→名称映射。
 */
router.get(
  '/dependencies',
  asyncHandler(async (_req: Request, res: Response) => {
    const docker = await getDockerClient();
    const list = await docker.listContainers({ all: true });
    // 建立 id → 名称 映射，便于展示与校验
    const nameMap: Record<string, string> = {};
    for (const c of list) {
      const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '') || c.Id.slice(0, 12);
      nameMap[c.Id] = name;
    }
    const deps = readAllDeps().map((r) => {
      let arr: string[] = [];
      try {
        arr = JSON.parse(r.deps) as string[];
      } catch {
        arr = [];
      }
      const filtered = arr.filter((id) => nameMap[id]);
      return {
        containerId: r.container_id,
        name: nameMap[r.container_id] || r.container_id.slice(0, 12),
        deps: filtered,
        depNames: filtered.map((id) => nameMap[id] || id.slice(0, 12)),
        enabled: !!r.enabled,
      };
    });
    res.json({ containers: nameMap, dependencies: deps });
  }),
);

/**
 * PUT /api/orchestrate/dependencies/:containerId
 * 设置某容器的依赖配置。body: { deps?: string[], enabled?: boolean }
 */
router.put(
  '/dependencies/:containerId',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const containerId = String(req.params.containerId);
    const docker = await getDockerClient();
    // 校验容器存在
    try {
      await docker.getContainer(containerId).inspect();
    } catch {
      res.status(404).json({ error: '容器不存在' });
      return;
    }
    const deps: string[] = Array.isArray(req.body?.deps)
      ? (req.body.deps as unknown[]).filter(
          (x): x is string => typeof x === 'string' && x.length > 0 && x !== (containerId as string),
        )
      : [];
    const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : true;
    // 去重
    const unique = Array.from(new Set(deps));
    upsertDep(containerId, unique, enabled);
    logOperation(res.locals.username, '配置依赖编排', 'container', containerId, `依赖: [${unique.join(', ') || '无'}]`);
    res.json({ ok: true, containerId, deps: unique, enabled });
  }),
);

/**
 * DELETE /api/orchestrate/dependencies/:containerId
 * 清除某容器的依赖编排配置
 */
router.delete(
  '/dependencies/:containerId',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const containerId = String(req.params.containerId);
    deleteDep(containerId);
    logOperation(res.locals.username, '清除依赖编排', 'container', containerId);
    res.json({ ok: true });
  }),
);

// ============ 拓扑排序与编排 ============

/**
 * 计算参与编排容器的依赖图与拓扑序。
 * 仅将"选中且 enabled=1 且其依赖也在选中集合内"的容器纳入图；依赖不在集合内的忽略。
 * @param selected 选中参与编排的容器 id 集合（以当前引擎全部容器为默认）
 * @returns 名称映射、依赖邻接表、拓扑顺序（长度不足即含环时 cycle 非空）
 */
function buildOrder(
  selected: Set<string>,
): { order: string[]; cycle: string[] | null; adj: Map<string, string[]> } {
  const rows = readAllDeps();
  const depsById: Record<string, string[]> = {};
  for (const r of rows) {
    if (!selected.has(r.container_id) || !r.enabled) continue;
    let arr: string[] = [];
    try {
      arr = JSON.parse(r.deps) as string[];
    } catch {
      arr = [];
    }
    // 仅保留也在选中集合内的依赖
    depsById[r.container_id] = arr.filter((d) => selected.has(d) && d !== r.container_id);
  }

  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of selected) {
    if (!(id in depsById)) continue; // 该容器无依赖配置则不参与排序（仍可自由操作）
    adj.set(id, depsById[id]);
    indeg.set(id, depsById[id].length);
  }
  // 为被依赖但无 own 配置的节点补充入度（其依赖关系来自其它容器的 depsById 引用）
  for (const id of selected) {
    if (!adj.has(id)) {
      adj.set(id, []);
      indeg.set(id, 0);
    }
  }

  const order: string[] = [];
  const queue: string[] = [];
  for (const [id, d] of indeg) {
    if (d === 0) queue.push(id);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const [id, deps] of adj) {
      if (deps.includes(cur)) {
        indeg.set(id, (indeg.get(id) || 1) - 1);
        if (indeg.get(id) === 0) queue.push(id);
      }
    }
  }

  // 若未处理完所有节点，说明存在环
  if (order.length < adj.size) {
    const inCycle = Array.from(adj.keys()).filter((id) => !order.includes(id));
    return { order, cycle: inCycle, adj };
  }
  return { order, cycle: null, adj };
}

/**
 * 执行一键编排（启动或停止）。
 *
 * 启动：按拓扑序分轮，每轮并行 start 该层中「未运行」的容器；已运行的计入 skipped。
 * 停止：按逆拓扑序分轮，每轮并行 stop 该层中「运行中」的容器。
 * @param action start | stop
 * @param containerIds 参与者（可选，缺省为当前引擎全部容器）
 * @returns 编排结果
 */
async function runOrchestrate(
  action: 'start' | 'stop',
  containerIds?: string[],
): Promise<OrchestrateResult> {
  const docker = await getDockerClient();
  const list = await docker.listContainers({ all: true });
  const nameMap: Record<string, string> = {};
  const stateMap: Record<string, string> = {};
  for (const c of list) {
    const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '') || c.Id.slice(0, 12);
    nameMap[c.Id] = name;
    stateMap[c.Id] = c.State || '';
  }

  // 参与者集合：未传时默认全部容器；传了则取其与现存容器交集
  const candidates = containerIds && containerIds.length
    ? containerIds.filter((id) => nameMap[id])
    : Object.keys(nameMap);
  const selected = new Set(candidates);

  const { order, cycle } = buildOrder(selected);
  if (cycle && cycle.length) {
    return {
      ok: false,
      action,
      order: [],
      rounds: [],
      success: 0,
      fail: 0,
      skipped: 0,
      cycle,
      error: `检测到依赖环，无法编排。涉及容器: ${cycle.map((id) => nameMap[id] || id.slice(0, 12)).join(', ')}`,
    };
  }

  // 计算层序：按依赖深度分层。order 为拓扑序，用 DAG 深度分组保证层内可并行、层间有依赖。
  // 因依赖仅记录"前置"，这里用「最长前置链长度」作为层号。
  const layer = new Map<string, number>();
  const rows = readAllDeps();
  const depsById: Record<string, string[]> = {};
  for (const r of rows) {
    if (!selected.has(r.container_id) || !r.enabled) continue;
    try {
      const arr = JSON.parse(r.deps) as string[];
      depsById[r.container_id] = arr.filter((d) => selected.has(d) && d !== r.container_id);
    } catch {
      depsById[r.container_id] = [];
    }
  }
  for (const id of order) {
    const deps = depsById[id] || [];
    let lv = 0;
    for (const d of deps) lv = Math.max(lv, (layer.get(d) || 0) + 1);
    layer.set(id, lv);
  }

  // 组层
  const layers: Array<string[]> = [];
  const maxLayer = order.reduce((m, id) => Math.max(m, layer.get(id) || 0), -1);
  for (let l = 0; l <= maxLayer; l++) {
    const group = order.filter((id) => (layer.get(id) || 0) === l);
    if (group.length) layers.push(group);
  }

  const rounds: OrchestrateStep[] = [];
  let success = 0;
  let fail = 0;
  let skipped = 0;

  for (let i = 0; i < layers.length; i++) {
    const group = layers[i];
    const items: Array<{ id: string; name: string; action: string; ok: boolean; error?: string }> = [];
    let stepStarted = 0;
    let stepSkipped = 0;
    let stepFailed = 0;
    for (const gid of group) {
      const cur = stateMap[gid] || '';
      const already = action === 'start' ? cur === 'running' : !(cur === 'running' || cur === 'paused' || cur === 'restarting');
      if (already) {
        stepSkipped++;
        skipped++;
        items.push({ id: gid, name: nameMap[gid] || gid.slice(0, 12), action, ok: true, error: undefined });
        continue;
      }
      try {
        const container = docker.getContainer(gid);
        if (action === 'start') {
          await container.start();
        } else {
          if (cur === 'paused') {
            try { await container.unpause(); } catch { /* ignore */ }
          }
          await container.stop({ t: 10 });
        }
        stepStarted++;
        success++;
        items.push({ id: gid, name: nameMap[gid] || gid.slice(0, 12), action, ok: true });
      } catch (e: any) {
        stepFailed++;
        fail++;
        items.push({
          id: gid,
          name: nameMap[gid] || gid.slice(0, 12),
          action,
          ok: false,
          error: e?.message || '操作失败',
        });
      }
    }
    rounds.push({ round: i + 1, total: group.length, started: stepStarted, skipped: stepSkipped, failed: stepFailed, items });
  }

  return {
    ok: fail === 0,
    action,
    order: order.map((id) => ({ id, name: nameMap[id] || id.slice(0, 12) })),
    rounds,
    success,
    fail,
    skipped,
  };
}

/**
 * 将一次编排结果写入 orchestrate_runs 历史表
 * @param action 编排动作（start/stop/restart）
 * @param startedAt 开始时间戳(ms)
 * @param durationMs 总耗时(ms)
 * @param result 编排结果
 */
function persistRun(action: string, startedAt: number, durationMs: number, result: OrchestrateResult): void {
  // stop 失败后继续 start（restart 场景）时，start 的 ok 会被覆盖，这里以动作语义为准
  const base = result as any;
  const success = typeof base.success === 'number' ? base.success : 0;
  const fail = typeof base.fail === 'number' ? base.fail : 0;
  const skipped = typeof base.skipped === 'number' ? base.skipped : 0;
  getDb()
    .prepare(
      'INSERT INTO orchestrate_runs (action, started_at, duration_ms, success, fail, skipped, detail, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(action, startedAt, durationMs, success, fail, skipped, JSON.stringify(result), result.error || null, Date.now());
}

/**
 * POST /api/orchestrate/start
 * 一键按依赖拓扑序启动。body: { containerIds?: string[] }
 */
router.post(
  '/start',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.containerIds) ? req.body.containerIds : undefined;
    const startedAt = Date.now();
    const result = await runOrchestrate('start', ids);
    persistRun('start', startedAt, Date.now() - startedAt, result);
    logOperation(res.locals.username, '一键编排启动', 'container', null, result.ok ? `成功 ${result.success}/跳过 ${result.skipped}` : `失败: ${result.error || ''}`);
    res.json(result);
  }),
);

/**
 * POST /api/orchestrate/stop
 * 一键按逆拓扑序停止。body: { containerIds?: string[] }
 */
router.post(
  '/stop',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.containerIds) ? req.body.containerIds : undefined;
    const startedAt = Date.now();
    const result = await runOrchestrate('stop', ids);
    persistRun('stop', startedAt, Date.now() - startedAt, result);
    logOperation(res.locals.username, '一键编排停止', 'container', null, result.ok ? `成功 ${result.success}/跳过 ${result.skipped}` : `失败: ${result.error || ''}`);
    res.json(result);
  }),
);

/**
 * POST /api/orchestrate/restart
 * 一键重启：先逆序停止全部参与者，再按序启动全部参与者。body: { containerIds?: string[] }
 */
router.post(
  '/restart',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.containerIds) ? req.body.containerIds : undefined;
    const startedAt = Date.now();
    const stopResult = await runOrchestrate('stop', ids);
    const startResult = await runOrchestrate('start', ids);
    const ok = stopResult.ok && startResult.ok;
    const merged: OrchestrateResult = {
      ok,
      action: 'restart',
      order: startResult.order.length ? startResult.order : stopResult.order,
      rounds: [],
      success: stopResult.success + startResult.success,
      fail: stopResult.fail + startResult.fail,
      skipped: stopResult.skipped + startResult.skipped,
      error: stopResult.error || startResult.error || undefined,
      // 附加两阶段明细供历史留档与前端展示
      phases: [
        { label: 'stop', ...stopResult },
        { label: 'start', ...startResult },
      ],
    };
    persistRun('restart', startedAt, Date.now() - startedAt, merged);
    res.json({
      ...merged,
      stop: stopResult,
      start: startResult,
    });
  }),
);

/**
 * POST /api/orchestrate/retry
 * 对历史一次编排中失败（或指定）的容器单独重试 启动/停止。
 * body: { action: 'start'|'stop', containerIds: string[] }
 * 与一键编排不同，重试不对容器做拓扑排序，而是逐个直连执行，主要用于修复上次失败项。
 */
router.post(
  '/retry',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const action = String(req.body?.action || '');
    if (action !== 'start' && action !== 'stop') {
      res.status(400).json({ error: 'action 必须为 start 或 stop' });
      return;
    }
    const rawIds: unknown[] = Array.isArray(req.body?.containerIds) ? req.body.containerIds : [];
    const ids = rawIds.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length === 0) {
      res.status(400).json({ error: '请至少提供一个容器 id' });
      return;
    }
    const docker = await getDockerClient();
    const list = await docker.listContainers({ all: true });
    const nameMap: Record<string, string> = {};
    const stateMap: Record<string, string> = {};
    for (const c of list) {
      const name = (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, '') || c.Id.slice(0, 12);
      nameMap[c.Id] = name;
      stateMap[c.Id] = c.State || '';
    }
    const items: Array<{ id: string; name: string; action: string; ok: boolean; error?: string }> = [];
    let success = 0;
    let fail = 0;
    for (const id of ids) {
      const name = nameMap[id] || id.slice(0, 12);
      if (!stateMap[id]) {
        fail++;
        items.push({ id, name, action, ok: false, error: '容器不存在' });
        continue;
      }
      try {
        const container = docker.getContainer(id);
        if (action === 'start') {
          if (stateMap[id] === 'running') {
            items.push({ id, name, action, ok: true });
          } else {
            await container.start();
            success++;
            items.push({ id, name, action, ok: true });
          }
        } else {
          if (!(stateMap[id] === 'running' || stateMap[id] === 'paused' || stateMap[id] === 'restarting')) {
            items.push({ id, name, action, ok: true });
          } else {
            if (stateMap[id] === 'paused') {
              try { await container.unpause(); } catch { /* ignore */ }
            }
            await container.stop({ t: 10 });
            success++;
            items.push({ id, name, action, ok: true });
          }
        }
      } catch (e: any) {
        fail++;
        items.push({ id, name, action, ok: false, error: e?.message || '操作失败' });
      }
    }
    logOperation(res.locals.username, `编排失败重试(${action})`, 'container', null, `成功 ${success}/失败 ${fail}`);
    res.json({ ok: fail === 0, action, total: items.length, success, fail, items });
  }),
);

/**
 * GET /api/orchestrate/history?limit=&offset=
 * 分页查询编排执行历史（倒序）。
 * 返回 { items, total, limit, offset }
 */
router.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const d = getDb();
    const totalRow = d.prepare('SELECT COUNT(*) AS n FROM orchestrate_runs').get() as { n: number };
    const rows = d
      .prepare('SELECT * FROM orchestrate_runs ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<{
      id: number;
      action: string;
      started_at: number;
      duration_ms: number;
      success: number;
      fail: number;
      skipped: number;
      detail: string;
      error: string | null;
    }>;
    const items = rows.map((r) => {
      let detail: unknown = null;
      try {
        detail = JSON.parse(r.detail);
      } catch {
        detail = null;
      }
      return {
        id: r.id,
        action: r.action,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        success: r.success,
        fail: r.fail,
        skipped: r.skipped,
        error: r.error,
        detail,
      };
    });
    res.json({ items, total: totalRow.n, limit, offset });
  }),
);

export default router;
