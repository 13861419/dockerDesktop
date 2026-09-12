/**
 * Docker Compose 项目管理 API 路由
 *
 * 通过调用 docker CLI 的 compose 子命令（Windows 下 Docker Desktop 自带）实现。
 * 每个 Compose 项目对应一个工作目录，其中包含 compose 文件。
 */
import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logOperation } from '../operationLog';
import { requireAdmin, requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { maybeGateOrForbidden } from '../approvals';
import { getDockerClient, getDockerClientForEndpoint } from '../docker/client';
import { inferCompose, type InferInput } from '../composeInfer';
import { parseRunCommand } from '../run2compose';

const execAsync = promisify(exec);
const router = Router();

/** Compose 项目存放在该根目录下（默认系统临时目录的 docker-compose-projects） */
const COMPOSE_ROOT = process.env.COMPOSE_ROOT
  ? process.env.COMPOSE_ROOT
  : path.join(os.tmpdir(), 'docker-compose-projects');

/** 允许的 compose 文件名 */
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * 统一兜底错误处理
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
 * 安全地执行 shell 命令，捕获 stdout / stderr
 * @param cmd 要执行的命令
 * @param cwd 工作目录
 * @returns 命令输出
 */
async function runCmd(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err: any) {
    const detail = err?.stderr || err?.message || '命令执行失败';
    const apiErr: any = new Error(detail);
    apiErr.statusCode = 400;
    throw apiErr;
  }
}

/**
 * 获取指定项目目录下实际存在的 compose 文件名
 * @param dir 项目目录
 * @returns 找到的 compose 文件名，未找到返回 null
 */
