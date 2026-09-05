/**
 * Helm CLI 集成（1.23.0）
 *
 * 通过面板所在主机已安装的 helm 可执行文件执行 install/upgrade。
 * - 使用 execFile（无 shell）+ 白名单参数，避免注入；
 * - 名称 / namespace / chart 仅允许 [a-zA-Z0-9._-/]；
 * - 超时默认 10 分钟。
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** helm 二进制名（可用 HELM_BIN 覆盖为绝对路径） */
const helmBin = process.env.HELM_BIN || 'helm';

/** 标识符合法性（invalid release name: / invalid namespace / invalid set key）：字母数字与 . - _，不允许路径分隔符 */
function safeId(v: string, what: string): string {
  const s = String(v || '').trim();
  if (!s || !/^[a-zA-Z0-9._-]+$/.test(s)) throw new Error(`${what} ${v}`);
  return s;
}

/** chart 合法性（允许 repo/子路径，如 stable/nginx）：字母数字与 . - _ / */
function safeChart(v: string, what: string): string {
  const s = String(v || '').trim();
  if (!s || !/^[a-zA-Z0-9._/-]+$/.test(s)) throw new Error(`${what} ${v}`);
  return s;
}

/** 执行 helm 命令，返回 stdout（stderr 追加在错误信息中） */
function run(args: string[], timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(helmBin, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(String(stderr || err.message).trim()));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

/** 检测 helm CLI 是否可用 */
export function helmCliStatus(): Promise<{ available: boolean; version: string }> {
  return new Promise<{ available: boolean; version: string }>((resolve) => {
    execFile(helmBin, ['version', '--short'], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve({ available: false, version: '' });
        return;
      }
      resolve({ available: true, version: String(stdout || '').trim() });
    });
  });
}

/**
 * helm install（已存在时自动转为 upgrade --install 语义）
 * @returns 命令输出
 */
export async function helmInstall(opts: {
  name: string;
  namespace: string;
  chart: string;
  version?: string;
  setArgs?: Record<string, string>;
  createNamespace?: boolean;
}): Promise<string> {
  const name = safeId(opts.name, 'invalid release name:');
  const ns = safeId(opts.namespace, 'invalid namespace');
  // 上传的 chart 为服务器本地路径（chartUploadDir 下），跳过 repo 命名白名单
  const isUploadPath = opts.chart.startsWith(chartUploadDir);
  const chart = isUploadPath ? opts.chart : safeChart(opts.chart, 'invalid chart');
  const args = ['upgrade', '--install', name, chart, '--namespace', ns, '--output', 'json'];
  if (opts.version) {
    const v = safeChart(opts.version, 'invalid chart version');
    args.push('--version', v);
  }
  for (const [k, v] of Object.entries(opts.setArgs || {})) {
    const key = safeId(k, 'invalid set key');
    args.push('--set', `${key}=${String(v)}`);
  }
  if (opts.createNamespace !== false) args.push('--create-namespace');
  return run(args);
}

/** helm repo add（1.25.0，k8s.write 门禁） */
export async function helmRepoAdd(name: string, url: string): Promise<string> {
  const n = safeId(name, 'invalid repo name');
  const u = String(url || '').trim();
  if (!/^https?:\/\/[a-zA-Z0-9._/:?=&~-]+$/.test(u)) throw new Error('invalid repo url');
  return run(['repo', 'add', n, u]);
}

/** helm repo remove（1.25.0，k8s.write 门禁） */
export async function helmRepoRemove(name: string): Promise<string> {
  const n = safeId(name, 'invalid repo name');
  return run(['repo', 'remove', n]);
}

/** helm repo list（1.25.0） */
export function helmRepoList(): Promise<Array<{ name: string; url: string }>> {
  return new Promise((resolve, reject) => {
    execFile(helmBin, ['repo', 'list', '--output', 'json'], { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      // repo list 在没有任何仓库时以非零退出，视为空列表
      if (err) {
        resolve([]);
        return;
      }
      try {
        const rows = JSON.parse(String(stdout || '[]'));
        resolve(
          (Array.isArray(rows) ? rows : []).map((r: any) => ({ name: String(r.name || ''), url: String(r.url || '') })),
        );
      } catch (e) {
        reject(new Error(String(stderr || (e as Error).message).trim()));
      }
    });
  });
}

/** helm search repo（1.25.0） */
export function helmRepoSearch(keyword: string, limit = 50): Promise<Array<{ name: string; chart: string; version: string; description: string }>> {
  const kw = String(keyword || '').trim();
  const args = ['search', 'repo'];
  if (kw) args.push(kw);
  args.push('--output', 'json', '--max-col-width', '120');
  return new Promise((resolve, reject) => {
    execFile(helmBin, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(String(stderr || err.message).trim()));
        return;
      }
      try {
        const rows = JSON.parse(String(stdout || '[]')) as any[];
        resolve(
          rows.slice(0, limit).map((r) => ({
            name: String(r.name || ''),
            chart: String(r.chart || ''),
            version: String(r.version || ''),
            description: String(r.description || ''),
          })),
        );
      } catch (e) {
        reject(new Error(String((e as Error).message).trim()));
      }
    });
  });
}

/** 上传 chart 包保存目录（1.27.0） */
const chartUploadDir = path.join(os.tmpdir(), 'dm-helm-charts');

/** 保存上传的 chart 包到临时目录并返回服务器绝对路径（1.27.0） */
export function saveChartUpload(buf: Buffer): string {
  fs.mkdirSync(chartUploadDir, { recursive: true });
  // 清理超过 24 小时的旧上传（审批等待期内的文件保留）
  try {
    for (const f of fs.readdirSync(chartUploadDir)) {
      const full = path.join(chartUploadDir, f);
      if (Date.now() - fs.statSync(full).mtimeMs > 24 * 3600 * 1000) fs.rmSync(full, { force: true });
    }
  } catch {
    /* ignore */
  }
  const file = path.join(chartUploadDir, `chart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tgz`);
  fs.writeFileSync(file, buf);
  return file;
}

/** 删除上传的 chart 包（仅允许删除上传目录内文件，1.27.0） */
export function cleanChartUpload(p: string): void {
  try {
    if (String(p || '').startsWith(chartUploadDir)) fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}
