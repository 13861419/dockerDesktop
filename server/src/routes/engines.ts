/**
 * Docker 引擎管理 API 路由（挂载路径 /api/engines）
 *
 * 提供多 Docker 引擎的 CRUD 与切换能力。引擎配置持久化于 SQLite（docker_engines 表）。
 * 引擎变更（新增/修改/删除/切换）后统一调用 client.resetDockerCache() 使客户端缓存失效，
 * 并在切换/删除当前引擎时调用 events.restartEventMonitor() 让事件流对准新引擎。
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb, encryptSecret } from '../storage';
import { resetDockerCache, testEngineEndpoint, getDockerClientForEndpoint } from '../docker/client';
import { isSshEndpoint, closeSshBridge, closeAllSshBridges, loadEngineCredential, getSshDocker } from '../docker/sshDocker';
import { restartEventMonitor } from '../docker/events';
import { resetMonitorState } from '../docker/monitor';
import { resetContainerMetricsState } from '../docker/containerMetrics';
import { resetAlertingState } from '../alerting';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/** 引擎行结构 */
interface EngineRow {
  id: string;
  name: string;
  endpoint: string;
  is_current: number;
  created_at: number;
  updated_at: number;
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
 * 归一化端点输入：统一为 npipe:// / tcp:// / unix:// 形式
 * @param endpoint 原始输入
 * @returns 规整后的端点
 */
function normalizeEndpoint(endpoint: string): string {
  const e = String(endpoint || '').trim();
  if (!e) throw Object.assign(new Error('端点不能为空'), { statusCode: 400 });
  if (
    e.startsWith('npipe://') ||
    e.startsWith('unix://') ||
    e.startsWith('tcp://') ||
    e.startsWith('ssh://')
  ) {
    return e;
  }
  // 兼容老写法：直接给 socket 路径或无前缀
  if (/^[a-zA-Z]:[\\/]/.test(e) || e.startsWith('/')) {
    return 'npipe://' + e.replace(/\\/g, '/');
  }
  return e;
}

/**
 * 提取请求中的 SSH 凭证（password / privateKey / passphrase 任一非空即视为提供了凭证）
 * @param body 请求体
 */
function extractCredential(body: any): { password?: string; privateKey?: string; passphrase?: string } | undefined {
  const password = String(body?.password || '').trim();
  const privateKey = String(body?.privateKey || '').trim();
  const passphrase = String(body?.passphrase || '').trim();
  if (!password && !privateKey && !passphrase) return undefined;
  return { password: password || undefined, privateKey: privateKey || undefined, passphrase: passphrase || undefined };
}

/**
 * 加密序列化 SSH 凭证（存入 cred_encrypted 列）
 * @param cred SSH 凭证
 */
function serializeCredential(cred?: { password?: string; privateKey?: string; passphrase?: string }): string | null {
  if (!cred) return null;
  if (!cred.password && !cred.privateKey && !cred.passphrase) return null;
  return encryptSecret(JSON.stringify(cred));
}

/**
 * 读取某引擎已存的加密凭证列（未设置返回 null）
 * @param d 数据库句柄
 * @param id 引擎 ID
 */
function getCredColumn(d: any, id: string): string | null {
  try {
    const r = d.prepare('SELECT cred_encrypted FROM docker_engines WHERE id = ?').get(id) as { cred_encrypted: string | null } | undefined;
    return r?.cred_encrypted ?? null;
  } catch {
    return null;
  }
}

/**
 * 校验名称合法性
 * @param name 引擎名称
 */
function assertName(name: string): string {
  const n = String(name || '').trim();
  if (!n) throw Object.assign(new Error('引擎名称不能为空'), { statusCode: 400 });
  return n;
}

/**
 * GET /api/engines
 * 列出全部引擎，并标注当前引擎
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const d = getDb();
    const rows = d.prepare('SELECT id, name, endpoint, is_current, created_at, updated_at, cred_encrypted FROM docker_engines ORDER BY created_at').all() as any[];
    // 健康探测（1.45.0）：逐引擎并发 ping（3 秒超时），列表返回 online 标记
    const engines = await Promise.all(
      rows.map(async (r) => {
        let online = false;
        if (!r.endpoint) {
          online = true; // 本机引擎
        } else {
          try {
            const cred = isSshEndpoint(r.endpoint) ? loadEngineCredential(r.endpoint) : undefined;
            online = await Promise.race([
              testEngineEndpoint(r.endpoint, cred),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
            ]);
          } catch {
            online = false;
          }
        }
        return {
          id: r.id,
          name: r.name,
          endpoint: r.endpoint,
          isCurrent: !!r.is_current,
          online,
          isSsh: isSshEndpoint(r.endpoint),
          hasCredential: isSshEndpoint(r.endpoint) ? !!r.cred_encrypted : undefined,
        };
      }),
    );
    res.json({ engines });
  }),
);

/**
 * POST /api/engines
 * 新增引擎（校验端点连通性）；若为第一个引擎则自动设为当前
 * @body name     引擎名称
 * @body endpoint 引擎端点
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const name = assertName(req.body?.name);
    const endpoint = normalizeEndpoint(req.body?.endpoint);
    const cred = extractCredential(req.body);

    const d = getDb();
    const count = (d.prepare('SELECT count(*) AS c FROM docker_engines').get() as { c: number }).c;

    const ok = await testEngineEndpoint(endpoint, cred);
    if (!ok) {
      return res.status(400).json({ error: isSshEndpoint(endpoint) ? '无法连接该 SSH 端点，请检查地址、账号与凭证' : '无法连接该 Docker 端点，请检查地址与协议' });
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const isCurrent = count === 0 ? 1 : 0;
    d.prepare(
      'INSERT INTO docker_engines (id, name, endpoint, is_current, created_at, updated_at, cred_encrypted) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, name, endpoint, isCurrent, now, now, serializeCredential(cred));

    if (isCurrent) resetDockerCache();
    logOperation(res.locals.username, '新增Docker引擎', '引擎', name, isCurrent ? '(设为当前)' : undefined);
    res.json({ ok: true, id, isCurrent: !!isCurrent });
  }),
);

/**
 * PUT /api/engines/:id
 * 更新引擎（名称/端点；端点变更时验证连通性）
 * @body name     引擎名称（可选）
 * @body endpoint 引擎端点（可选，变更时校验）
 */
router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT id, name, endpoint, is_current FROM docker_engines WHERE id = ?').get(id) as EngineRow | undefined;
    if (!row) return res.status(404).json({ error: '引擎不存在' });