function findComposeFile(dir: string): string | null {
  for (const name of COMPOSE_FILES) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

/**
 * 列出 Compose 根目录下的所有项目目录
 * @returns 项目目录名数组
 */
function listProjectDirs(): string[] {
  if (!fs.existsSync(COMPOSE_ROOT)) return [];
  return fs
    .readdirSync(COMPOSE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * 确保目录存在
 * @param dir 目录路径
 */
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * docker CLI 是否可用（模块级缓存探测结果，避免每次校验都 spawn 一次）
 */
let dockerCliChecked = false;
let dockerCliAvailable = false;

/**
 * 探测 docker CLI 是否可用（`docker --version`）。
 * 结果缓存在模块级，避免每次校验都重复探测。
 */
async function isDockerCliAvailable(): Promise<boolean> {
  if (dockerCliChecked) return dockerCliAvailable;
  dockerCliChecked = true;
  try {
    await execAsync('docker --version', { maxBuffer: 1024 * 1024 });
    dockerCliAvailable = true;
  } catch {
    dockerCliAvailable = false;
  }
  return dockerCliAvailable;
}

/**
 * 校验 compose YAML 语法：将内容写入临时文件后调用 `docker compose config` 校验。
 * 零第三方依赖（复用 docker CLI 自带解析器），可检测 YAML 语法错误（含行号）。
 * 当 docker CLI 不可用（未安装 / 不在 PATH）时优雅降级：跳过校验并返回 null（允许保存），
 * 避免因环境缺少 docker 命令导致所有 Compose 保存被误判为失败。
 * @param content compose YAML 内容
 * @returns 校验通过（或跳过）返回 null；否则返回错误信息（尽量提取行号，便于编辑器定位）
 */
async function validateComposeYaml(content: string): Promise<string | null> {
  const dockerAvailable = await isDockerCliAvailable();
  if (!dockerAvailable) {
    return null; // docker CLI 不可用：跳过校验，不阻断保存
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-validate-'));
  const tmpFile = path.join(tmpDir, 'docker-compose.yml');
  try {
    fs.writeFileSync(tmpFile, content, 'utf8');
    // docker compose config 解析失败时 stderr 会给出含行号的语法错误
    await execAsync(`docker compose -f "${tmpFile}" config`, {
      cwd: tmpDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return null;
  } catch (err: any) {
    // 提取 "line N, column M" 之类的定位信息，返回给前端做行级提示
    const raw = err?.stderr || err?.message || 'YAML 语法错误';
    let msg = String(raw).trim().split('\n').filter(Boolean).slice(0, 4).join('\n');
    const lineMatch = String(raw).match(/line\s+(\d+)/i);
    if (!lineMatch) {
      // composer 可能以 "  on line 3" 形式返回，尝试提取首个数字行号
      const num = String(raw).match(/:\s*(\d+)/);
      if (num && Number(num[1]) <= 100000) {
        msg += `\n（约第 ${num[1]} 行）`;
      }
    }
    return msg || 'YAML 语法错误';
  } finally {
    // 无论成败都清理临时目录
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

// ============ 项目列表 ============

/**
 * GET /api/compose
 * 获取本机所有 compose 项目（本地目录中定义的）
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const dirs = listProjectDirs();
    const projects = dirs.map((name) => {
      const dir = path.join(COMPOSE_ROOT, name);
      const composeFile = findComposeFile(dir);
      return {
        name,
        path: dir,
        composeFile,
        hasCompose: !!composeFile,
      };
    });
    res.json(projects);
  }),
);

// ============ docker run → Compose 转换 ============

/**
 * POST /api/compose/run2compose
 * body: { command: string }
 * 解析 docker run 命令并转换为 compose service YAML（纯解析，不落盘）
 */
router.post('/run2compose', requireAuth, (req: Request, res: Response) => {
  const command = String(req.body?.command || '').trim();
  if (!command) {
    return res.status(400).json({ error: '缺少 docker run 命令' });
  }
  try {
    const result = parseRunCommand(command);
    logOperation(res.locals.username, 'docker run 转 Compose', 'compose', result.service.name, command.slice(0, 200), true);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || '解析失败' });
  }
});

// ============ 项目详情 ============

/**
 * GET /api/compose/:name
 * 获取项目详情（通过 docker compose ps 获取运行状态）
 */
router.get(
  '/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    const psOutput = await runCmd(`docker compose -f "${composeFile}" ps -a --format json`, dir);
    let services: any[] = [];
    try {
      services = JSON.parse(psOutput.trim() || '[]');
    } catch {
      services = [];
    }
    res.json({ name: req.params.name, path: dir, composeFile, services });
  }),
);

/**
 * GET /api/compose/:name/config
 * 获取项目的组合配置（docker compose config）
 */
router.get(
  '/:name/config',
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    const output = await runCmd(`docker compose -f "${composeFile}" config`, dir);
    res.json({ config: output });
  }),
);

/**
 * GET /api/compose/:name/stats
 * 项目级资源看板（1.34.0）：按 com.docker.compose.project 标签找项目容器，
 * 逐容器取 stats 后按 service 标签聚合成每服务 CPU / 内存 / 网络 / IO 汇总。
 */
router.get(
  '/:name/stats',
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const all = await docker.listContainers({ all: false });
    const members = all.filter(
      (c) => c.Labels?.['com.docker.compose.project'] === req.params.name,
    );
    const byService = new Map<
      string,
      { name: string; containers: number; cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number; ioR: number; ioW: number }
    >();
    await Promise.all(
      members.map(async (c) => {
        const svc = c.Labels?.['com.docker.compose.service'] || c.Names?.[0]?.replace(/^\//, '') || c.Id.slice(0, 12);
        try {
          const s = (await docker.getContainer(c.Id).stats({ stream: false })) as any;
          const cpuDelta =
            (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
          const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
          const online = s.cpu_stats?.online_cpus || 1;
          const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * online * 100 : 0;
          let netRx = 0;
          let netTx = 0;
          for (const k of Object.keys(s.networks || {})) {
            netRx += s.networks[k].rx_bytes || 0;
            netTx += s.networks[k].tx_bytes || 0;
          }
          let ioR = 0;
          let ioW = 0;
          for (const io of s.blkio_stats?.io_service_bytes_recursive || []) {
            if (io.op === 'Read' || io.op === 'read') ioR += io.value || 0;
            else if (io.op === 'Write' || io.op === 'write') ioW += io.value || 0;
          }
          const cur =
            byService.get(svc) ||
            { name: svc, containers: 0, cpuPercent: 0, memUsage: 0, memLimit: 0, netRx: 0, netTx: 0, ioR: 0, ioW: 0 };
          cur.containers += 1;
          cur.cpuPercent += cpu;
          cur.memUsage += s.memory_stats?.usage || 0;
          cur.memLimit += s.memory_stats?.limit || 0;
          cur.netRx += netRx;
          cur.netTx += netTx;
          cur.ioR += ioR;
          cur.ioW += ioW;
          byService.set(svc, cur);
        } catch {
          // 单容器 stats 失败不影响整体
        }
      }),
    );
    const services = [...byService.values()].map((s) => ({
      ...s,
      cpuPercent: Number(s.cpuPercent.toFixed(2)),
    }));
    res.json({ name: req.params.name, services });
  }),
);

/**
 * 等待 compose 服务容器进入健康状态（1.35.0）：
 * 要求容器运行中；若配置了 healthcheck 则进一步要求 healthy。
 * @param projectName compose 项目名
 * @param service 服务名
 * @param timeoutMs 最长等待毫秒
 */
async function waitForServiceHealthy(
  projectName: string,
  service: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const docker = await getDockerClient();
  const deadline = Date.now() + timeoutMs;
  let lastDetail = '容器不存在';
  while (Date.now() < deadline) {
    try {
      const all = (await docker.listContainers({ all: true })) as any[];
      const c = all.find(
        (x) =>
          x.Labels?.['com.docker.compose.project'] === projectName &&
          x.Labels?.['com.docker.compose.service'] === service,
      );
      if (c) {
        const insp = await docker.getContainer(c.Id).inspect();
        if (!insp.State?.Running && !insp.State?.Restarting) {
          lastDetail = `容器已退出（${insp.State?.Status || 'unknown'}${
            insp.State?.ExitCode != null ? '，exit ' + insp.State.ExitCode : ''
          }）`;
        } else if (insp.State?.Restarting) {
          lastDetail = '容器正在反复重启';
        } else if (insp.Config?.Healthcheck) {
          const health = insp.State?.Health?.Status || 'starting';
          lastDetail = `健康检查：${health}`;
          if (health === 'healthy') return { ok: true, detail: '健康检查通过' };
        } else {
          return { ok: true, detail: '容器运行中' };
        }
      }
    } catch (err: any) {
      lastDetail = err?.message || '检查失败';
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, detail: lastDetail };
}

/**
 * 单服务滚动更新核心逻辑（pull → 重建 → 健康检查 → 失败回滚）。
 * 供单服务与全项目滚动更新两条路由复用（1.37.0 抽取）。
 */
async function rollingUpdateOne(
  projectName: string,
  composeFile: string,
  dir: string,
  service: string,
): Promise<{ ok: boolean; healthOk: boolean; rolledBack: boolean; detail: string; output: string }> {
  const docker = await getDockerClient();
  // 更新前记录当前镜像（用于失败回滚）
  let oldImageId = '';
  let imageTag = '';
  try {
    const all = (await docker.listContainers({ all: true })) as any[];
    const c = all.find(
      (x) =>
        x.Labels?.['com.docker.compose.project'] === projectName &&
        x.Labels?.['com.docker.compose.service'] === service,
    );
    if (c) {
      const insp = await docker.getContainer(c.Id).inspect();
      oldImageId = insp.Image || '';
      imageTag = insp.Config?.Image || '';
    }
  } catch {
    // 记录失败不阻断更新
  }
  const pullOut = await runCmd(`docker compose -f "${composeFile}" pull ${service}`, dir);
  const upOut = await runCmd(
    `docker compose -f "${composeFile}" up -d --no-deps ${service}`,
    dir,
  );
  // 健康检查 + 失败自动回滚
  const health = await waitForServiceHealthy(projectName, service, 60000);
  let rolledBack = false;
  let rollbackDetail = '';
  if (!health.ok && oldImageId && imageTag && !imageTag.startsWith('sha256:')) {
    try {
      await execAsync(`docker tag "${oldImageId}" "${imageTag}"`);
      await runCmd(`docker compose -f "${composeFile}" up -d --no-deps ${service}`, dir);
      const back = await waitForServiceHealthy(projectName, service, 30000);
      rolledBack = back.ok;
      rollbackDetail = back.ok ? '已自动回滚到旧镜像' : `回滚后仍异常：${back.detail}`;
    } catch (err: any) {
      rolledBack = false;
      rollbackDetail = '回滚失败：' + String(err?.message || err);
    }
  } else if (!health.ok) {
    rollbackDetail = oldImageId ? '旧镜像为摘要引用，无法自动回滚' : '';
  }
  const finalOk = health.ok || rolledBack;
  return {
    ok: finalOk,
    healthOk: health.ok,
    rolledBack,
    detail: health.ok ? health.detail : rollbackDetail || health.detail,
    output: `${pullOut}\n${upOut}`.trim(),
  };
}

/**
 * POST /api/compose/:name/rolling-update
 * 服务级滚动更新（1.34.0）：pull 最新镜像后仅重建该服务（--no-deps 不影响其他服务）。
 * 安全网（1.35.0）：更新后健康检查（60s 内须保持运行；配置 healthcheck 时须 healthy），
 * 失败自动回滚——把旧镜像重新打回原 tag 后再次 up 重建。
 * body: { service }
 */
router.post(
  '/:name/rolling-update',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    const service = String(req.body?.service || '').trim();
    if (!service || /[^\w-.]/.test(service)) {
      return res.status(400).json({ error: '缺少或非法的 service 参数' });
    }
    const r = await rollingUpdateOne(req.params.name, composeFile, dir, service);
    logOperation(
      res.locals.username,
      '服务滚动更新',
      'compose',
      req.params.name,
      `service: ${service}${r.healthOk ? '；健康检查通过' : r.rolledBack ? '；已自动回滚' : '；健康检查失败'}`,
      r.ok,
    );
    res.json({
      ok: r.ok,
      healthOk: r.healthOk,
      rolledBack: r.rolledBack,
      detail: r.detail,
      output: r.output,
    });
  }),
);

/**
 * POST /api/compose/:name/rolling-update-all
 * 全项目滚动更新编排（1.37.0）：按 compose 定义顺序逐个服务滚动更新
 * （pull → 重建 → 健康检查 → 失败回滚），单服务失败默认继续下一服务。
 * body: { services?: string[], stopOnFailure?: boolean }
 */
router.post(
  '/:name/rolling-update-all',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    // 服务列表：优先取请求指定，否则取 compose 配置中的全部服务（定义顺序）
    let services: string[] = Array.isArray(req.body?.services)
      ? req.body.services.map((x: unknown) => String(x).trim()).filter(Boolean)
      : [];
    if (services.length === 0) {
      const out = await execAsync(`docker compose -f "${composeFile}" config --services`, {
        cwd: dir,
        maxBuffer: 1024 * 1024,
      });
      services = out.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    }
    if (services.length === 0) {
      return res.status(400).json({ error: '未找到任何可更新的服务' });
    }
    const stopOnFailure = !!req.body?.stopOnFailure;
    const results: Array<{
      service: string;
      ok: boolean;
      healthOk: boolean;
      rolledBack: boolean;
      detail: string;
    }> = [];
    for (const service of services) {
      const r = await rollingUpdateOne(req.params.name, composeFile, dir, service);
      results.push({
        service,
        ok: r.ok,
        healthOk: r.healthOk,
        rolledBack: r.rolledBack,
        detail: r.detail,
      });
      if (!r.ok && stopOnFailure) break;
    }
    const failed = results.filter((r) => !r.ok);
    const allOk = failed.length === 0;
    logOperation(
      res.locals.username,
      '项目滚动更新',
      'compose',
      req.params.name,
      `共 ${services.length} 个服务：成功 ${results.length - failed.length}，失败 ${failed.length}${
        failed.length ? '（' + failed.map((f) => f.service).join(', ') + '）' : ''
      }`,
      allOk,
    );
    res.json({
      ok: allOk,
      results,
      summary: `共 ${services.length} 个服务：成功 ${results.length - failed.length}，失败 ${failed.length}`,
    });
  }),
);

