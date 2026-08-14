/**
 * 应用商店（App Store）API 路由
 *
 * 提供应用目录列表、安装状态、详情、安装、卸载等接口。
 * 所有数据来源于 Docker 引擎本身，"安装"即通过 dockerode 创建并启动容器。
 */
import { Router, Request, Response } from 'express';
import Dockerode from 'dockerode';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getDockerClient } from '../docker/client';
import {
  APP_LABEL_KEY,
  AppDefinition,
  APP_CATALOG,
  findApp,
  renderComposeTemplate,
} from '../appstore/catalog';
import {
  listContainersByAppLabel,
  mapContainerToStatus,
  AppStatus,
} from '../appstore/status';
import { pullWithFailover } from '../docker/pull';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';
import { getDb } from '../storage';

const execAsync = promisify(exec);
const router = Router();

/** Compose 项目根目录（与 compose.ts / tasks.ts 保持一致，支持环境变量覆盖） */
const COMPOSE_ROOT = process.env.COMPOSE_ROOT
  ? process.env.COMPOSE_ROOT
  : path.join(os.tmpdir(), 'docker-compose-projects');

/** 允许的 compose 文件名 */
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * 安全地执行 shell 命令，捕获 stdout / stderr（与 compose.ts 同风格）
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
 * 确保目录存在（递归创建）
 * @param dir 目录路径
 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 应用存储记录的行结构 */
interface AppInstanceRow {
  id: number;
  app_id: string;
  project_name: string;
  version: string | null;
  params: string;
  installed_at: number;
  updated_at: number;
}

/**
 * 读取某个应用在 appstore_instances 表中的安装记录
 * @param appId 应用 id
 * @returns 安装记录，未记录返回 null
 */
function getInstanceRow(appId: string): AppInstanceRow | null {
  const row = getDb()
    .prepare(
      'SELECT id, app_id, project_name, version, params, installed_at, updated_at FROM appstore_instances WHERE app_id = ?',
    )
    .get(appId) as unknown as AppInstanceRow | undefined;
  return row || null;
}

/**
 * 写入/更新应用在 appstore_instances 表的安装记录（compose 套件）
 * @param appId 应用 id
 * @param projectName Compose 项目名
 * @param version 版本
 * @param params 参数快照 JSON
 */
