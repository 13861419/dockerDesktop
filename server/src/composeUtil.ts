/**
 * Docker Compose 项目管理共享工具
 *
 * 从 routes/compose.ts 抽出（1.92.0 重构）：项目定位、compose 文件读写、
 * YAML 校验、命令执行与版本历史等与路由无关的纯能力，
 * 供 compose 路由与后续调度/自动化模块复用。
 */
import { Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDockerClient } from './docker/client';
import { runAsHostRoot } from './platform/hostRoot';
import { getDb, getDataDir } from './storage';

export const execAsync = promisify(exec);

/** Compose 项目存放在该根目录下（默认系统临时目录的 docker-compose-projects） */
export const COMPOSE_ROOT = process.env.COMPOSE_ROOT
  ? process.env.COMPOSE_ROOT
  : path.join(os.tmpdir(), 'docker-compose-projects');

/** 允许的 compose 文件名 */
export const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * 统一兜底错误处理
 */
export function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
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
export async function runCmd(cmd: string, cwd: string): Promise<string> {
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
export function findComposeFile(dir: string): string | null {
  for (const name of COMPOSE_FILES) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

/**
 * 列出 Compose 根目录下的所有项目目录
 * @returns 项目目录名数组
 */
export function listProjectDirs(): string[] {
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
export function ensureDir(dir: string) {
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
export async function isDockerCliAvailable(): Promise<boolean> {
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
export async function validateComposeYaml(content: string): Promise<string | null> {
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

// ============ 项目定位（本地目录 + 外部发现，1.51.0） ============

/** 项目上下文：dir 为工作目录，composeFile 为主文件绝对路径；files 为 -f 多文件全量（外部项目）；fileAccessible 表示面板用户可直接读写该文件 */
export type ComposeCtx = { dir: string; composeFile: string; source: 'panel' | 'external'; fileAccessible: boolean; files?: string[] };

/** 文件是否可被面板服务账号读取（无权限目录下 existsSync/accessSync 均返回 false） */
export function isFileReadable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从容器标签反查主机上所有外部 compose 项目
 * （在面板目录之外创建的项目，如手动 docker compose up 或第三方工具创建）
 */
export async function discoverExternalProjects(): Promise<
  Map<string, { dir: string; composeFile: string; files: string[]; fileAccessible: boolean; running: number; total: number }>
> {
  const docker = await getDockerClient();
  const containers = await docker.listContainers({ all: true });
  const map = new Map<string, { dir: string; composeFile: string; files: string[]; fileAccessible: boolean; running: number; total: number }>();
  const rootAbs = path.resolve(COMPOSE_ROOT);
  for (const c of containers) {
    const labels = c.Labels || {};
    const project = labels['com.docker.compose.project'];
    const workingDir = labels['com.docker.compose.project.working_dir'];
    if (!project || !workingDir) continue;
    // 面板自己目录下的项目已在列表中，跳过
    const wd = path.resolve(workingDir);
    if (wd === rootAbs || wd.startsWith(rootAbs + path.sep)) continue;
    let entry = map.get(project);
    if (!entry) {
      const configFiles = labels['com.docker.compose.project.config_files'] || '';
      // -f 多文件覆盖（如 -f docker-compose.yml -f prod.yml）时标签含全部文件，首个为主文件（1.89.1）
      const files = configFiles.split(',').map((f) => f.trim()).filter(Boolean);
      const composeFile = files[0] || findComposeFile(workingDir) || '';
      entry = { dir: workingDir, composeFile, files, fileAccessible: !!composeFile && isFileReadable(composeFile), running: 0, total: 0 };
      map.set(project, entry);
    }
    entry.total += 1;
    if (c.State === 'running') entry.running += 1;
  }
  return map;
}

/**
 * 按项目名定位 compose 项目：先查面板本地目录，再从容器标签反查外部项目
 * 外部项目文件面板用户不可读时同样返回（fileAccessible=false，读写走提权通道）
 * @param opts allowDirOnly：目录存在但已无 compose 文件时也返回（composeFile 为空串，供删除路由清理空目录）
 * @returns 找不到时返回 null
 */
export async function resolveProjectCtx(
  name: string,
  opts?: { allowDirOnly?: boolean }
): Promise<ComposeCtx | null> {
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return null;
  const localDir = path.join(COMPOSE_ROOT, name);
  const localFile = findComposeFile(localDir);
  if (localFile) {
    return { dir: localDir, composeFile: path.join(localDir, localFile), source: 'panel', fileAccessible: true };
  }
  // 面板目录存在但已无 compose 文件（如测试残留空目录）：仅删除路由需要
  if (opts?.allowDirOnly && fs.existsSync(localDir) && fs.statSync(localDir).isDirectory()) {
    return { dir: localDir, composeFile: '', source: 'panel', fileAccessible: true };
  }
  try {
    const externals = await discoverExternalProjects();
    const ext = externals.get(name);
    if (ext && ext.composeFile) {
      return { dir: ext.dir, composeFile: ext.composeFile, source: 'external', fileAccessible: ext.fileAccessible, files: ext.files };
    }
  } catch {
    // docker 不可用时按未找到处理
  }
  return null;
}

/** 统一项目定位：找不到时抛 404（原各路由重复的 prologue） */
export async function requireProjectCtx(name: string): Promise<ComposeCtx> {
  const ctx = await resolveProjectCtx(name);
  if (!ctx) {
    const err: any = new Error(`项目 ${name} 不存在或缺少 compose 文件`);
    err.statusCode = 404;
    throw err;
  }
  return ctx;
}

/**
 * 组装 -f 参数（1.89.1）：多文件编排（-f a.yml -f b.yml 启动）按标签记录的顺序全部带上，
 * 保证 up/down/config 与启动时完全一致；单文件项目与原行为相同
 */
export function composeFileFlags(ctx: ComposeCtx): string {
  const files = ctx.files && ctx.files.length > 1 ? ctx.files : [ctx.composeFile];
  return files.map((f) => `-f "${f}"`).join(' ');
}

/**
 * 项目级命令执行（1.89.1）：compose 文件面板用户可读时本地执行；
 * 不可读（如 1Panel 创建的 root 属主文件）时经 hostRoot 助手容器以宿主机 root 执行
 */
export async function runProjectCmd(ctx: ComposeCtx, cmd: string, cwd: string): Promise<string> {
  if (ctx.source === 'external' && !isFileReadable(ctx.composeFile)) {
    const cdPrefix = `cd '${cwd.replace(/'/g, "'\\''")}' 2>/dev/null; `;
    try {
      return await runAsHostRoot(cdPrefix + cmd);
    } catch (err: any) {
      throw Object.assign(new Error(err?.message || '命令执行失败'), { statusCode: 400 });
    }
  }
  return runCmd(cmd, cwd);
}

/** 读取 compose 文件内容：直接读取失败（权限不足）时经提权通道 base64 读回 */
export async function readComposeFileContent(composeFile: string): Promise<string> {
  try {
    return fs.readFileSync(composeFile, 'utf8');
  } catch {
    const b64 = await runAsHostRoot(`base64 '${composeFile.replace(/'/g, "'\\''")}'`);
    return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
}

/** compose 文件物理备份：每项目保留最近份数（1.89.1，版本历史存 SQLite，此处为文件级防灾底）
 *  注意：目录用 compose-files，避开已有备份系统的 backups/compose/<id>/ 结构 */
export const COMPOSE_BACKUP_KEEP = 5;

/**
 * 写入 compose 文件内容前先做物理备份（1.89.1）
 * 直接写入失败（权限不足）时经提权通道 base64 写回；备份失败不阻断保存
 */
export async function writeComposeFileContent(projectName: string, composeFile: string, content: string): Promise<void> {
  try {
    const old = await readComposeFileContent(composeFile).catch(() => null);
    if (old !== null) {
      const dir = path.join(getDataDir(), 'backups', 'compose-files');
      fs.mkdirSync(dir, { recursive: true });
      const safe = projectName.replace(/[^\w.-]/g, '_') || 'project';
      const ext = path.extname(composeFile) || '.yml';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // @ 不可出现在 safe（已归一化）中，避免前缀碰撞误删其他项目的备份
      fs.writeFileSync(path.join(dir, `${safe}@${stamp}${ext}`), old, 'utf8');
      const olds = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${safe}@`) && f.endsWith(ext))
        .sort();
      while (olds.length > COMPOSE_BACKUP_KEEP) {
        fs.unlinkSync(path.join(dir, olds.shift() as string));
      }
    }
  } catch {
    // 备份失败不阻断保存
  }
  try {
    fs.writeFileSync(composeFile, content, 'utf8');
  } catch {
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    await runAsHostRoot(`printf %s '${b64}' | base64 -d > '${composeFile.replace(/'/g, "'\\''")}'`);
  }
}

/**
 * 保存前记录 compose 文件的上一版内容（1.52.0），用于历史回退
 * 内容未变不记录；每个文件最多保留 20 条；记录失败不阻断保存
 * 文件面板用户不可读时经提权通道读取（1.89.1）
 */
export async function recordComposeHistory(composeFile: string, projectName: string, username: string, nextContent: string): Promise<void> {
  try {
    const old = await readComposeFileContent(composeFile).catch(() => null);
    if (old === null || old === nextContent) return;
    const d = getDb();
    d.prepare(
      'INSERT INTO compose_file_history (project_name, compose_file, content, username, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(projectName, composeFile, old, String(username || ''), Date.now());
    d.prepare(
      'DELETE FROM compose_file_history WHERE compose_file = ? AND id NOT IN (SELECT id FROM compose_file_history WHERE compose_file = ? ORDER BY created_at DESC, id DESC LIMIT 20)',
    ).run(composeFile, composeFile);
  } catch {
    // 忽略记录失败
  }
}