/**
 * GET /api/compose/:name/drift?endpoint=<engine-url>
 * 远端配置漂移检测（1.37.0）：将本地 compose 配置与目标引擎上带项目标签的
 * 实际容器逐服务比对（镜像 / 端口 / 环境变量 / 重启策略），报告缺失、多余与漂移项。
 * endpoint 为空时比对本地引擎。
 */
router.get(
  '/:name/drift',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    // 本地期望配置（docker compose config 规范化输出）
    const output = await runCmd(`docker compose -f "${composeFile}" config --format json`, dir);
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    const parsed =
      jsonStart >= 0 && jsonEnd > jsonStart
        ? JSON.parse(output.slice(jsonStart, jsonEnd + 1))
        : null;
    const serviceConfigs: Record<string, any> = parsed?.services || {};

    // 目标引擎客户端（endpoint 为空 = 本地）
    const endpoint = String(req.query.endpoint || '').trim();
    const client = endpoint ? getDockerClientForEndpoint(endpoint) : await getDockerClient();
    const containers = (await client.listContainers({ all: true })) as any[];
    const projectContainers = containers.filter(
      (c) => c.Labels?.['com.docker.compose.project'] === req.params.name,
    );

    // 按服务名聚合远端容器
    const remoteByService = new Map<string, any[]>();
    for (const c of projectContainers) {
      const svc = c.Labels?.['com.docker.compose.service'] || '';
      if (!svc) continue;
      if (!remoteByService.has(svc)) remoteByService.set(svc, []);
      remoteByService.get(svc)!.push(c);
    }

    const pubPortsOf = (ports: any): string[] => {
      const out: string[] = [];
      for (const [key, bindings] of Object.entries(ports || {})) {
        for (const b of bindings as any[]) {
          if (b?.HostPort) out.push(`${b.HostPort}:${key}`);
        }
      }
      return out.sort();
    };
    const envOf = (env: string[] | undefined): Record<string, string> => {
      const map: Record<string, string> = {};
      for (const e of env || []) {
        const i = e.indexOf('=');
        if (i > 0) map[e.slice(0, i)] = e.slice(i + 1);
      }
      return map;
    };

    const services: Array<{
      service: string;
      status: 'match' | 'drift' | 'localOnly' | 'remoteOnly';
      diffs: string[];
      local: { image: string; ports: string[]; restart: string; env: Record<string, string> };
      remote: { image: string; ports: string[]; restart: string; env: Record<string, string>; state: string } | null;
      containers: number;
    }> = [];

    for (const [svc, cfg] of Object.entries(serviceConfigs)) {
      const localEnv = envOf(normalizeEnvironment(cfg.environment));
      const localPorts: string[] = (cfg.ports || [])
        .map((p: any) => (p.published ? `${p.published}:${p.target}/${p.protocol || 'tcp'}` : ''))
        .filter(Boolean)
        .sort();
      const localRestart = cfg.restart || '';
      const local = {
        image: cfg.image || '',
        ports: localPorts,
        restart: localRestart,
        env: localEnv,
      };

      const rcs = remoteByService.get(svc) || [];
      if (rcs.length === 0) {
        services.push({ service: svc, status: 'localOnly', diffs: ['missing'], local, remote: null, containers: 0 });
        continue;
      }
      // 多副本时取第一个比对（面板代理部署为单副本模型）
      const insp = await client.getContainer(rcs[0].Id).inspect();
      const remoteEnv = envOf(insp.Config?.Env || []);
      const remotePorts = pubPortsOf(insp.NetworkSettings?.Ports);
      const remoteRestart = insp.HostConfig?.RestartPolicy?.Name || '';
      const remote = {
        image: insp.Config?.Image || '',
        ports: remotePorts,
        restart: remoteRestart,
        env: remoteEnv,
        state: insp.State?.Status || '',
      };
      const diffs: string[] = [];
      if (local.image && remote.image && local.image !== remote.image) diffs.push('image');
      for (const [k, v] of Object.entries(localEnv)) {
        if (!(k in remoteEnv) || remoteEnv[k] !== v) {
          diffs.push('env');
          break;
        }
      }
      if (localPorts.join(',') !== remotePorts.join(',')) diffs.push('ports');
      if (localRestart && remoteRestart && localRestart !== remoteRestart) diffs.push('restart');
      services.push({
        service: svc,
        status: diffs.length ? 'drift' : 'match',
        diffs,
        local,
        remote,
        containers: rcs.length,
      });
    }

    // 远端存在但本地配置没有的服务
    for (const [svc] of remoteByService) {
      if (serviceConfigs[svc]) continue;
      services.push({
        service: svc,
        status: 'remoteOnly',
        diffs: ['remoteOnly'],
        local: { image: '', ports: [], restart: '', env: {} },
        remote: null,
        containers: remoteByService.get(svc)!.length,
      });
    }

    const driftCount = services.filter((s) => s.status !== 'match').length;
    res.json({ ok: true, engine: endpoint || 'local', services, driftCount, containers: projectContainers.length });
  }),
);