function upsertInstance(appId: string, projectName: string, version: string | undefined, params: Record<string, any>): void {
  const now = Date.now();
  const existing = getInstanceRow(appId);
  if (existing) {
    getDb()
      .prepare('UPDATE appstore_instances SET project_name = ?, version = ?, params = ?, updated_at = ? WHERE app_id = ?')
      .run(projectName, version || null, JSON.stringify(params), now, appId);
  } else {
    getDb()
      .prepare('INSERT INTO appstore_instances (app_id, project_name, version, params, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(appId, projectName, version || null, JSON.stringify(params), now, now);
  }
}

/**
 * 删除应用在 appstore_instances 表的记录
 * @param appId 应用 id
 */
function deleteInstance(appId: string): void {
  getDb().prepare('DELETE FROM appstore_instances WHERE app_id = ?').run(appId);
}

/**
 * 计算所有 Compose 套件应用的实时运行状态与版本信息。
 *
 * Compose 容器带有 `com.docker.compose.project=<项目名>` 标签（非 APP_LABEL_KEY），
 * 通过 dockerode 一次性列出全部容器，按项目名过滤出相关容器，
 * 只要有任一容器处于 running 即视为项目运行中；版本优先取 appstore_instances 记录，
 * 否则回退到应用的 defaultVersion。
 * @returns Map<appId, { running, version }>
 */
async function getComposeRuntimeInfo(): Promise<
  Map<string, { running: boolean; version: string | null }>
> {
  const docker = await getDockerClient();
  const containers = await docker.listContainers({ all: true });
  const map = new Map<string, { running: boolean; version: string | null }>();
  for (const app of APP_CATALOG) {
    if (!app.compose) continue;
    const project = `dm-${app.id}`;
    const related = containers.filter(
      (c) => c.Labels?.['com.docker.compose.project'] === project,
    );
    const running = related.some((c) => c.State === 'running');
    const row = getInstanceRow(app.id);
    map.set(app.id, {
      running,
      version: row?.version ?? app.compose?.defaultVersion ?? null,
    });
  }
  return map;
}

/**
 * 统一兜底错误处理，保证所有异步路由异常都能被捕获并返回 JSON
 * @param fn 异步处理函数
 * @returns Express 中间件
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

// ============ 应用列表 ============

/**
 * GET /api/appstore
 * 获取应用商店全部应用列表，并附带每个应用的安装状态
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const byLabel = await listContainersByAppLabel();
    const composeInfo = await getComposeRuntimeInfo();
    // 并发计算每个应用的安装状态；compose 套件通过实例记录判断是否已安装
    const apps = await Promise.all(
      APP_CATALOG.map(async (app) => {
        if (app.compose) {
          const installed = !!getInstanceRow(app.id) || fs.existsSync(path.join(COMPOSE_ROOT, `dm-${app.id}`));
          const info = composeInfo.get(app.id);
          return {
            ...app,
            mode: 'compose',
            installed,
            containerId: undefined,
            containerName: undefined,
            running: installed ? !!info?.running : undefined,
            version: info?.version ?? undefined,
            port: null,
          };
        }
        const status = mapContainerToStatus(app, byLabel.get(app.id));
        return { ...app, mode: 'single', ...status };
      }),
    );
    res.json({ apps });
  }),
);

// ============ 安装状态映射 ============

/**
 * GET /api/appstore/status
 * 获取所有应用的安装状态映射
 */
router.get(
  '/status',
  asyncHandler(async (_req: Request, res: Response) => {
    const byLabel = await listContainersByAppLabel();
    const composeInfo = await getComposeRuntimeInfo();
    const statuses: Record<string, AppStatus> = {};
    for (const app of APP_CATALOG) {
      if (app.compose) {
        const installed = !!getInstanceRow(app.id) || fs.existsSync(path.join(COMPOSE_ROOT, `dm-${app.id}`));
        const info = composeInfo.get(app.id);
        statuses[app.id] = {
          id: app.id,
          installed,
          running: installed ? !!info?.running : undefined,
        };
        continue;
      }
      statuses[app.id] = mapContainerToStatus(app, byLabel.get(app.id));
    }
    res.json({ statuses });
  }),
);

// ============ 应用详情 ============

/**
 * GET /api/appstore/:id/detail
 * 获取单个应用的详情及其安装状态
 */
router.get(
  '/:id/detail',
  asyncHandler(async (req: Request, res: Response) => {
    const app = findApp(req.params.id);
    if (!app) {
      res.status(404).json({ error: '应用不存在' });
      return;
    }
    // Compose 套件：基于实例记录返回安装状态
    if (app.compose) {
      const installed = !!getInstanceRow(app.id) || fs.existsSync(path.join(COMPOSE_ROOT, `dm-${app.id}`));
      const info = (await getComposeRuntimeInfo()).get(app.id);
      res.json({
        app: { ...app, mode: 'compose' },
        installed,
        containerId: undefined,
        running: installed ? !!info?.running : undefined,
        version: info?.version ?? undefined,
        port: null,
        projectName: installed ? `dm-${app.id}` : undefined,
      });
      return;
    }
    const byLabel = await listContainersByAppLabel();
    const status = mapContainerToStatus(app, byLabel.get(app.id));
    const { installed, containerId, running, port } = status;
    res.json({ app: { ...app, mode: 'single' }, installed, containerId, running, port });
  }),
);

// ============ 安装应用 ============

/**
 * 根据 compose 定义与用户覆盖参数，最终渲染出 compose 文件内容。
 *
 * 处理流程：
 *  - 用 env 覆盖值替换模板中的 ${VAR} 占位符（未覆盖的用内置默认值）
 *  - 支持端口覆盖：若用户传入了与内置不同的端口映射，替换模板中形如 "- \"host:container\"" 的行
 * @param app 应用定义
 * @param envOverrides 环境变量覆盖
 * @param portOverrides 端口覆盖（数组），为空则用内置端口
 * @returns 渲染后的 compose 内容
 */
function renderAppCompose(
  app: AppDefinition,
  envOverrides: Record<string, string>,
  portOverrides?: Array<{ container: number; host?: number }>,
): string {
  const def = app.compose;
  if (!def) return '';
  // 组装 env 值：覆盖优先，其次内置默认
  const values: Record<string, string> = {};
  for (const e of def.env || []) {
    const override = envOverrides[e.key];
    values[e.key] = override !== undefined ? override : e.value ?? '';
  }
  let compose = renderComposeTemplate(def.compose, values);
  // 端口覆盖：替换 "- "host:container"" 形式的行
  const ports = portOverrides && portOverrides.length ? portOverrides : (def.ports || []);
  // 先移除模板中所有已存在的 host:对外 端口行，再按新端口逐行追加到 wordpress（首个服务）下
  // 简化实现：逐个用正则替换 "- \"<host>:<container>\""；若模板已含该行则更新 host
  for (const p of ports) {
    if (p.host !== undefined && p.host !== null) {
      compose = compose.replace(
        new RegExp(`-\\s*"\\d+:${p.container}"`),
        `- "${p.host}:${p.container}"`,
      );
    }
  }
  return compose;
}

/**
 * 以 Compose 套件方式安装应用：渲染模板 → 写入项目目录 → docker compose up -d → 记录实例
 * @param app 应用定义
 * @param params 用户安装参数
 * @returns 安装结果（项目名 + 输出）
 */
async function installComposeApp(
  app: AppDefinition,
  params: Record<string, any>,
): Promise<{ projectName: string; output: string }> {
  const projectName = `dm-${app.id}`;
  const dir = path.join(COMPOSE_ROOT, projectName);
  ensureDir(dir);
  const content = renderAppCompose(app, params?.env || {}, params?.ports);
  // 本项目 compose 文件固定用 docker-compose.yml（模板不含其他文件）
  const composeFile = 'docker-compose.yml';
  fs.writeFileSync(path.join(dir, composeFile), content, 'utf8');
  const output = await runCmd(`docker compose -f "${composeFile}" up -d`, dir);
  // 记录实例（version 取默认版本）
  upsertInstance(app.id, projectName, app.compose?.defaultVersion, {
    env: params?.env || {},
    ports: params?.ports || [],
  });
  return { projectName, output };
}

/**
 * 判断指定应用 id 是否已有对应标签的容器（单容器模式已安装）或 compose 实例记录
 * @param appId 应用 id
 * @returns 已安装返回 true
 */
async function isAppInstalled(appId: string): Promise<boolean> {
  const app = findApp(appId);
  if (!app) return true;
  // compose 套件：通过实例记录判断
  if (app.compose) {
    const row = getInstanceRow(appId);
    if (row) return true;
    // 兼容：项目目录已存在也视为已安装
    return fs.existsSync(path.join(COMPOSE_ROOT, `dm-${appId}`));
  }
  // 单容器：通过 label 判断
  const byLabel = await listContainersByAppLabel();
  return byLabel.has(appId);
}

/**
 * POST /api/appstore/:id/install
 * 安装应用：拉取镜像（容忍失败）并创建、启动容器
 */
router.post(
  '/:id/install',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const app = findApp(req.params.id);
    if (!app) {
      res.status(404).json({ error: '应用不存在' });
      return;
    }

    // 已安装则直接返回冲突
    if (await isAppInstalled(app.id)) {
      res.status(409).json({ error: '应用已安装' });
      return;
    }

    // === Compose 套件模式：多容器编排安装 ===
    if (app.compose) {
      try {
        const { projectName, output } = await installComposeApp(app, req.body || {});
        logOperation(
          res.locals.username,
          '安装应用',
          'app',
          app.id,
          `Compose 套件 项目: ${projectName}`,
        );
        res.json({ ok: true, projectName, output, appId: app.id, mode: 'compose' });
      } catch (err: any) {
        // 安装失败时清理已生成的项目目录，避免残留半成品
        try {
          const dir = path.join(COMPOSE_ROOT, `dm-${app.id}`);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* 忽略清理失败 */ }
        const e: any = new Error(err?.message || 'Compose 套件安装失败');
        e.statusCode = 400;
        throw e;
      }
      return;
    }

    const docker = await getDockerClient();

    // 使用多源自动切换拉取镜像：显式指定源优先，其后所有启用镜像源，某源失败自动切换下一个；
    // 返回最终成功拉取的源及其实际镜像引用（带镜像源前缀），镜像已存在时也会复用成功
    const { ref: pullRef, source: usedSource } = await pullWithFailover(
      docker,
      app.image,
      req.body?.source,
    );

    // 端口映射：优先使用请求体覆盖，否则使用内置默认
    const exposedPorts: Record<string, Record<string, unknown>> = {};
    const portBindings: Dockerode.PortMap = {};
    const userPorts = Array.isArray(req.body?.ports) ? (req.body.ports as Array<any>) : null;
    const ports = userPorts && userPorts.length ? userPorts : (app.ports || []);
    for (const p of ports) {
      if (!p || !p.container) continue;
      const protocol = p.protocol || 'tcp';
      const key = `${p.container}/${protocol}`;
      exposedPorts[key] = {};
      if (p.host !== undefined && p.host !== null && p.host !== '') {
        const hostPort = p.host ?? p.container;
        portBindings[key] = [{ HostIp: p.hostIp || '0.0.0.0', HostPort: String(hostPort) }];
      }
    }

    // 挂载卷：优先使用请求体覆盖（{ source, target, readonly? }），否则使用内置默认
    const userVolumes = Array.isArray(req.body?.volumes) ? (req.body.volumes as Array<any>) : null;
    const volumes = userVolumes && userVolumes.length ? userVolumes : (app.volumes || []);
    const binds: string[] = [];
    for (let i = 0; i < volumes.length; i++) {
      const v = volumes[i];
      const source = v.source ?? v.host ?? `dm-${app.id}-${i}`;
      binds.push(`${source}:${v.target ?? v.container}${v.readonly ? ':ro' : ''}`);
    }

    // 组装环境变量：优先使用请求体传入的覆盖值（envOverrides[key]），否则用内置默认值
    const envOverrides: Record<string, string> =
      req.body?.env && typeof req.body.env === 'object' ? req.body.env : {};
    const env: string[] = [];
    for (const e of app.env || []) {
      const override = envOverrides[e.key];
      const value = override !== undefined ? override : e.value ?? '';
      env.push(`${e.key}=${value}`);
    }

    const createOpts: Dockerode.ContainerCreateOptions = {
      name: `dm-${app.id}`,
      Image: pullRef,
      Labels: { [APP_LABEL_KEY]: app.id },
      Env: env.length ? env : undefined,
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      HostConfig: {
        Binds: binds.length ? binds : undefined,
        PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    };

    // 创建并启动容器；启动失败时清理已创建的容器
    const container = await docker.createContainer(createOpts);
    try {
      await container.start();
    } catch (err: any) {
      // 创建成功但启动失败时尝试清理
      try {
        await container.remove({ force: true });
      } catch {
        // 忽略清理失败
      }
      throw err;
    }

    const info = await container.inspect();
    const containerName = (info.Name || '').replace(/^\//, '');
    logOperation(res.locals.username, '安装应用', 'app', app.id, `来源: ${usedSource} 容器: ${containerName}`);
    res.json({ ok: true, containerId: info.Id, containerName, appId: app.id, source: usedSource });
  }),
);

// ============ 启动 / 停止 / 重启 已安装应用 ============

/**
 * 获取 Compose 套件应用的项目目录并校验存在
 * @param appId 应用 id
 * @param app 应用定义
 * @returns 项目目录绝对路径
 * @throws 项目目录缺失时抛 404
 */
function getComposeProjectDir(appId: string, app: AppDefinition): string {
  const dir = path.join(COMPOSE_ROOT, `dm-${appId}`);
  if (!findComposeFile(dir)) {
    const err: any = new Error('应用 Compose 项目尚未部署');
    err.statusCode = 404;
    throw err;
  }
  return dir;
}

/**
 * 对 Compose 套件执行生命周期命令（up/down/restart），供 start/stop/restart 复用
 * @param app 应用定义
 * @param sub 子命令（up -d / down / restart）
 * @returns 命令输出
 */
async function runComposeLifecycle(app: AppDefinition, sub: string): Promise<string> {
  const dir = getComposeProjectDir(app.id, app);
  const composeFile = findComposeFile(dir) as string;
  return runCmd(`docker compose -f "${composeFile}" ${sub}`, dir);
}

/**
 * POST /api/appstore/:id/start
 * 启动已安装应用：单容器走 docker start，compose 套件走 docker compose up -d
 */
router.post(
  '/:id/start',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const app = findApp(req.params.id);
    if (!app) return void res.status(404).json({ error: '应用不存在' });
    // Compose 套件模式
    if (app.compose) {
      try {
        const output = await runComposeLifecycle(app, 'up -d');
        logOperation(res.locals.username, '启动应用', 'app', app.id, `Compose: ${output.slice(0, 200)}`);
        res.json({ ok: true });
      } catch (err: any) {
        throw Object.assign(new Error(err?.message || '启动失败'), { statusCode: 400 });
      }
      return;
    }
    const container = await getInstalledContainer(req.params.id);
    // 启动容器；容器可能已在运行，忽略已运行错误
    try {
      await container.start();
    } catch {
      // 容器可能已在运行，忽略
    }
    logOperation(res.locals.username, '启动应用', 'app', req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/appstore/:id/stop
 * 停止已安装应用：单容器走 docker stop，compose 套件走 docker compose down
 */
router.post(
  '/:id/stop',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const app = findApp(req.params.id);
    if (!app) return void res.status(404).json({ error: '应用不存在' });
    // Compose 套件模式
    if (app.compose) {
      try {
        const output = await runComposeLifecycle(app, 'down');
        logOperation(res.locals.username, '停止应用', 'app', app.id, `Compose: ${output.slice(0, 200)}`);
        res.json({ ok: true });
      } catch (err: any) {
        throw Object.assign(new Error(err?.message || '停止失败'), { statusCode: 400 });
      }
      return;
    }
    const container = await getInstalledContainer(req.params.id);
    // 停止容器；容器可能已停止，忽略已停止错误
    try {
      await container.stop();
    } catch {
      // 容器可能已停止，忽略
    }
    logOperation(res.locals.username, '停止应用', 'app', req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/appstore/:id/restart
 * 重启已安装应用：单容器走 docker restart，compose 套件走 docker compose restart
 */
router.post(
  '/:id/restart',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const app = findApp(req.params.id);
    if (!app) return void res.status(404).json({ error: '应用不存在' });
    // Compose 套件模式
    if (app.compose) {
      try {
        const output = await runComposeLifecycle(app, 'restart');
        logOperation(res.locals.username, '重启应用', 'app', app.id, `Compose: ${output.slice(0, 200)}`);
        res.json({ ok: true });
      } catch (err: any) {
        throw Object.assign(new Error(err?.message || '重启失败'), { statusCode: 400 });
      }
      return;
    }
    const container = await getInstalledContainer(req.params.id);
    await container.restart();
    logOperation(res.locals.username, '重启应用', 'app', req.params.id);
    res.json({ ok: true });
  }),
);

// ============ 卸载应用 ============

/**
 * POST /api/appstore/:id/uninstall
 * 卸载应用：compose 套件走 compose down -v + 删目录 + 删记录；单容器停止并删除对应标签容器
 */
router.post(
  '/:id/uninstall',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const app = findApp(req.params.id);
    if (!app) return void res.status(404).json({ error: '应用不存在' });
    // Compose 套件模式：down -v（删除数据卷）并删除项目目录与实例记录
    if (app.compose) {
      const dir = getComposeProjectDir(app.id, app);
      try {
        await runCmd(`docker compose -f "${findComposeFile(dir)}" down -v`, dir).catch(() => undefined);
      } catch { /* down 失败不阻断删除 */ }
      fs.rmSync(dir, { recursive: true, force: true });
      deleteInstance(app.id);
      logOperation(res.locals.username, '卸载应用', 'app', app.id, 'Compose 套件（含数据卷）');
      res.json({ ok: true });
      return;
    }
    const docker = await getDockerClient();
    const byLabel = await listContainersByAppLabel();
    const entry = byLabel.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: '应用尚未安装' });
      return;
    }

    const container = docker.getContainer(entry.Id);
    // 停止容器，已停止时忽略错误
    try {
      await container.stop();
    } catch {
      // 容器可能已停止，忽略
    }
    await container.remove({ force: true });
    logOperation(res.locals.username, '卸载应用', 'app', req.params.id);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/appstore/:id/upgrade
 * 升级 Compose 套件应用：拉取新镜像（compose pull）并用现有配置强制重建
 */
router.post(
  '/:id/upgrade',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const app = findApp(req.params.id);
    if (!app) return void res.status(404).json({ error: '应用不存在' });
    if (!app.compose) {
      return void res.status(400).json({ error: '该应用不是 Compose 套件，不支持升级' });
    }
    const dir = getComposeProjectDir(app.id, app);
    const composeFile = findComposeFile(dir) as string;
    // 拉取新镜像
    const pullOut = await runCmd(`docker compose -f "${composeFile}" pull`, dir);
    // 强制重建容器（--force-recreate 使新镜像生效；--remove-orphans 清理孤立容器）
    const upOut = await runCmd(`docker compose -f "${composeFile}" up -d --remove-orphans --force-recreate`, dir);
    // 更新版本记录
    upsertInstance(app.id, `dm-${app.id}`, app.compose.defaultVersion, req.body?.params || {});
    logOperation(res.locals.username, '升级应用', 'app', app.id, `Compose 套件 版本: ${app.compose.defaultVersion || 'latest'}`);
    res.json({ ok: true, version: app.compose.defaultVersion || 'latest', pullOut: pullOut.slice(0, 500), upOut: upOut.slice(0, 500) });
  }),
);

