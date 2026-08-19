/**
 * 计划任务（Cron Tasks）API 路由
 *
 * 提供计划任务的 CRUD、启停、手动执行、执行历史查询与导出能力。
 * 与调度器（scheduler.ts）协作：
 *  - 本模块在加载时通过 registerTaskHandler 注册 5 类任务执行函数
 *    （prune / backup / pull / composeUp / composeDown）；
 *  - 通过 setTaskRunCallback 注册"每次执行后写入 cron_task_logs"的回调；
 *  - 手动"立即执行"与定时调度共用同一套 handler 与回写逻辑。
 *
 * 数据存储全部基于 node:sqlite（storage.getDb()），不引入任何新 npm 依赖。
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { encryptSecret, decryptSecret } from '../storage';
import { gitCloneOrPull, gitAvailable, randomHex, GitCred } from '../gitCli';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { requireAdmin } from '../auth';
import {
  getDb,
  exportDatabase,
  getDataDir,
} from '../storage';
import {
  registerTaskHandler,
  setTaskRunCallback,
  nextRunTime,
  CronTaskRow,
  TaskRunResult,
} from '../scheduler';
import { logOperation } from '../operationLog';
import { getDockerClient } from '../docker/client';
import { pullWithFailover } from '../docker/pull';
import { reportTaskFailure } from '../alerting';

const execAsync = promisify(exec);
const router = Router();

/** Compose 项目根目录（与 compose.ts 保持一致，支持环境变量覆盖） */
const COMPOSE_ROOT = process.env.COMPOSE_ROOT
  ? process.env.COMPOSE_ROOT
  : path.join(os.tmpdir(), 'docker-compose-projects');

/** 允许的 compose 文件名（与 compose.ts 保持一致） */
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/** 备份容器使用的轻量镜像（压缩命名卷用） */
const BACKUP_IMAGE = 'alpine:latest';

/**
 * 统一兜底错误处理
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
 * 获取指定项目目录下实际存在的 compose 文件名（与 compose.ts 同风格）
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
 * 列出 Compose 根目录下的所有项目目录名（供前端下拉选择）
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
 * 确保目录存在（递归创建）
 * @param dir 目录路径
 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 生成一个随机 UUID（作为任务 id / 日志 id）
 * @returns UUID 字符串
 */
function uuid(): string {
  return crypto.randomUUID();
}

/**
 * 将 crank 任务数据库行序列化为前端友好的 camelCase 对象
 * @param row 数据库行
 * @returns 序列化对象（config 已 JSON.parse）
 */