/**
 * 远端代理部署（1.35.0）：按 compose 配置在远端引擎上创建并启动各服务容器。
 * 通过 dockerode 直接在远端 daemon 上还原服务（端口 / 卷 / 环境变量 / 重启策略 /
 * 项目默认网络），并写入 compose 项目标签，使远端容器同样纳入面板统计与运维体系。
 * @param projectName 项目名
 * @param composeFile compose 文件名
 * @param dir 项目目录
 * @param client 远端引擎 dockerode 客户端
 * @param recreate 已存在同名容器时是否强制重建
 */
async function remoteDeployServices(
  projectName: string,
  composeFile: string,
  dir: string,
  client: any,
  recreate: boolean,
  onlyServices?: string[],
): Promise<Array<{ service: string; name: string; ok: boolean; detail: string }>> {
  const output = await runCmd(`docker compose -f "${composeFile}" config --format json`, dir);
  // 兼容单行与多行缩进两种 JSON 输出（不同 docker CLI 版本行为不一）：取首个 { 到最后一个 } 之间解析
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}');
  const parsed = jsonStart >= 0 && jsonEnd > jsonStart ? JSON.parse(output.slice(jsonStart, jsonEnd + 1)) : null;
  const serviceConfigs = (parsed as any)?.services || {};
  const results: Array<{ service: string; name: string; ok: boolean; detail: string }> = [];
  const only = Array.isArray(onlyServices) && onlyServices.length ? onlyServices : null;

  // 远端创建项目默认网络（服务名互访）；已存在或失败时回退默认桥接
  const netName = `${projectName}_default`;
  let networkName = '';
  try {
    await client.createNetwork({
      Name: netName,
      Driver: 'bridge',
      Attachable: true,
      Labels: { 'com.docker.compose.project': projectName },
    });
    networkName = netName;
  } catch (err: any) {
    if (String(err?.message || '').includes('already exists')) networkName = netName;
  }

  const existing = (await client.listContainers({ all: true })) as any[];
  const nameOf = (svc: string) => `${projectName}-${svc}-1`;

  for (const svc of Object.keys(serviceConfigs)) {
    if (only && !only.includes(svc)) continue;
    const cfg = serviceConfigs[svc] || {};
    const cname = nameOf(svc);
    try {
      if (!cfg.image) {
        results.push({ service: svc, name: cname, ok: false, detail: '服务仅有 build 无 image，跳过（远端无法构建）' });
        continue;
      }
      const dup = existing.find((x) => x.Names?.includes('/' + cname));
      if (dup) {
        if (!recreate) {
          results.push({ service: svc, name: cname, ok: true, detail: '容器已存在，跳过' });
          continue;
        }
        await client.getContainer(dup.Id).remove({ force: true }).catch(() => undefined);
      }
      const env = normalizeEnvironment(cfg.environment);
      const ports = normalizePorts(cfg.ports);
      const exposed: Record<string, any> = {};
      const bindings: Record<string, any> = {};
      for (const p of ports) {
        if (!p.target) continue;
        const key = `${p.target}/${p.protocol || 'tcp'}`;
        exposed[key] = {};
        if (p.published) bindings[key] = [{ HostPort: String(p.published) }];
      }
      const binds = normalizeVolumes(cfg.volumes)
        .filter((v) => v.source && v.target)
        .map((v) => `${v.source}:${v.target}${v.readOnly ? ':ro' : ''}`);
      const restart = String(cfg.restart || 'no');
      const createOpts: any = {
        name: cname,
        Image: cfg.image,
        Env: env,
        ExposedPorts: exposed,
        Labels: { 'com.docker.compose.project': projectName, 'com.docker.compose.service': svc },
        HostConfig: {
          PortBindings: bindings,
          Binds: binds.length ? binds : undefined,
          ...(restart !== 'no' ? { RestartPolicy: { Name: restart } } : {}),
          ...(cfg.network_mode ? { NetworkMode: cfg.network_mode } : {}),
        },
      };
      if (Array.isArray(cfg.command) && cfg.command.length) createOpts.Cmd = cfg.command;
      if (Array.isArray(cfg.entrypoint) && cfg.entrypoint.length) createOpts.Entrypoint = cfg.entrypoint;
      if (cfg.user) createOpts.User = cfg.user;
      if (cfg.working_dir) createOpts.WorkingDir = cfg.working_dir;
      if (!cfg.network_mode && networkName) {
        createOpts.NetworkingConfig = { EndpointsConfig: { [networkName]: {} } };
      }
      const container = await client.createContainer(createOpts);
      await container.start();
      results.push({ service: svc, name: cname, ok: true, detail: '已创建并启动' });
    } catch (err: any) {
      results.push({ service: svc, name: cname, ok: false, detail: err?.message || '创建失败' });
    }
  }
  return results;
}