    const name = req.body?.name !== undefined ? assertName(req.body.name) : row.name;
    let endpoint = row.endpoint;
    if (req.body?.endpoint !== undefined && String(req.body.endpoint).trim() !== row.endpoint) {
      endpoint = normalizeEndpoint(req.body.endpoint);
      const ok = await testEngineEndpoint(endpoint, extractCredential(req.body));
      if (!ok) return res.status(400).json({ error: isSshEndpoint(endpoint) ? '无法连接该 SSH 端点，请检查地址、账号与凭证' : '无法连接该 Docker 端点，请检查地址与协议' });
    }

    // SSH 凭证：请求体提供了凭证字段就覆盖；否则保留已存凭证
    const cred = extractCredential(req.body);
    const credEncrypted = cred ? serializeCredential(cred) : getCredColumn(d, id);

    d.prepare('UPDATE docker_engines SET name = ?, endpoint = ?, updated_at = ?, cred_encrypted = ? WHERE id = ?').run(
      name,
      endpoint,
      Date.now(),
      credEncrypted,
      id,
    );

    // 端点变更时关闭旧 SSH bridge（如有）
    if (row.endpoint !== endpoint) closeSshBridge(row.endpoint);

    // 若更新的是当前引擎，需清缓存使新端点生效
    if (row.is_current) {
      resetDockerCache();
      restartEventMonitor();
      // 重置监控/指标/告警内部状态，避免旧引擎残留数据污染新引擎展示
      resetMonitorState();
      resetContainerMetricsState();
      resetAlertingState();
    }
    logOperation(res.locals.username, '更新Docker引擎', '引擎', name);
    res.json({ ok: true });
  }),
);

/**
 * DELETE /api/engines/:id
 * 删除引擎；若为当前引擎则拒绝（需先切换），避免留下无引擎状态
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT id, name, is_current FROM docker_engines WHERE id = ?').get(id) as EngineRow | undefined;
    if (!row) return res.status(404).json({ error: '引擎不存在' });
    if (row.is_current) {
      return res.status(400).json({ error: '不能删除当前使用的引擎，请先切换到其他引擎' });
    }
    d.prepare('DELETE FROM docker_engines WHERE id = ?').run(id);
    closeSshBridge(row.endpoint);
    logOperation(res.locals.username, '删除Docker引擎', '引擎', row.name);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/engines/:id/switch
 * 将指定引擎设为当前引擎
 */
