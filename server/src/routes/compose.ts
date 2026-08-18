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
import { requireAdmin } from '../auth';

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

// ============ 创建/更新项目 ============

/**
 * POST /api/compose
 * 创建或更新一个 compose 项目
 * body: { name, content, fileName? }
 * 保存前会先用 docker compose config 校验 YAML 语法，语法错误将拒绝保存并返回 400。
 */
router.post(
  '/',
  requireAdmin,
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
  requireAdmin,
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
 * POST /api/compose/:name/down
 * 停止并移除 compose 项目（docker compose down）
 */
router.post(
  '/:name/down',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const dir = path.join(COMPOSE_ROOT, req.params.name);
    const composeFile = findComposeFile(dir);
    if (!composeFile) {
      return res.status(404).json({ error: '未找到 compose 文件' });
    }
    const volumes = req.body?.volumes === true;
    const output = await runCmd(
      `docker compose -f "${composeFile}" down${volumes ? ' -v' : ''}`,
      dir,
    );
    logOperation(res.locals.username, '停止 Compose', 'compose', req.params.name, volumes ? '移除数据卷' : undefined);
    res.json({ ok: true, output });
  }),
);

/**
 * POST /api/compose/:name/restart
 * 重启 compose 项目（docker compose restart）
 */
router.post(
  '/:name/restart',
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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
    // config 输出可能带第一行注释（如 "# resolve image digest"），trim 后直接逐段找首个合法 JSON 起始
    let parsed: any = null;
    const text = output.trim();
    // 跳过可能的注释行，然后 JSON.parse
    const body = text.split('\n').find((line) => line.trim().startsWith('{')) || '';
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      // 解析失败返回空结构，不抛错
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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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

export default router;
