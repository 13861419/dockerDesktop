/**
 * Helm CLI 集成（1.23.0）
 *
 * 通过面板所在主机已安装的 helm 可执行文件执行 install/upgrade。
 * - 使用 execFile（无 shell）+ 白名单参数，避免注入；
 * - 名称 / namespace / chart 仅允许 [a-zA-Z0-9._-/]；
 * - 超时默认 10 分钟。
 */
import { execFile } from 'child_process';

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
  const chart = safeChart(opts.chart, 'invalid chart');
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