/**
 * POST /api/compose/:name/distribute
 * 跨引擎镜像分发（1.34.0）：把项目全部服务镜像预拉取到指定远端引擎，
 * 作为远端代理部署的前置步骤（镜像就位后远端启动即刻可用）。
 * body: { engines: ["tcp://host:2375", ...], deploy?: boolean }
 * deploy=true 时（1.35.0）镜像就位后继续在远端创建并启动各服务容器（代理部署）。
 */
router.post(
  '/:name/distribute',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    const engines: string[] = Array.isArray(req.body?.engines) ? req.body.engines.filter(Boolean) : [];
    if (engines.length === 0) return res.status(400).json({ error: '需要 engines 参数（远端引擎地址列表）' });
    const deploy = req.body?.deploy === true;
    const imagesOut = await runCmd(`docker compose -f "${composeFile}" config --images`, dir);
    const images = imagesOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const results: Array<{ engine: string; image: string; ok: boolean; detail: string }> = [];
    for (const engine of engines) {
      let client;
      try {
        client = getDockerClientForEndpoint(engine);
      } catch (err: any) {
        for (const img of images) results.push({ engine, image: img, ok: false, detail: err?.message || '引擎不可达' });
        continue;
      }
      for (const img of images) {
        try {
          const stream = await client.pull(img);
          await new Promise<void>((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('error', reject);
            stream.resume();
          });
          results.push({ engine, image: img, ok: true, detail: '拉取成功' });
        } catch (err: any) {
          results.push({ engine, image: img, ok: false, detail: err?.message || '拉取失败' });
        }
      }
      if (deploy) {
        try {
          const deployResults = await remoteDeployServices(req.params.name, composeFile, dir, client, false);
          for (const d of deployResults) {
            results.push({ engine, image: `[部署] ${d.service}`, ok: d.ok, detail: `${d.name}：${d.detail}` });
          }
        } catch (err: any) {
          results.push({ engine, image: '[部署] 项目', ok: false, detail: err?.message || '远端部署失败' });
        }
      }
    }
    logOperation(
      res.locals.username,
      deploy ? '跨引擎分发并部署' : '跨引擎镜像分发',
      'compose',
      req.params.name,
      `engines: ${engines.join(', ')}; images: ${images.length}${deploy ? '; 远端代理部署' : ''}`,
      results.every((r) => r.ok),
    );
    res.json({ ok: results.every((r) => r.ok), images, results });
  }),
);

/**
 * POST /api/compose/:name/remote-deploy
 * 远端代理部署（1.35.0）：在指定远端引擎上按 compose 配置创建并启动各服务容器。
 * body: { endpoint, recreate?: boolean }
 */
router.post(
  '/:name/remote-deploy',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    const endpoint = String(req.body?.endpoint || '').trim();
    if (!endpoint) return res.status(400).json({ error: '需要 endpoint 参数（远端引擎地址）' });
    const recreate = req.body?.recreate === true;
    const client = getDockerClientForEndpoint(endpoint);
    const results = await remoteDeployServices(req.params.name, composeFile, dir, client, recreate);
    logOperation(
      res.locals.username,
      '远端代理部署',
      'compose',
      req.params.name,
      `endpoint: ${endpoint}; services: ${results.length}`,
      results.every((r) => r.ok),
    );
    res.json({ ok: results.every((r) => r.ok), endpoint, results });
  }),
);

