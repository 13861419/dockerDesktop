/**
 * 宿主机终端 API 路由（挂载路径 /api/hostterminal）
 *
 * 非交互式命令执行器：通过 child_process 在宿主机（Windows）执行单条
 * PowerShell / cmd 命令并返回输出。后端维护一个"会话工作目录"，执行 cd 后
 * 后续命令基于新目录执行，以获得接近交互式终端的基础体验。
 *
 * 安全约束：
 *  - 仅支持 powershell / cmd 两种 shell。
 *  - 命令最大长度限制（防滥用）。
 *  - 每条命令超时限制（默认 60 秒，防卡死），stdout+stderr 合并返回。
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const router = Router();

/** 命令最大长度 */
const MAX_CMD_LEN = 8000;
/** 单条命令默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 60000;
/** 输出最大收集长度（字符） */
const MAX_OUTPUT_LEN = 200000;

/** 会话工作目录（全局单会话） */
let sessionCwd = process.env.USERPROFILE || process.env.HOME || 'C:\\';

/** 支持的 shell */
type Shell = 'powershell' | 'cmd';

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
 * 规范化工作目录：必须是已存在的绝对目录，否则回退到会话根
 * @param raw 用户传入目录
 * @returns 合法绝对目录
 */
function normalizeCwd(raw: string | undefined | null): string {
  const p = path.resolve(String(raw || '').trim() || sessionCwd);
  try {
    if (fs.statSync(p).isDirectory()) return p;
  } catch {
    // 目录不可用，回退
  }
  return sessionCwd;
}

/**
 * 使用 spawn 执行单条命令并收集输出（stdout + stderr 合并），支持超时强制结束
 * @param shell shell 类型
 * @param command 命令文本
 * @param cwd 工作目录
 * @param timeoutMs 超时毫秒
 * @returns 输出与退出码
 */
async function runShell(
  shell: Shell,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ output: string; exitCode: number | null }> {
  const args =
    shell === 'powershell'
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['/c', command];

  return await new Promise((resolve) => {
    const child = spawn(shell === 'powershell' ? 'powershell.exe' : 'cmd.exe', args, {
      cwd,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];

    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));

    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 忽略
        }
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ output: String(err?.message || '无法启动进程'), exitCode: 1 });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8');
      resolve({ output, exitCode: code });
    });
  });
}

/**
 * 截断过长的输出
 * @param output 原始输出
 */
function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_LEN) return output;
  return output.slice(0, MAX_OUTPUT_LEN) + '\n...(输出已截断)';
}

/**
 * 处理 cd 命令以更新会话工作目录
 * @param command 原始命令
 * @param shell shell 类型
 * @returns 解析后的新工作目录（若未改变则返回原值）
 */
function applyCdIfAny(command: string, shell: Shell): string | null {
  const trimmed = command.trim();
  const cdRe = /^cd\s+(.+)$/i;
  const m = trimmed.match(cdRe);
  if (!m) return null;
  let target = m[1].trim().replace(/^["']|["']$/g, '').replace(/;$/, '');
  let next: string;
  if (target === '~') {
    next = process.env.USERPROFILE || sessionCwd;
  } else if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\')) {
    next = path.resolve(target);
  } else if (target === '..') {
    next = path.dirname(sessionCwd);
  } else {
    next = path.resolve(sessionCwd, target);
  }
  try {
    if (fs.statSync(next).isDirectory()) return next;
  } catch {
    return null;
  }
  return null;
}

/**
 * GET /api/hostterminal/info
 * 返回当前会话工作目录与可用 shell
 */
router.get(
  '/info',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ cwd: sessionCwd, shell: 'powershell' as Shell, shells: ['powershell', 'cmd'] });
  }),
);

/**
 * POST /api/hostterminal/exec
 * 执行单条命令
 * @body command 命令文本
 * @body shell   powershell | cmd（默认 powershell）
 * @body cwd     可选，执行目录（默认会话工作目录）
 * @body timeout 可选，超时毫秒
 */
router.post(
  '/exec',
  asyncHandler(async (req: Request, res: Response) => {
    const command = String(req.body?.command || '').trim();
    const shell: Shell = req.body?.shell === 'cmd' ? 'cmd' : 'powershell';
    const cwd = normalizeCwd(req.body?.cwd);
    const timeout = Math.min(Number(req.body?.timeout) || DEFAULT_TIMEOUT_MS, 300000);

    if (!command) {
      return res.status(400).json({ error: '命令不能为空' });
    }
    if (command.length > MAX_CMD_LEN) {
      return res.status(400).json({ error: `命令过长（上限 ${MAX_CMD_LEN} 字符）` });
    }

    // 尝试解析 cd 命令以更新会话目录；即使解析失败也继续执行
    const newCwd = applyCdIfAny(command, shell);
    if (newCwd) sessionCwd = newCwd;

    try {
      const { output, exitCode } = await runShell(shell, command, cwd, timeout);
      res.json({ output: truncate(output), exitCode, cwd: sessionCwd });
    } catch (err: any) {
      // child_process 错误：倾印 message（可能含 stderr）
      const detail =
        err?.stderr || err?.stdout || err?.message || '命令执行失败';
      const killed = err?.killed ? '（进程被终止：可能超时）' : '';
      res.json({
        output: truncate(String(detail)) + killed,
        exitCode: err?.code ?? 1,
        cwd: sessionCwd,
      });
    }
  }),
);

export default router;