/**
 * POST /api/appstore/:id/update-params
 * 修改 Compose 套件应用的运行参数（环境变量、端口映射）：重新渲染 compose → 写回 → 强制重建。
 * @param body { env?: Record<string,string>, ports?: Array<{container:number;host?:number}> }
 */
router.post(
  '/:id/update-params',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const app = findApp(req.params.id);
    if (!app) return void res.status(404).json({ error: '应用不存在' });
    if (!app.compose) {
      return void res.status(400).json({ error: '该应用不是 Compose 套件，不支持修改参数' });
    }
    const dir = getComposeProjectDir(app.id, app);
    const composeFile = findComposeFile(dir) as string;
    // 用新的环境变量与端口映射重新渲染 compose 内容
    const params = req.body || {};
    const envOverrides: Record<string, string> = params.env || {};
    const portOverrides: Array<{ container: number; host?: number }> = Array.isArray(params.ports)
      ? params.ports
      : undefined;
    const content = renderAppCompose(app, envOverrides, portOverrides);
    // 写回 compose 文件
    fs.writeFileSync(path.join(dir, composeFile), content, 'utf8');
    // 强制重建容器使新参数生效
    const upOut = await runCmd(
      `docker compose -f "${composeFile}" up -d --remove-orphans --force-recreate`,
      dir,
    );
    // 更新安装实例的参数快照
    upsertInstance(app.id, `dm-${app.id}`, app.compose.defaultVersion, {
      env: envOverrides,
      ports: portOverrides || [],
    });
    logOperation(res.locals.username, '修改应用参数', 'app', app.id, 'Compose 套件 已重建');
    res.json({ ok: true, output: upOut.slice(0, 500) });
  }),
);

/**
 * 依据标签定位已安装应用对应的 dockerode 容器对象
 * @param appId 应用 id
 * @returns 容器对象
 * @throws 未安装时抛出带 statusCode=404 的错误
 */
async function getInstalledContainer(appId: string): Promise<Dockerode.Container> {
  const docker = await getDockerClient();
  const byLabel = await listContainersByAppLabel();
  const entry = byLabel.get(appId);
  if (!entry) {
    // 与现有错误结构保持一致：error 消息由 asyncHandler 转换为 JSON
    const err: any = new Error('应用尚未安装');
    err.statusCode = 404;
    throw err;
  }
  return docker.getContainer(entry.Id);
}

export default router;
