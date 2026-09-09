/**
 * Compose 路径与命令执行共享工具（tasks.ts / deploys.ts / compose.ts 同规则）
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Compose 项目根目录（支持环境变量覆盖） */
export const COMPOSE_ROOT = process.env.COMPOSE_ROOT
  ? process.env.COMPOSE_ROOT
  : path.join(os.tmpdir(), 'docker-compose-projects');

/** 允许的 compose 文件名 */
export const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * 安全地执行 shell 命令，捕获 stdout / stderr
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
 * 获取指定项目目录下实际存在的 compose 文件完整路径
 */
export function findComposeFile(dir: string): string | null {
  for (const name of COMPOSE_FILES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