/**
 * POST /api/compose/:name/fix-drift
 * 漂移自动修复（1.40.0）：按本地 compose 配置重建目标引擎上漂移的服务。
 * body: { endpoint?: string, services: string[] }
 * endpoint 为空 = 本地引擎（docker compose up -d --force-recreate <services>）；
 * 远端引擎走 remoteDeployServices 逐服务重建（recreate = true，先拉取镜像）。
 */
router.post(
  '/:name/fix-drift',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    const services: string[] = Array.isArray(req.body?.services)
      ? req.body.services.map((x: unknown) => String(x)).filter(Boolean)
      : [];
    if (services.length === 0) return res.status(400).json({ error: '需要 services 参数（要修复的服务列表）' });
    const endpoint = String(req.body?.endpoint || '').trim();

    if (!endpoint) {
      // 本地引擎：直接用 compose CLI 重建指定服务
      try {
        await runCmd(
          `docker compose -f "${composeFile}" up -d --force-recreate ${services.map((s) => `"${s}"`).join(' ')}`,
          dir,
        );
      } catch (err: any) {
        return res.status(500).json({ error: err?.message || '本地重建失败' });
      }
      logOperation(
        res.locals.username,
        '漂移自动修复',
        'compose',
        req.params.name,
        `本地引擎; services: ${services.join(', ')}`,
      );
      return res.json({
        ok: true,
        mode: 'local',
        results: services.map((s) => ({ service: s, name: `${req.params.name}-${s}-1`, ok: true, detail: '已按本地配置重建' })),
      });
    }

    // 远端引擎：先确保镜像存在（拉取失败不中断，由逐服务创建兜底报错），再按本地配置重建
    const client = getDockerClientForEndpoint(endpoint);
    const output = await runCmd(`docker compose -f "${composeFile}" config --format json`, dir);
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    const parsed = jsonStart >= 0 && jsonEnd > jsonStart ? JSON.parse(output.slice(jsonStart, jsonEnd + 1)) : null;
    const serviceConfigs: Record<string, any> = (parsed as any)?.services || {};
    for (const svc of services) {
      const image = serviceConfigs[svc]?.image;
      if (!image) continue;
      await new Promise<void>((resolve) => {
        client.pull(image, (err: any, stream: any) => {
          if (stream) {
            stream.on('end', () => resolve());
            stream.on('error', () => resolve());
            stream.resume();
          } else resolve();
        });
      }).catch(() => undefined);
    }
    const results = await remoteDeployServices(req.params.name, composeFile, dir, client, true, services);
    logOperation(
      res.locals.username,
      '漂移自动修复',
      'compose',
      req.params.name,
      `endpoint: ${endpoint}; services: ${services.join('/')}`,
      results.every((r) => r.ok),
    );
    res.json({ ok: results.every((r) => r.ok), mode: 'remote', endpoint, results });
  }),
);

// ============ 创建/更新项目 ============

/**
 * POST /api/compose
 * 创建或更新一个 compose 项目
 * body: { name, content, fileName? }
 * 保存前会先用 docker compose config 校验 YAML 语法，语法错误将拒绝保存并返回 400。
 */
router.post(
  '/',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, content, fileName } = req.body || {};
    if (!name || !content) {
      return res.status(400).json({ error: '需要 name 和 content 参数' });
    }
    // 保存前校验 YAML 语法，避免写入无法解析的 compose 文件
    const validateError = await validateComposeYaml(content);
    if (validateError) {
      return res
        .status(400)
        .json({ error: `Compose YAML 语法错误，未保存：\n${validateError}`, invalid: true });
    }
    // 防目录穿越
    const safeName = path.basename(name);
    const dir = path.join(COMPOSE_ROOT, safeName);
    ensureDir(dir);
    const targetFile = fileName && COMPOSE_FILES.includes(fileName) ? fileName : 'docker-compose.yml';
    fs.writeFileSync(path.join(dir, targetFile), content, 'utf8');
    logOperation(res.locals.username, '保存 Compose', 'compose', safeName, `文件: ${targetFile}`);
    res.status(201).json({ name: safeName, path: dir, composeFile: targetFile });
  }),
);

/**
 * POST /api/compose/validate
 * 校验 compose YAML 语法（不保存）。前端在编辑/新建时实时调用，用于及时反馈语法错误。
 * body: { content }
 * 校验通过返回 { ok: true }，失败返回 400 { error }（含行号）。
 */
router.post(
  '/validate',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const content = req.body?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: '缺少 compose 内容' });
    }
    const validateError = await validateComposeYaml(content);
    if (validateError) {
      return res.status(400).json({ invalid: true, error: validateError });
    }
    res.json({ ok: true });
  }),
);

/**
 * GET /api/compose/:name/file
 * 读取项目的 compose 文件内容
 */
router.get(
  '/:name/file',
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: '未找到 compose 文件' });
    }
    const content = fs.readFileSync(path.join(dir, composeFile), 'utf8');
    res.json({ name: req.params.name, composeFile, content });
  }),
);

/**
 * POST /api/compose/:name/up
 * 启动 compose 项目（docker compose up -d）
 */
router.post(
  '/:name/up',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: '未找到 compose 文件' });
    }
    const output = await runCmd(`docker compose -f "${composeFile}" up -d`, dir);
    logOperation(res.locals.username, '部署 Compose', 'compose', req.params.name);
    res.json({ ok: true, output });
  }),
);

/**
 * 停止并移除 compose 项目（docker compose down）
 * 路由与审批执行器共用；审批通过后由 approvals 以项目名调用
 * @param name compose 项目目录名
 * @param volumes 是否同时移除数据卷（down -v）
 * @returns docker compose 命令输出
 * @throws compose 文件不存在时抛 404
 */