router.post(
  '/:id/switch',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT id, name FROM docker_engines WHERE id = ?').get(id) as EngineRow | undefined;
    if (!row) return res.status(404).json({ error: '引擎不存在' });

    // 验证引擎可连
    const full = d.prepare('SELECT endpoint FROM docker_engines WHERE id = ?').get(id) as { endpoint: string };
    const ok = await testEngineEndpoint(full.endpoint, isSshEndpoint(full.endpoint) ? loadEngineCredential(full.endpoint) : undefined);
    if (!ok) return res.status(400).json({ error: '该引擎当前不可达，无法切换' });

    // 关闭旧当前引擎的 SSH bridge（如有），避免空闲连接残留
    const oldCurrent = d.prepare('SELECT endpoint FROM docker_engines WHERE is_current = 1').get() as { endpoint: string } | undefined;
    if (oldCurrent?.endpoint && isSshEndpoint(oldCurrent.endpoint) && oldCurrent.endpoint !== full.endpoint) {
      closeSshBridge(oldCurrent.endpoint);
    }

    const now = Date.now();
    d.prepare('UPDATE docker_engines SET is_current = 0, updated_at = ? WHERE is_current = 1').run(now);
    d.prepare('UPDATE docker_engines SET is_current = 1, updated_at = ? WHERE id = ?').run(now, id);

    // 引擎变化：清客户端缓存 + 重启事件流
    resetDockerCache();
    restartEventMonitor();
    // 重置监控/指标/告警内部状态，避免跨引擎残留数据造成误报或展示错乱
    resetMonitorState();
    resetContainerMetricsState();
    resetAlertingState();

    logOperation(res.locals.username, '切换Docker引擎', '引擎', row.name);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/engines/batch-prune
 * 跨引擎批量清理（1.39.0）：对多台引擎批量执行 prune。
 * body: { engineIds: string[], types?: string[], untilHours?: number }
 * types 为 ['containers','images','volumes','networks'] 子集（缺省全部）；
 * untilHours 提供时仅清理超过该小时数未使用的对象（卷 prune 的 until 需 Docker ≥ 23 / API 1.42）。
 */
router.post(
  '/batch-prune',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const ids: string[] = Array.isArray(req.body?.engineIds)
      ? req.body.engineIds.map((x: unknown) => String(x)).filter(Boolean)
      : [];
    const VALID_TYPES = ['containers', 'images', 'volumes', 'networks'];
    const legacyType = ['containers', 'images', 'both'].includes(req.body?.type) ? req.body.type : null;
    let types: string[] = Array.isArray(req.body?.types)
      ? req.body.types.map((x: unknown) => String(x)).filter((x: string) => VALID_TYPES.includes(x))
      : [];
    if (!types.length && legacyType) types = legacyType === 'both' ? ['containers', 'images'] : [legacyType];
    if (!types.length) types = ['containers', 'images'];
    types = [...new Set(types)].filter((t) => VALID_TYPES.includes(t));
    const untilHours = Number(req.body?.untilHours);
    const filters: Record<string, string[]> | null =
      Number.isFinite(untilHours) && untilHours > 0 ? { until: [`${Math.floor(untilHours)}h`] } : null;
    const dryRun = req.body?.dryRun === true;
    if (ids.length === 0) return res.status(400).json({ error: '需要 engineIds 参数' });
    const d = getDb();
    const results: Array<{
      engineId: string;
      name: string;
      endpoint: string;
      ok: boolean;
      prunedContainers: number;
      prunedImages: number;
      prunedVolumes: number;
      prunedNetworks: number;
      detail: string;
    }> = [];
    for (const id of ids) {
      const row = d.prepare('SELECT id, name, endpoint FROM docker_engines WHERE id = ?').get(id) as
        | { id: string; name: string; endpoint: string }
        | undefined;
      if (!row) {
        results.push({ engineId: id, name: '', endpoint: '', ok: false, prunedContainers: 0, prunedImages: 0, prunedVolumes: 0, prunedNetworks: 0, detail: '引擎不存在' });
        continue;
      }
      const out: any = { engineId: id, name: row.name, endpoint: row.endpoint, ok: true, prunedContainers: 0, prunedImages: 0, prunedVolumes: 0, prunedNetworks: 0, detail: '', preview: [] as string[] };
      try {
        // SSH 引擎经 SSH bridge 获取客户端；其余走端点直连
        const client = isSshEndpoint(row.endpoint)
          ? await getSshDocker(row.endpoint, loadEngineCredential(row.endpoint))
          : getDockerClientForEndpoint(row.endpoint);
        const opts: any = filters ? { filters } : {};
        const skipped: string[] = [];
        if (dryRun) {
          // 预览模式（1.41.0）：只列出将删除的对象，不执行 prune
          const preview: string[] = [];
          if (types.includes('containers')) {
            const list = (await client.listContainers({ all: true })) as any[];
            for (const c of list) {
              if ((c.State || '') !== 'running') {
                preview.push(`容器 ${(c.Names?.[0] || '').replace(/^\//, '')}（${String(c.Image || '')}）`);
                out.prunedContainers++;
              }
            }
          }
          if (types.includes('images')) {
            const imgs = (await client.listImages({ filters: { dangling: ['true'] } })) as any[];
            for (const img of imgs) {
              preview.push(`悬空镜像 ${img.RepoDigests?.[0]?.split('@')[0] || img.Id?.slice(0, 12) || ''}`);
              out.prunedImages++;
            }
          }
          if (types.includes('volumes')) {
            if (filters) {
              skipped.push('卷不支持按年龄过滤已跳过');
            } else {
              const vols = (await client.listVolumes({ filters: { dangling: ['true'] } })) as any;
              for (const v of vols?.Volumes || []) {
                preview.push(`卷 ${v.Name}`);
                out.prunedVolumes++;
              }
            }
          }
          if (types.includes('networks')) {
            const nets = (await client.listNetworks()) as any[];
            for (const n of nets) {
              if (['bridge', 'host', 'none'].includes(n.Name)) continue;
              const inUse = n.Containers && Object.keys(n.Containers).length > 0;
              if (!inUse) {
                preview.push(`网络 ${n.Name}`);
                out.prunedNetworks++;
              }
            }
          }
          out.preview = preview.slice(0, 20);
          out.detail =
            `预览：将清理容器 ${out.prunedContainers} 个，镜像 ${out.prunedImages} 个，卷 ${out.prunedVolumes} 个，网络 ${out.prunedNetworks} 个` +
            (filters ? `（仅 ${untilHours} 小时前未使用）` : '') +
            (skipped.length ? `；${skipped.join('、')}` : '');
        } else {
          if (types.includes('containers')) {
            const r = await (client as any).pruneContainers(opts);
            out.prunedContainers = Number(r?.ContainersDeleted) || 0;
          }
          if (types.includes('images')) {
            const r = await (client as any).pruneImages(opts);
            out.prunedImages = Array.isArray(r?.ImagesDeleted) ? r.ImagesDeleted.length : 0;
          }
          if (types.includes('volumes')) {
            if (filters) {
              skipped.push('卷不支持按年龄过滤已跳过');
            } else {
              const r = await (client as any).pruneVolumes({});
              out.prunedVolumes = Array.isArray(r?.VolumesDeleted) ? r.VolumesDeleted.length : 0;
            }
          }
          if (types.includes('networks')) {
            const r = await (client as any).pruneNetworks(opts);
            out.prunedNetworks = Array.isArray(r?.NetworksDeleted) ? r.NetworksDeleted.length : 0;
          }
          out.detail =
            `容器 ${out.prunedContainers} 个，镜像 ${out.prunedImages} 个，卷 ${out.prunedVolumes} 个，网络 ${out.prunedNetworks} 个` +
            (filters ? `（仅 ${untilHours} 小时前未使用）` : '') +
            (skipped.length ? `；${skipped.join('、')}` : '');
        }
      } catch (err: any) {
        out.ok = false;
        out.detail = err?.message || '清理失败';
      }
      results.push(out);
    }
    logOperation(
      res.locals.username,
      '跨引擎批量清理',
      '引擎',
      results.map((r) => r.name).filter(Boolean).join(', '),
      `types: ${types.join('/')}${filters ? `, until: ${untilHours}h` : ''}${dryRun ? ', dryRun' : ''}`,
      results.every((r) => r.ok),
    );
    res.json({ ok: results.every((r) => r.ok), results });
  }),
);

export default router;