function serializeTask(row: CronTaskRow): Record<string, any> {
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch {
    config = {};
  }
  let gitCred: { type?: 'token' | 'ssh'; hasCred: boolean } = { hasCred: false };
  if ((row as any).git_cred_encrypted) {
    try {
      const parsed = JSON.parse(decryptSecret(String((row as any).git_cred_encrypted)) || '{}');
      gitCred = { type: parsed?.type || undefined, hasCred: true };
    } catch {
      gitCred = { hasCred: false };
    }
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    cron: row.cron,
    enabled: row.enabled === 1,
    config,
    webhookToken: (row as any).webhook_token || null,
    gitCred,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastDetail: row.last_detail,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 查询单个任务行
 * @param id 任务 id
 * @returns 任务行，未找到返回 null
 */
function getTaskRow(id: string): CronTaskRow | null {
  const row = getDb()
    .prepare(
      'SELECT id, name, type, cron, enabled, config, webhook_token, git_cred_encrypted, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at FROM cron_tasks WHERE id = ?',
    )
    .get(id) as unknown as CronTaskRow | undefined;
  return row || null;
}

// ============ 任务类型 handler（供调度器与手动执行共用） ============

/**
 * handler：清理 Docker 未使用资源（prune）
 * config={images,containers,volumes,networks,buildCache}，默认全部开启，失败一项不阻断其余。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与清理详情
 */
async function runPruneHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const docker = await getDockerClient();
  const want = (flag: any) => flag === true;
  const lines: string[] = [];
  // 默认全部类别开启
  const doImages = config.images === undefined ? true : want(config.images);
  const doContainers = config.containers === undefined ? true : want(config.containers);
  const doVolumes = config.volumes === undefined ? true : want(config.volumes);
  const doNetworks = config.networks === undefined ? true : want(config.networks);
  const doBuildCache = config.buildCache === undefined ? true : want(config.buildCache);

  // 清理悬空镜像
  if (doImages) {
    try {
      const r = await docker.pruneImages({ dangling: true });
      const names = (r?.ImagesDeleted || []).map((d: any) => d?.Untagged || d?.Deleted || '').filter(Boolean);
      lines.push(`镜像: 删除 ${names.length} 个, 回收 ${r?.SpaceReclaimed || 0} 字节`);
    } catch (e: any) {
      lines.push(`镜像清理失败: ${e?.message || e}`);
    }
  }
  // 清理已停止容器
  if (doContainers) {
    try {
      const r = await docker.pruneContainers();
      lines.push(`容器: 删除 ${r?.ContainersDeleted?.length || 0} 个, 回收 ${r?.SpaceReclaimed || 0} 字节`);
    } catch (e: any) {
      lines.push(`容器清理失败: ${e?.message || e}`);
    }
  }
  // 清理未使用数据卷
  if (doVolumes) {
    try {
      const r = await docker.pruneVolumes();
      lines.push(`卷: 删除 ${r?.VolumesDeleted?.length || 0} 个, 回收 ${r?.SpaceReclaimed || 0} 字节`);
    } catch (e: any) {
      lines.push(`卷清理失败: ${e?.message || e}`);
    }
  }
  // 清理未使用网络
  if (doNetworks) {
    try {
      const r: any = await docker.pruneNetworks();
      lines.push(`网络: 删除 ${r?.NetworksDeleted?.length || 0} 个`);
    } catch (e: any) {
      lines.push(`网络清理失败: ${e?.message || e}`);
    }
  }
  // 清理 build cache
  if (doBuildCache) {
    try {
      const r: any = await (docker.pruneBuilder as any)({ all: true });
      lines.push(`构建缓存: 回收 ${r?.SpaceReclaimed || 0} 字节`);
    } catch (e: any) {
      lines.push(`构建缓存清理失败: ${e?.message || e}`);
    }
  }
  return { ok: true, detail: lines.join('\n') };
}

/**
 * 清理备份目录中超过保留数量的最旧备份文件
 * @param destDir 备份目录
 * @param keepCount 保留个数（<=0 视为不清理）
 */
function cleanupBackups(destDir: string, keepCount: number): void {
  if (!fs.existsSync(destDir) || !(keepCount > 0)) return;
  // 按文件名排序（时间命名，字典序即时间序），升序保留后 keepCount 个
  const files = fs
    .readdirSync(destDir)
    .filter((f) => /\.(tar\.gz|db\.backup)$/.test(f))
    .sort();
  const toRemove = files.slice(0, Math.max(0, files.length - keepCount));
  for (const f of toRemove) {
    try {
      fs.rmSync(path.join(destDir, f), { force: true });
    } catch {
      // 单个文件删除失败不阻断
    }
  }
}

/**
 * handler：备份（backup）
 * config={target:'database'|'volumes', volumes?, keepCount?, destDir?}
 * target='database'：导出面板数据库为副本并拷贝到备份目录；
 * target='volumes'：用一次性容器将命名卷打包为 tar.gz。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与生成文件列表
 */
async function runBackupHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const target = config.target === 'volumes' ? 'volumes' : 'database';
  const keepCount = Number(config.keepCount) > 0 ? Number(config.keepCount) : 0;
  const dataDir = getDataDir();

  // 备份数据库（default）分支
  if (target === 'database') {
    // 默认备份目录：<数据目录>/backups/database
    const destDir = config.destDir || path.join(dataDir, 'backups', 'database');
    ensureDir(destDir);
    const srcPath = exportDatabase();
    // 时间命名的目标文件名
    const fileName = `database-${new Date().toISOString().replace(/[:.]/g, '-')}.db.backup`;
    const dest = path.join(destDir, fileName);
    fs.copyFileSync(srcPath, dest);
    try {
      fs.rmSync(srcPath, { force: true });
    } catch {
      // 源临时文件删除失败不阻断
    }
    cleanupBackups(destDir, keepCount);
    return { ok: true, detail: `数据库备份: ${fileName}` };
  }

  // 备份命名卷分支
  const volumes = Array.isArray(config.volumes) ? config.volumes.filter((v: any) => typeof v === 'string' && v) : [];
  if (volumes.length === 0) {
    return { ok: true, detail: '未指定待备份的命名卷' };
  }
  const destDir = config.destDir || path.join(dataDir, 'backups', 'volumes');
  ensureDir(destDir);
  const docker = await getDockerClient();
  // 若本地已存在镜像则跳过拉取，否则拉取备份镜像
  try {
    await docker.getImage(BACKUP_IMAGE).inspect();
  } catch {
    await pullWithFailover(docker, BACKUP_IMAGE);
  }
  const generated: string[] = [];
  for (const vol of volumes) {
    const fileName = `${vol}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    const dest = path.join(destDir, fileName);
    // 一次性 --rm 容器：挂载命名卷到 /backup、宿主备份目录到 /out，容器内执行 tar 打包
    const container = await docker.createContainer({
      Image: BACKUP_IMAGE,
      Cmd: ['sh', '-c', `tar -czf /out/${fileName} -C /backup .`],
      HostConfig: {
        Binds: [`${vol}:/backup`, `${destDir}:/out`],
        AutoRemove: true,
      },
    });
    await container.start();
    const waitRes = await container.wait();
    if (waitRes?.StatusCode !== 0) {
      generated.push(`${vol}: 打包失败(退出码 ${waitRes?.StatusCode})`);
      continue;
    }
    generated.push(fileName);
  }
  cleanupBackups(destDir, keepCount);
  return { ok: true, detail: `卷备份文件:\n${generated.join('\n')}` };
}

/**
 * handler：拉取镜像（pull）
 * config={image, source?}，调用 pullWithFailover 多源拉取。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与镜像引用
 */
async function runPullHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const image = config.image;
  if (!image || typeof image !== 'string') {
    return { ok: false, detail: '缺少镜像名称(image)' };
  }
  const docker = await getDockerClient();
  const result = await pullWithFailover(docker, image, config.source || undefined);
  return { ok: true, detail: `镜像 ${image} 拉取完成, 实际引用: ${result.ref} (源: ${result.source})` };
}

/**
 * handler：部署 Compose 项目（composeUp）
 * config={project}，在项目目录执行 docker compose -f <file> up -d。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与命令输出
 */
async function runComposeUpHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const project = config.project;
  if (!project || typeof project !== 'string') {
    return { ok: false, detail: '缺少项目名(project)' };
  }
  const dir = path.join(COMPOSE_ROOT, project);
  const composeFile = findComposeFile(dir);
  if (!composeFile) {
    return { ok: false, detail: `项目 ${project} 不存在或缺少 compose 文件` };
  }
  try {
    const output = await runCmd(`docker compose -f "${composeFile}" up -d`, dir);
    return { ok: true, detail: output || 'compose up 完成' };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

/**
 * handler：停止 Compose 项目（composeDown）
 * config={project}，在项目目录执行 docker compose down。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与命令输出
 */
async function runComposeDownHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const project = config.project;
  if (!project || typeof project !== 'string') {
    return { ok: false, detail: '缺少项目名(project)' };
  }
  const dir = path.join(COMPOSE_ROOT, project);
  const composeFile = findComposeFile(dir);
  if (!composeFile) {
    return { ok: false, detail: `项目 ${project} 不存在或缺少 compose 文件` };
  }
  try {
    const output = await runCmd(`docker compose -f "${composeFile}" down`, dir);
    return { ok: true, detail: output || 'compose down 完成' };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

/**
 * handler：重启容器（restart）
 * config={containers:[...]}，逐个调用 docker restart（缺失容器记录为失败但继续后续）。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与每容器结果
 */
async function runRestartHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const containers = Array.isArray(config.containers)
    ? config.containers.filter((v: any) => typeof v === 'string' && v.trim())
    : [];
  if (containers.length === 0) {
    return { ok: false, detail: '缺少待重启的容器(containers)' };
  }
  const docker = await getDockerClient();
  const lines: string[] = [];
  let fail = 0;
  for (const ref of containers) {
    // 支持按名称或 id：先尝试名称解析
    const name = ref.trim();
    let cid: string | null = null;
    try {
      const list = await docker.listContainers({ all: true, filters: { name: [name] } });
      const hit = (list as any[]).find((c) => c.Names?.includes('/' + name));
      cid = hit?.Id || null;
    } catch {
      cid = null;
    }
    if (!cid) {
      try {
        await docker.getContainer(name).inspect();
        cid = name;
      } catch {
        lines.push(`容器 ${name}: 未找到`);
        fail++;
        continue;
      }
    }
    try {
      await docker.getContainer(cid as string).restart();
      lines.push(`容器 ${name}: 已重启`);
    } catch (e: any) {
      lines.push(`容器 ${name}: 重启失败 ${e?.message || e}`);
      fail++;
    }
  }
  return { ok: fail === 0, detail: lines.join('\n') || '无容器可重启' };
}

/**
 * handler：执行自定义命令（command）
 * config={command, cwd?}，用宿主 shell 执行并捕获输出（失败抛异常由外层记录）。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与命令输出
 */
async function runCommandHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const command = config.command;
  if (!command || typeof command !== 'string' || !command.trim()) {
    return { ok: false, detail: '缺少要执行的命令(command)' };
  }
  const cwd = typeof config.cwd === 'string' && config.cwd ? config.cwd : os.tmpdir();
  try {
    const output = await runCmd(command, cwd);
    return { ok: true, detail: output || '命令执行完成（无输出）' };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

/**
 * handler：容器健康检查（healthcheck）
 * config={containers:[...]}，检查容器是否处于 running 状态；容器不存在或未运行记失败，
 * 触发告警，适合与告警中心联动做故障恢复前的定时探活。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与每容器状态
 */
async function runHealthcheckHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const containers = Array.isArray(config.containers)
    ? config.containers.filter((v: any) => typeof v === 'string' && v.trim())
    : [];
  if (containers.length === 0) {
    return { ok: false, detail: '缺少待检查的容器(containers)' };
  }
  const docker = await getDockerClient();
  const lines: string[] = [];
  let unhealthy = 0;
  for (const ref of containers) {
    const name = ref.trim();
    const list = await docker.listContainers({ all: true, filters: { name: [name] } });
    const hit = (list as any[]).find((c) => c.Names?.includes('/' + name));
    if (!hit) {
      lines.push(`容器 ${name}: 不存在（异常）`);
      unhealthy++;
      continue;
    }
    const state = hit.State || '';
    // Health 字段仅运行中的容器可能带（容器需配置 healthcheck）
    const health = hit.Status || '';
    if (state === 'running' && !/unhealthy/i.test(health)) {
      lines.push(`容器 ${name}: 运行正常`);
    } else {
      lines.push(`容器 ${name}: ${state}${/unhealthy/i.test(health) ? '(unhealthy)' : ''}（异常）`);
      unhealthy++;
    }
  }
  return { ok: unhealthy === 0, detail: lines.join('\n') };
}

/**
 * handler：Git 拉取 + 构建/部署（git-pull-build）
 * config={repoUrl, branch?, mode:'compose'|'image', destDir?, composeProject?, alsoBuild?,
 *         imageName?, dockerfile?, buildArgs?}
 *  - compose 模式：克隆/拉取到 COMPOSE_ROOT/composeProject，执行 docker compose up -d（可加 --build）；
 *  - image 模式：在本地目录构建镜像并打上 imageName tag。
 * 私有仓库凭证从 git_cred_encrypted 解密获取。
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与日志
 */
async function runGitPullBuildHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const repoUrl = config.repoUrl;
  if (!repoUrl || typeof repoUrl !== 'string') {
    return { ok: false, detail: '缺少 Git 仓库地址(repoUrl)' };
  }
  let cred: GitCred | null = null;
  const encCred = (task as any).git_cred_encrypted;
  if (encCred) {
    try {
      const parsed = JSON.parse(decryptSecret(String(encCred)) || '{}');
      if (parsed) cred = parsed;
    } catch {
      cred = null;
    }
  }
  const notAvail = await gitAvailable();
  if (!notAvail) {
    return { ok: false, detail: '本机未检测到 git 命令，无法执行 Git 部署' };
  }
  const mode = config.mode === 'compose' ? 'compose' : 'image';
  const lines: string[] = [];
  const repoDir =
    mode === 'compose' && config.composeProject
      ? path.join(COMPOSE_ROOT, config.composeProject)
      : config.destDir || path.join(os.tmpdir(), 'docker-git-pipeline', task.id);

  try {
    const gitOut = await gitCloneOrPull({ repoUrl, dir: repoDir, branch: config.branch, cred });
    lines.push(gitOut);
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }

  if (mode === 'image') {
    const imageName = config.imageName;
    if (!imageName || typeof imageName !== 'string') {
      return { ok: false, detail: 'image 模式缺少镜像名(imageName)' };
    }
    try {
      const docker = await getDockerClient();
      const dockerfile = config.dockerfile || 'Dockerfile';
      const buildArgs = config.buildArgs && typeof config.buildArgs === 'object' ? config.buildArgs : {};
      const stream = await docker.buildImage(
        { context: repoDir, src: ['.'] },
        { t: imageName, dockerfile, buildargs: buildArgs, pull: true },
      );
      const logTail = await new Promise<string>((resolve, reject) => {
        let acc = '';
        stream.on('data', (d: Buffer) => { acc = (acc + d.toString()) || ''; if (acc.length > 200000) acc = acc.slice(-200000); });
        stream.on('end', () => resolve(acc));
        stream.on('error', reject);
      });
      if (/error|failed/i.test(logTail)) {
        return { ok: false, detail: `镜像构建可能失败:\n${logTail.slice(-4000)}` };
      }
      lines.push(`镜像构建完成: ${imageName}`);
      lines.push(logTail.slice(-1500));
    } catch (e: any) {
      return { ok: false, detail: `镜像构建失败: ${e?.message || e}` };
    }
    return { ok: true, detail: lines.join('\n') };
  }

  const dir = path.join(COMPOSE_ROOT, config.composeProject || '');
  const composeFile = findComposeFile(dir);
  if (!composeFile) {
    return { ok: false, detail: `compose 项目 ${config.composeProject} 不存在或缺少 compose 文件` };
  }
  try {
    const buildFlag = config.alsoBuild ? ' --build' : '';
    const output = await runCmd(`docker compose -f "${composeFile}" up -d${buildFlag}`, dir);
    lines.push(output || 'compose up 完成');
    return { ok: true, detail: lines.join('\n') };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

/** 任务类型 → handler 的本地注册表（供手动执行与注册到调度器共用） */
const taskHandlers: Record<string, (task: CronTaskRow, config: Record<string, any>) => Promise<TaskRunResult>> = {
  prune: runPruneHandler,
  backup: runBackupHandler,
  pull: runPullHandler,
  composeUp: runComposeUpHandler,
  composeDown: runComposeDownHandler,
  restart: runRestartHandler,
  command: runCommandHandler,
  healthcheck: runHealthcheckHandler,
  'git-pull-build': runGitPullBuildHandler,
};

/** 记录一次执行结果到历史表（由 setTaskRunCallback 注册，手动执行亦复用） */
function recordTaskRun(task: CronTaskRow, result: TaskRunResult): void {
  getDb()
    .prepare(
      'INSERT INTO cron_task_logs (task_id, name, type, run_at, status, detail) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(task.id, task.name, task.type, Date.now(), result.ok ? 0 : 1, result.detail || null);
}

// 模块加载时：注册全部 handler 与执行历史回调
for (const type of Object.keys(taskHandlers)) {
  registerTaskHandler(type, taskHandlers[type]);
}
setTaskRunCallback(recordTaskRun);

/**
 * 执行单个任务（手动立即执行与逻辑复用）：查询任务、调用 handler、更新状态、写历史。
 * 与调度器内部 executeTask 保持一致的口径，保证手动与定时行为一致。
 * @param id 任务 id
 * @returns 执行结果
 * @throws 任务不存在时抛错
 */
async function dispatchTask(id: string): Promise<TaskRunResult> {
  const row = getTaskRow(id);
  if (!row) {
    const notFound: any = new Error('任务不存在');
    notFound.statusCode = 404;
    throw notFound;
  }
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch {
    config = {};
  }
  const handler = taskHandlers[row.type];
  let result: TaskRunResult;
  if (!handler) {
    result = { ok: false, detail: `任务类型 ${row.type} 未注册处理器` };
  } else {
    try {
      result = await handler(row, config);
    } catch (e: any) {
      result = { ok: false, detail: String(e?.message || e) };
    }
  }
  // 更新任务最近执行状态与下次执行时间（与调度器同逻辑）
  const now = Date.now();
  const nextRun = nextRunTime(row.cron, now);

  // 手动执行失败：推送告警（不阻塞任务执行）
  if (!result.ok) {
    try {
      await reportTaskFailure(row.name || row.id, result.detail || '未知错误', '手动执行');
    } catch {
      // 告警失败不影响任务本身
    }
  }

  getDb()
    .prepare(
      `UPDATE cron_tasks
       SET last_run_at = ?, last_status = ?, last_detail = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(now, result.ok ? 0 : 1, result.detail || null, nextRun ?? now, now, row.id);
  // 记录执行历史
  try {
    recordTaskRun({ ...row, last_run_at: now, last_status: result.ok ? 0 : 1, last_detail: result.detail ?? null, next_run_at: nextRun ?? now }, result);
  } catch {
    // 历史记录失败不影响任务执行
  }
  return result;
}

// ============ API 端点 ============

/**
 * GET /api/tasks
 * 获取任务列表，并附带所有已登记的 Compose 项目名（供前端下拉）
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = getDb()
      .prepare(
        'SELECT id, name, type, cron, enabled, config, webhook_token, git_cred_encrypted, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at FROM cron_tasks ORDER BY created_at DESC',
      )
      .all() as unknown as CronTaskRow[];
    const projects = listProjectDirs();
    res.json({ tasks: rows.map(serializeTask), projects });
  }),
);

/**
 * POST /api/tasks
 * 新建计划任务
 * body: { name, type, cron, enabled, config }
 */
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { name, type, cron, enabled, config } = req.body || {};
    if (!name || !type) {
      return res.status(400).json({ error: '需要任务名称和类型' });
    }
    if (!cron || typeof cron !== 'string') {
      return res.status(400).json({ error: 'cron 表达式必填' });
    }
    // 校验 cron 可解析
    if (nextRunTime(cron) === null) {
      return res.status(400).json({ error: 'cron 表达式无法解析' });
    }
    const gitCred = req.body?.gitCred;
    const gitCredEnc =
      gitCred && (gitCred.token || gitCred.privateKey)
        ? encryptSecret(
            JSON.stringify({
              type: gitCred.type === 'ssh' ? 'ssh' : 'token',
              token: gitCred.token || undefined,
              privateKey: gitCred.privateKey || undefined,
              passphrase: gitCred.passphrase || undefined,
            }),
          )
        : null;
    const id = uuid();
    const now = Date.now();
    const nextRun = nextRunTime(cron, now) as number;
    const isEnabled = enabled === true || enabled === undefined ? 1 : 0;
    getDb()
      .prepare(
        'INSERT INTO cron_tasks (id, name, type, cron, enabled, config, git_cred_encrypted, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, type, cron, isEnabled, JSON.stringify(config || {}), gitCredEnc, nextRun, now, now);
    logOperation(res.locals.username, '新建计划任务', 'task', name, `类型: ${type}`);
    res.json({ ok: true, id });
  }),
);