export async function composeProjectDown(name: string, volumes: boolean): Promise<string> {
  const dir = path.join(COMPOSE_ROOT, name);
  const composeFile = findComposeFile(dir);
  if (!composeFile) {
    throw Object.assign(new Error('未找到 compose 文件'), { statusCode: 404 });
  }
  return runCmd(`docker compose -f "${composeFile}" down${volumes ? ' -v' : ''}`, dir);
}

/**
 * POST /api/compose/:name/down
 * 停止并移除 compose 项目（docker compose down）
 */
router.post(
  '/:name/down',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    if (maybeGateOrForbidden(req, res, 'compose.down', req.params.name, { volumes: req.body?.volumes === true })) return;
    const output = await composeProjectDown(req.params.name, req.body?.volumes === true);
    logOperation(res.locals.username, '停止 Compose', 'compose', req.params.name, req.body?.volumes === true ? '移除数据卷' : undefined);
    res.json({ ok: true, output });
  }),
);

/**
 * POST /api/compose/:name/restart
 * 重启 compose 项目（docker compose restart）
 */
router.post(
  '/:name/restart',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: '未找到 compose 文件' });
    }
    const output = await runCmd(`docker compose -f "${composeFile}" restart`, dir);
    logOperation(res.locals.username, '重启 Compose', 'compose', req.params.name);
    res.json({ ok: true, output });
  }),
);

/**
 * POST /api/compose/:name/pull
 * 拉取 compose 项目中声明的镜像（docker compose pull）
 */
router.post(
  '/:name/pull',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: '未找到 compose 文件' });
    }
    const output = await runCmd(`docker compose -f "${composeFile}" pull`, dir);
    logOperation(res.locals.username, '拉取 Compose 镜像', 'compose', req.params.name);
    res.json({ ok: true, output });
  }),
);

/**
 * POST /api/compose/:name/build
 * 构建 compose 项目中声明的镜像（docker compose build）
 */
router.post(
  '/:name/build',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: '未找到 compose 文件' });
    }
    const output = await runCmd(`docker compose -f "${composeFile}" build`, dir);
    logOperation(res.locals.username, '构建 Compose 镜像', 'compose', req.params.name);
    res.json({ ok: true, output });
  }),
);

/**
 * POST /api/compose/:name/logs
 * 获取 compose 项目的日志（docker compose logs）
 */
router.post(
  '/:name/logs',
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: '未找到 compose 文件' });
    }
    const tail = Number(req.body?.tail || '200');
    const output = await runCmd(`docker compose -f "${composeFile}" logs --tail=${tail}`, dir);
    res.json({ logs: output });
  }),
);

/**
 * DELETE /api/compose/:name
 * 删除本地项目目录（若项目仍在运行，需先 down；支持 volumes 参数一并删除数据卷）
 * query: volumes? - 传 true 时 down 会携带 -v 删除数据卷
 */
router.delete(
  '/:name',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    if (fs.existsSync(dir)) {
      // 兼容字符串 "true" 与字面量 true 两种写法（Express 查询串通常为字符串）
      const volumes = req.query.volumes === 'true' || (req.query.volumes as unknown) === true;
      const downVolumes = volumes ? ' -v' : '';
      await runCmd(
        `docker compose -f "${findComposeFile(dir) || 'docker-compose.yml'}" down${downVolumes}`,
        dir,
      ).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    logOperation(res.locals.username, '删除 Compose', 'compose', req.params.name);
    res.json({ ok: true });
  }),
);

// ============ 结构视图 ============

/**
 * 将 config JSON 中的端口定义统一为 { published, target, protocol } 结构
 * 兼容对象数组（如 [{published, target, protocol}]）与字符串（如 "8080:80"）
 * @param ports 原始端口配置
 * @returns 规范化的端口映射数组
 */
function normalizePorts(ports: any): any[] {
  if (!Array.isArray(ports)) return [];
  return ports
    .map((p) => {
      if (typeof p === 'string') {
        // 形如 "8080:80/tcp"，拆分为 published / target
        const [left, right] = p.split(':');
        const targetStr = right !== undefined ? right : left;
        const [targetRaw, protocol] = targetStr.split('/');
        return {
          published: right !== undefined ? left : undefined,
          target: targetRaw,
          protocol: protocol || 'tcp',
        };
      }
      return {
        published: p?.published,
        target: p?.target,
        protocol: p?.protocol || 'tcp',
      };
    })
    .filter((p) => p);
}

/**
 * 将 config JSON 中的卷定义统一为 { type, source, target, readOnly } 结构
 * 兼容对象（含 read_only 布尔）与字符串（如 "vol:/data" 或 "/host:/cont:ro"）
 * @param volumes 原始卷配置
 * @returns 规范化的卷挂载数组
 */
function normalizeVolumes(volumes: any): any[] {
  if (!Array.isArray(volumes)) return [];
  return volumes
    .map((v) => {
      if (typeof v === 'string') {
        // 形如 "src:target:mode"，mode 含 ro 表示只读
        const parts = v.split(':');
        const readOnly = parts.length > 2 && parts[2].split(',').includes('ro');
        return { type: 'bind', source: parts[0], target: parts[1], readOnly };
      }
      return {
        type: v?.type,
        source: v?.source,
        target: v?.target,
        readOnly: v?.read_only === true,
      };
    })
    .filter((v) => v && v.target);
}

/**
 * 将 config JSON 中的 environment 统一为键值对数组（["K=V"]）
 * 兼容对象（{K: V}）与数组（["K=V"] / ["K"]）
 * @param env 原始环境变量配置
 * @returns 键值对字符串数组
 */
function normalizeEnvironment(env: any): string[] {
  if (!env) return [];
  if (Array.isArray(env)) {
    return env.map((e) => String(e));
  }
  if (typeof env === 'object') {
    return Object.entries(env).map(([k, v]) => (v == null ? k : `${k}=${v}`));
  }
  return [];
}

