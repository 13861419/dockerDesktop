/**
 * Git CLI 零依赖封装
 *
 * 通过系统 git 命令执行 clone / pull，并支持：
 *  - HTTPS token 注入（避免凭据落盘）
 *  - SSH 私钥临时文件（600 权限）+ core.sshCommand + StrictHostKeyChecking=accept-new
 * 供 git-pull-build 任务使用；不引入任何第三方 npm 依赖。
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const execAsync = promisify(exec);

/** Git 私有仓库凭证（明文，仅内存态；落库用加密） */
export interface GitCred {
  type: 'token' | 'ssh';
  token?: string;
  privateKey?: string;
  passphrase?: string;
}

/**
 * 判断本机是否存在可用的 git 命令
 * @returns 是否可用
 */
export async function gitAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git --version');
    return /git version/i.test(stdout || '');
  } catch {
    return false;
  }
}

/**
 * 将分支名清洗为可用的镜像 tag（仅保留字母数字._-，其余转 '-'; 空用 'latest'）
 * @param branch 分支名，可缺失
 * @returns 清洗后的 tag
 */
export function sanitizeTag(branch?: string): string {
  const raw = (branch || '').trim() || 'latest';
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'latest';
}

/**
 * 写入一个 SSH 私钥临时文件（600 权限）
 * @param privateKey 私钥内容
 * @returns 临时文件路径（调用方负责清理）
 */
function writeSshKeyFile(privateKey: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gkp-'));
  const file = path.join(dir, 'id_rsa');
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  return file;
}

/**
 * 根据协议判断 clone 应使用的 URL（HTTPS token 注入；SSH 保持原样）
 * @param repoUrl 仓库地址
 * @param cred 凭证
 * @returns 注入凭据后的 clone URL
 */
function buildCloneUrl(repoUrl: string, cred?: GitCred | null): string {
  if (!cred || cred.type !== 'token' || !cred.token) return repoUrl;
  // 仅对 https:// 协议注入 token
  if (/^https?:\/\//i.test(repoUrl)) {
    try {
      const u = new URL(repoUrl);
      u.username = encodeURIComponent(cred.token);
      return u.toString();
    } catch {
      return repoUrl;
    }
  }
  return repoUrl;
}

/**
 * 组装 git 环境变量（SSH 私钥走 core.sshCommand）
 * @param cred 凭证
 * @returns 附加的 git 环境变量与 SSH 私钥临时文件路径
 */
function buildGitContext(cred?: GitCred | null): { env: Record<string, string>; sshKeyFile: string | null } {
  const env: Record<string, string> = {};
  let sshKeyFile: string | null = null;
  if (cred && cred.type === 'ssh') {
    if (cred.passphrase) env.GIT_SSH_COMMAND = `ssh -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`;
    sshKeyFile = cred.privateKey ? writeSshKeyFile(cred.privateKey) : null;
    env.GIT_SSH_COMMAND = sshKeyFile
      ? `ssh -i "${sshKeyFile}" -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`
      : 'ssh -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes';
  }
  return { env, sshKeyFile };
}

/**
 * Git clone 或 pull
 * - 目标目录不存在/为空 → clone
 * - 目标目录已是 git 仓库 → pull（或 branch 切换 + pull）
 * @param opts 参数
 * @returns 命令输出摘要
 */
export async function gitCloneOrPull(opts: {
  repoUrl: string;
  dir: string;
  branch?: string;
  cred?: GitCred | null;
}): Promise<string> {
  const { repoUrl, dir, branch, cred } = opts;
  const cloneUrl = buildCloneUrl(repoUrl, cred);
  const { env, sshKeyFile } = buildGitContext(cred);
  const needClone =
    !fs.existsSync(dir) || fs.readdirSync(dir).filter((f) => f !== '.git').length === 0;

  let cmd: string;
  if (needClone) {
    fs.mkdirSync(dir, { recursive: true });
    cmd = branch
      ? `git clone --depth 1 --branch "${branch}" "${cloneUrl}" "${dir}"`
      : `git clone --depth 1 "${cloneUrl}" "${dir}"`;
  } else {
    cmd = `git -C "${dir}" fetch origin`;
    if (branch) cmd += ` && git -C "${dir}" checkout "${branch}"`;
    cmd += ` && git -C "${dir}" pull --ff-only`;
  }

  try {
    const { stdout, stderr } = await execAsync(cmd, { env: { ...process.env, ...env }, maxBuffer: 20 * 1024 * 1024 });
    // 清理 SSH 临时私钥
    if (sshKeyFile) cleanupSshKey(sshKeyFile);
    return (needClone ? '[clone] ' : '[pull] ') + (stdout || stderr || '').trim();
  } catch (err: any) {
    if (sshKeyFile) cleanupSshKey(sshKeyFile);
    const apiErr: any = new Error(`Git 操作失败: ${err?.stderr || err?.message || err}`);
    apiErr.statusCode = 400;
    throw apiErr;
  }
}

/** 删除 SSH 私钥临时文件（尽力而为） */
function cleanupSshKey(file: string): void {
  try {
    const dir = path.dirname(file);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/** 生成随机 hex 串（供内部使用） */
export function randomHex(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}