/**
 * PUT /api/tasks/:id
 * 更新任务的 name / cron / enabled / config，并重新计算 next_run_at
 */
router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getTaskRow(req.params.id);
    if (!row) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const { name, cron, enabled, config } = req.body || {};
    if (cron !== undefined && (typeof cron !== 'string' || nextRunTime(cron) === null)) {
      return res.status(400).json({ error: 'cron 表达式无效' });
    }
    const newName = name !== undefined ? name : row.name;
    const newCron = cron !== undefined ? cron : row.cron;
    const newEnabled = enabled !== undefined ? (enabled === true ? 1 : 0) : row.enabled;
    const newConfig = config !== undefined ? JSON.stringify(config) : row.config;
    // 仅当请求给了 gitCred 才更新凭证；null 表示清空；不含敏感字段表示保留
    let newGitCredEnc = (row as any).git_cred_encrypted;
    if (req.body?.gitCred === null) {
      newGitCredEnc = null;
    } else if (req.body?.gitCred && (req.body.gitCred.token || req.body.gitCred.privateKey)) {
      const gc = req.body.gitCred;
      newGitCredEnc = encryptSecret(
        JSON.stringify({
          type: gc.type === 'ssh' ? 'ssh' : 'token',
          token: gc.token || undefined,
          privateKey: gc.privateKey || undefined,
          passphrase: gc.passphrase || undefined,
        }),
      );
    }
    // 重新计算 next_run_at（禁用时清空，启用时按新 cron 计算）
    const nextRun = newEnabled === 1 ? (nextRunTime(newCron, Date.now()) as number) : row.next_run_at;
    getDb()
      .prepare(
        'UPDATE cron_tasks SET name = ?, cron = ?, enabled = ?, config = ?, git_cred_encrypted = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(newName, newCron, newEnabled, newConfig, newGitCredEnc, nextRun, Date.now(), row.id);
    logOperation(res.locals.username, '更新计划任务', 'task', newName);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/tasks/:id/webhook
 * 生成（或重置）任务专属 Webhook Token，用于远程触发任务执行
 * @returns 生成的 token 及其完整 Webhook URL
 */
router.post(
  '/:id/webhook',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getTaskRow(req.params.id);
    if (!row) return res.status(404).json({ error: '任务不存在' });
    const token = randomHex(32);
    getDb().prepare('UPDATE cron_tasks SET webhook_token = ?, updated_at = ? WHERE id = ?').run(token, Date.now(), row.id);
    logOperation(res.locals.username, '生成计划任务 Webhook', 'task', row.name);
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, url: `${base}/api/webhook/${token}`, token });
  }),
);

