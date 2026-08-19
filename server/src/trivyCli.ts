/**
 * Trivy（镜像漏洞扫描器）零依赖 CLI 封装
 *
 * 通过本机 trivy 命令执行：
 *  - 探测可用性（trivy --version）
 *  - `trivy image --format json --no-progress <name>` 扫描并解析 CVE
 * 未安装 Trivy 时返回 { available:false } 并附引导文案，不抛错。
 * 不引入任何第三方 npm 依赖，风格与 gitCli.ts 保持一致。
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/** Trivy 报告的单个漏洞（标准化后） */
export interface TrivyVulnerability {
  id: string;                 // VulnerabilityID，如 CVE-2024-XXXX
  severity: string;           // CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN
  pkgName?: string;           // 受影响包名
  installedVersion?: string;  // 当前安装版本
  fixedVersion?: string;      // 修复版本（可能为空="未修复"）
  title?: string;
  description?: string;
  refs?: string[];
}

/** 镜像扫描结果 */
export interface ImageScan {
  available: boolean;         // 本机是否可用 Trivy
  scannedAt?: string;         // 扫描完成时间
  summary?: { critical: number; high: number; medium: number; low: number; unknown: number };
  vulnerabilities?: TrivyVulnerability[];
  notAvailableReason?: string; // 未安装时的引导说明
}

/** 合法镜像名单字符（字母数字 _ . : / -），防 shell 注入 */
function isSafeImageChar(ch: string): boolean {
  return /[A-Za-z0-9_.:\/-]/.test(ch);
}

/**
 * 校验镜像名仅含安全字符，防止拼入 shell 命令时注入
 * @param name 镜像名
 * @throws 含非法字符时抛错
 */
export function assertSafeImageName(name: string): void {
  if (!name || name.length > 300) {
    throw new Error('无效的镜像名');
  }
  if (name[0] === '-') {
    throw new Error('镜像名不能以连字符开头');
  }
  for (const ch of name) {
    if (!isSafeImageChar(ch)) {
      throw new Error('镜像名包含非法字符');
    }
  }
}

/**
 * 探测本机是否装有可用的 trivy
 * @returns 是否可用
 */
export async function trivyAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('trivy --version', { timeout: 5000 });
    return /trivy version/i.test(stdout || '');
  } catch {
    return false;
  }
}

/** 未安装 Trivy 的引导文案 */
const NOT_AVAILABLE_REASON =
  '本机未检测到 Trivy。请先安装 Trivy 后使用镜像漏洞扫描：' +
  '1) Windows 可用 winget install AquaSecurity.Trivy 或下载二进制；' +
  '2) 源码构建见 https://aquasecurity.github.io/trivy/。安装后刷新即可扫描。';

/**
 * 执行 trivy image 扫描并解析 JSON；失败抛带 statusCode 的错误
 * @param name 镜像名（调用前需 assertSafeImageName）
 * @param timeoutMs 子进程超时，默认 180000
 * @returns 扫描结果；未装 Trivy 时 available=false
 */
export async function scanImage(name: string, timeoutMs = 180000): Promise<ImageScan> {
  assertSafeImageName(name);
  if (!(await trivyAvailable())) {
    return { available: false, notAvailableReason: NOT_AVAILABLE_REASON };
  }
  let stdout: string;
  try {
    const r = await execAsync(`trivy image --format json --no-progress "${name}"`, {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
    });
    stdout = r.stdout || '';
  } catch (err: any) {
    const stderr = err?.stderr || '';
    const stdoutPart = err?.stdout || '';
    if (/[(]?Could not find image|manifest unknown|no such image/i.test(stderr + stdoutPart)) {
      throw mkErr(400, `镜像不存在或无法访问: ${name}`);
    }
    if (err?.killed) {
      throw mkErr(408, `Trivy 扫描超时（${Math.round(timeoutMs / 1000)}s），请稍后重试`);
    }
    throw mkErr(400, `Trivy 扫描失败: ${stderr.split('\n')[0] || err?.message || err}（可先执行 trivy image <name> 排查）`);
  }

  // 解析 JSON
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('{');
    if (start >= 0) {
      try { parsed = JSON.parse(stdout.slice(start)); } catch { /* fallthrough */ }
    }
    if (!parsed) throw mkErr(400, '无法解析 Trivy 扫描结果 JSON');
  }

  const vulns: TrivyVulnerability[] = [];
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const results: any[] = Array.isArray(parsed?.Results) ? parsed.Results : [];
  for (const res of results) {
    const list: any[] = Array.isArray(res?.Vulnerabilities) ? res.Vulnerabilities : [];
    for (const v of list) {
      if (!v?.VulnerabilityID) continue;
      const sev = String(v.Severity || 'UNKNOWN').toUpperCase();
      const key = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(sev) ? sev.toLowerCase() : 'unknown') as keyof typeof counts;
      counts[key] = (counts[key] || 0) + 1;
      vulns.push({
        id: String(v.VulnerabilityID),
        severity: sev,
        pkgName: v.PkgName || res?.Target || undefined,
        installedVersion: v.InstalledVersion || undefined,
        fixedVersion: v.FixedVersion || undefined,
        title: v.Title || undefined,
        description: v.Description ? String(v.Description).slice(0, 300) : undefined,
        refs: Array.isArray(v.References) ? v.References.map(String) : undefined,
      });
    }
  }
  return { available: true, scannedAt: new Date().toISOString(), summary: counts, vulnerabilities: vulns };
}

/** 构造带 statusCode 的错误 */
function mkErr(statusCode: number, message: string): Error & { statusCode?: number } {
  const e: any = new Error(message);
  e.statusCode = statusCode;
  return e;
}