/**
 * 将 config JSON 中的 depends_on 统一为字符串数组
 * 兼容数组（["db"]）与对象（{db: {condition}}）
 * @param deps 原始依赖配置
 * @returns 依赖服务名数组
 */
function normalizeDependsOn(deps: any): string[] {
  if (!deps) return [];
  if (Array.isArray(deps)) return deps.map((d) => String(d));
  if (typeof deps === 'object') return Object.keys(deps);
  return [];
}

/**
 * GET /api/compose/:name/structure
 * 解析 compose 配置，返回服务 / 卷 / 网络的规范化视图（docker compose config --format json）
 */
router.get(
  '/:name/structure',
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: `项目 ${req.params.name} 不存在或缺少 compose 文件` });
    }
    const output = await runCmd(`docker compose -f "${composeFile}" config --format json`, dir);
    // 兼容单行与多行缩进两种 JSON 输出：取首个 { 到最后一个 } 之间解析
    let parsed: any = null;
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
      } catch {
        // 解析失败返回空结构，不抛错
      }
    }

    const services: any[] = [];
    const serviceConfigs = parsed?.services || {};
    for (const name of Object.keys(serviceConfigs)) {
      const cfg = serviceConfigs[name] || {};
      services.push({
        name,
        image: cfg.image,
        ports: normalizePorts(cfg.ports),
        volumes: normalizeVolumes(cfg.volumes),
        depends_on: normalizeDependsOn(cfg.depends_on),
        environment: normalizeEnvironment(cfg.environment),
      });
    }

    res.json({
      name: req.params.name,
      services,
      volumes: Object.keys(parsed?.volumes || {}),
      networks: Object.keys(parsed?.networks || {}),
    });
  }),
);

// ============ 服务级启停 ============

/**
 * 解析 Compose 配置并执行针对单个服务的 docker compose 子命令
 * @param name 项目名
 * @param service 服务名
 * @param action start / stop / restart
 * @param username 操作者用户名
 */
async function runServiceAction(name: string, service: string, action: string, username: string): Promise<string> {
  const dir = path.join(COMPOSE_ROOT, name);
  const composeFile = findComposeFile(dir);
  if (!composeFile) {
    const apiErr: any = new Error('未找到 compose 文件');
    apiErr.statusCode = 404;
    throw apiErr;
  }
  // 服务名经 shell 单引号包裹并转义防止注入
  const safeService = service.replace(/'/g, "'\\''");
  const output = await runCmd(
    `docker compose -f "${composeFile}" ${action} '${safeService}'`,
    dir,
  );
  logOperation(username, `Compose 服务${action}`, 'compose', `${name}/${service}`);
  return output;
}

/**
 * POST /api/compose/:name/services/:service/start
 * 启动单个 compose 服务（docker compose start）
 */
router.post(
  '/:name/services/:service/start',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const output = await runServiceAction(
      req.params.name,
      req.params.service,
      'start',
      res.locals.username,
    );
    res.json({ ok: true, output });
  }),
);

/**
 * POST /api/compose/:name/services/:service/stop
 * 停止单个 compose 服务（docker compose stop）
 */
router.post(
  '/:name/services/:service/stop',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const output = await runServiceAction(
      req.params.name,
      req.params.service,
      'stop',
      res.locals.username,
    );
    res.json({ ok: true, output });
  }),
);

/**
 * POST /api/compose/:name/services/:service/restart
 * 重启单个 compose 服务（docker compose restart）
 */
router.post(
  '/:name/services/:service/restart',
  requirePermission('compose.write'),
  asyncHandler(async (req: Request, res: Response) => {
    const output = await runServiceAction(
      req.params.name,
      req.params.service,
      'restart',
      res.locals.username,
    );
    res.json({ ok: true, output });
  }),
);

// ============ docker run → Compose 逆向 ============

/**
 * POST /api/compose/infer
 * 从现存容器逆向出 docker-compose yaml（只读，不执行任何写操作）
 * body:
 *  - containerIds?: string[] ：要逆向的容器 id；缺省/为空时返回可逆向候选容器列表
 * 返回：
 *  - 有 containerIds：{ projectName, services, content, warnings, valid, validateError }
 *  - 无 containerIds：{ candidates: [{id,name,image,status}] }
 */
router.post(
  '/infer',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const docker = await getDockerClient();
    const ids = Array.isArray(req.body?.containerIds)
      ? req.body.containerIds.map(String).filter(Boolean)
      : [];

    if (ids.length === 0) {
      // 返回可逆向的容器候选列表（含停止态，便于用户选择）
      const list = (await docker.listContainers({ all: true }).catch(() => [])) as any[];
      const candidates = list.map((c: any) => ({
        id: c.Id,
        name: (c.Names?.[0] || '').replace(/^\//, '') || c.Id?.slice(0, 12),
        image: c.Image || '',
        status: c.Status || c.State || '',
      }));
      return res.json({ candidates });
    }

    // 逐容器 inspect（并发但限流）
    const inputs: InferInput[] = [];
    const max = 50;
    const slice = ids.slice(0, max);
    const results = await Promise.allSettled(
      slice.map(async (id: string) => {
        const insp = await docker.getContainer(id).inspect();
        return insp as unknown as InferInput;
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') inputs.push(r.value);
    }
    if (inputs.length === 0) {
      return res.status(400).json({ error: '未获取到可逆向的容器详情' });
    }

    const { projectName, services, volumes, networks, yaml, warnings } = inferCompose(inputs);
    // 用既有校验器做本地校验（不落盘）
    const validateError = await validateComposeYaml(yaml);
    logOperation(res.locals.username, 'Compose 逆向预览', 'compose', projectName, `${inputs.length} 个容器`);
    res.json({
      projectName,
      services: services.map((s) => ({ name: s.name, image: s.image, ports: s.ports, networks: s.networks })),
      volumes,
      networks,
      content: yaml,
      warnings,
      valid: !validateError,
      validateError: validateError || undefined,
    });
  }),
);

export default router;