/**
 * DELETE /api/tasks/:id/webhook
 * 关闭任务 Webhook，清空已生成的 Token
 */
router.delete(
  '/:id/webhook',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getTaskRow(req.params.id);
    if (!row) return res.status(404).json({ error: '任务不存在' });
    getDb().prepare('UPDATE cron_tasks SET webhook_token = NULL, updated_at = ? WHERE id = ?').run(Date.now(), row.id);
    logOperation(res.locals.username, '关闭计划任务 Webhook', 'task', row.name);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/tasks/:id/enable
 * 启用/停用任务，启用时重算 next_run_at，停用时清空
 * body: { enabled: boolean }
 */
router.post(
  '/:id/enable',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getTaskRow(req.params.id);
    if (!row) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const { enabled } = req.body || {};
    const isEnabled = enabled === true ? 1 : 0;
    // 启用时按当前 cron 重算下次执行时间；停用则清空（-1 占位表示无下次执行）
    const nextRun = isEnabled === 1 ? (nextRunTime(row.cron, Date.now()) as number) : -1;
    getDb()
      .prepare('UPDATE cron_tasks SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(isEnabled, nextRun, Date.now(), row.id);
    logOperation(res.locals.username, isEnabled ? '启用计划任务' : '停用计划任务', 'task', row.name);
    res.json({ ok: true });
  }),
);

