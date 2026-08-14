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
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { name, content, fileName } = req.body || {};
    if (!name || !content) {
      return res.status(400).json({ error: '需要 name 和 content 参数' });
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

export default router;