/**
 * POST /api/tasks/:id/run
 * 立即手动执行一次任务，返回执行结果
 */
router.post(
  '/:id/run',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getTaskRow(req.params.id);
    if (!row) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const result = await dispatchTask(row.id);
    logOperation(
      res.locals.username,
      result.ok ? '手动执行计划任务' : '手动执行计划任务（失败）',
      'task',
      row.name,
      result.detail,
      result.ok,
    );
    res.json({ ok: result.ok, detail: result.detail, id: row.id });
  }),
);

/**
 * DELETE /api/tasks/:id
 * 删除任务及其全部执行历史
 */
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getTaskRow(req.params.id);
    if (!row) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const d = getDb();
    d.prepare('DELETE FROM cron_task_logs WHERE task_id = ?').run(row.id);
    d.prepare('DELETE FROM cron_tasks WHERE id = ?').run(row.id);
    logOperation(res.locals.username, '删除计划任务', 'task', row.name);
    res.json({ ok: true });
  }),
);

/**
 * GET /api/tasks/logs
 * 分页查询任务执行历史
 * query: taskId, page, pageSize
 */
router.get(
  '/logs',
  asyncHandler(async (req: Request, res: Response) => {
    const d = getDb();
    const taskId = req.query.taskId as string | undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (taskId) {
      where.push('task_id = ?');
      params.push(taskId);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (d.prepare(`SELECT count(*) AS c FROM cron_task_logs ${whereSql}`).get(...params) as { c: number }).c;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const rows = d
      .prepare(
        `SELECT id, task_id, name, type, run_at, status, detail
         FROM cron_task_logs ${whereSql}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as unknown as Array<{
      id: number;
      task_id: string;
      name: string | null;
      type: string | null;
      run_at: number;
      status: number;
      detail: string | null;
    }>;
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        name: r.name,
        type: r.type,
        runAt: r.run_at,
        status: r.status,
        detail: r.detail,
      })),
      total,
      page,
      pageSize,
      totalPages,
    });
  }),
);

/**
 * GET /api/tasks/logs/export
 * 导出任务执行历史为 CSV（UTF-8 BOM，便于 Excel 打开）
 * query: taskId（可选，按任务过滤）
 */
router.get(
  '/logs/export',
  asyncHandler(async (req: Request, res: Response) => {
    const d = getDb();
    const taskId = req.query.taskId as string | undefined;
    const where = taskId ? 'WHERE task_id = ?' : '';
    const params = taskId ? [taskId] : [];
    const rows = d
      .prepare(
        `SELECT id, task_id, name, type, run_at, status, detail
         FROM cron_task_logs ${where}
         ORDER BY id DESC`,
      )
      .all(...params) as unknown as Array<{
      task_id: string;
      name: string | null;
      type: string | null;
      run_at: number;
      status: number;
      detail: string | null;
    }>;

    // 转义 CSV 字段：含逗号/引号/换行时用双引号包裹并转义内部引号
    const esc = (v: string | null | undefined): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const fmt = (ts: number): string => {
      const dt = new Date(ts);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
    };
    const header = ['时间', '任务ID', '名称', '类型', '结果', '详情'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          esc(fmt(r.run_at)),
          esc(r.task_id),
          esc(r.name),
          esc(r.type),
          r.status === 0 ? '成功' : '失败',
          esc(r.detail),
        ].join(','),
      );
    }
    // 前置 UTF-8 BOM，保证中文在 Excel 中不乱码
    const csv = '\ufeff' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cron-task-logs-${Date.now()}.csv"`);
    res.send(csv);
  }),
);

/**
 * GET /api/tasks/cron-preview?cron=...
 * 计算给定 cron 表达式的下次执行时间（用于前端可视化编辑器的实时预览）
 * 语义由 scheduler.nextRunTime 提供（5 段，支持星号步进与逗号枚举）
 */
router.get(
  '/cron-preview',
  asyncHandler(async (req: Request, res: Response) => {
    const cron = String(req.query.cron || '').trim();
    if (!cron) return res.json({ nextRun: null });
    const nextRun = nextRunTime(cron, Date.now());
    res.json({ cron, nextRun });
  }),
);

export default router;
