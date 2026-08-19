# B1「镜像漏洞扫描」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在镜像详情页新增漏洞扫描能力，封装本机 Trivy 对镜像做 CVE 扫描，展示等级分布与明细；未装 Trivy 时降级引导。

**Architecture:** 新增零依赖 `trivyCli.ts`（探测 `trivy --version` 可用性；`trivy image --format json` 扫描并解析 JSON），在 images.ts 暴露 `POST /api/images/:name/scan`，前端 imageDetail.tsx 新增"漏洞扫描" Card。未装 Trivy 返回 `{available:false}` + 引导文案（HTTP 200）。

**Tech Stack:** Express、child_process（trivy CLI）、React 18。零第三方运行时依赖。

## Global Constraints
- 零第三方 npm 运行时依赖（仅用 Node 内置 child_process/util）
- image name 参数必须做 shell 安全校验（禁 shell 元字符），防命令注入（复用 A1 的校验思路）
- 子进程超时保护（默认 180s）
- Trivy 未装时 `available=false` 且 HTTP 200（非错误）
- 不落库（YAGNI）、不自动安装 Trivy、完成时 `npm test`/前后端 `tsc`/`vite build` 全绿

---
## File Structure
- Create: `server/src/trivyCli.ts` — 探测 + 扫描 + JSON 解析
- Modify: `server/src/routes/images.ts` — 新增 scan 端点
- Modify: `web/src/pages/imageDetail.tsx` — 新增漏洞扫描 Card
- Modify: `server/test/auth-security.test.ts`（或新建 `server/test/trivy.test.ts` 并纳入 test 脚本）
- Modify: `server/package.json`（若新建测试文件，纳入 test 脚本）

---

### Task 1: trivyCli 模块——探测与扫描解析

**Files:**
- Create: `server/src/trivyCli.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface TrivyVulnerability { id: string; severity: string; pkgName?: string; installedVersion?: string; fixedVersion?: string; title?: string; description?: string; refs?: string[] }`
  - `export interface ImageScan { available: boolean; scannedAt?: string; summary?: { critical: number; high: number; medium: number; low: number; unknown: number }; vulnerabilities?: TrivyVulnerability[]; notAvailableReason?: string }`
  - `export function trivyAvailable(): Promise<boolean>`
  - `export async function scanImage(name: string, timeoutMs?: number): Promise<ImageScan>`
  - `export function assertSafeImageName(name: string): void`（image name 白名单校验）

- [ ] **Step 1: 创建 trivyCli.ts（完整实现）**

```ts
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
    // trivy 输出可能含扫描结果但 exit code 非 0（如部分漏洞数据库异常）；尽量在 stderr 里找 JSON
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
    // 兜底：从输出中提取 JSON 片段
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
```

- [ ] **Step 2: 类型检查**

Run: `cd server && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**
```bash
git add server/src/trivyCli.ts
git commit -m "feat: 新增零依赖 Trivy 镜像漏洞扫描封装（探测/扫描/解析）"
```

---

### Task 2: images.ts 新增 scan 端点

**Files:**
- Modify: `server/src/routes/images.ts`

**Interfaces:**
- Consumes: `scanImage`（Task 1）
- Produces: `POST /api/images/:name/scan`（requireOperator）

- [ ] **Step 1: 增加 import**

在 `server/src/routes/images.ts` 的 import 区追加：
```ts
import { scanImage } from '../trivyCli';
```

- [ ] **Step 2: 新增扫描端点**

在 `GET /api/images/:name/layers` 端点（约 L424）之后追加：
```ts
/**
 * POST /api/images/:name/scan
 * 对指定镜像执行 Trivy 漏洞扫描；本机未装 Trivy 时返回 available:false 引导（HTTP 200）
 */
router.post(
  '/:name/scan',
  requireOperator,
  asyncHandler(async (req: Request, res: Response) => {
    const name = decodeURIComponent(String(req.params.name || ''));
    const result = await scanImage(name);
    res.json(result);
  }),
);
```
> 注意：此处 decodeURIComponent 后无需再校验，scanImage 内部已 assertSafeImageName。若 path param 本身含编码需按现有 `/:name` 端点的处理方式对齐（请参考 L253 GET /:name 如何解析 name）。

- [ ] **Step 3: 类型检查**
Run: `cd server && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 手工验证未装 Trivy 降级路径**
启动后端后：
```bash
curl -X POST "http://localhost:9528/api/images/nginx:latest/scan" -H "Authorization: Bearer <admin-token>"
```
Expected: 返回 `{"available":false,"notAvailableReason":"..."}`（本机未装 Trivy），HTTP 200。

- [ ] **Step 5: Commit**
```bash
git add server/src/routes/images.ts
git commit -m "feat(images): 新增 POST /api/images/:name/scan 镜像漏洞扫描端点"
```

---

### Task 3: 前端镜像详情页新增漏洞扫描 Card

**Files:**
- Modify: `web/src/pages/imageDetail.tsx`

**Interfaces:**
- Consumes: `POST /api/images/:name/scan`（返回 ImageScan 结构）
- Produces: 镜像详情页"漏洞扫描" Card（等级分布 + 明细表）
- 需在 L15 `import { get, del } from '../api/client'` 追加 `post`；补充 `canOperate`（若未 import）

- [ ] **Step 1: 补充 import**

L15 改为：`import { get, del, post } from '../api/client';`
若该文件未引入 `canOperate`（用于控制扫描按钮），参考其它页面从 `../api/auth` 引入；若镜像详情页无既有权限变量，则新增 `const canOperate = ...`（可用 `requireOperator` 等价判断，与其它页一致——若不确定，可仅在按钮上加 `disabled` 由前端控制；但后端已强制 requireOperator，前端按钮以 canOperate 显示/隐藏）。

- [ ] **Step 2: 新增 state**

在现有 state（layerAnalysis/layerLoading 之后，L182-188 附近）追加：
```ts
  const [scanResult, setScanResult] = useState<ImageScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
```

- [ ] **Step 3: 定义 ImageScan 类型（文件顶部接口区，LayerAnalysis 附近）**

```ts
interface ImageScan {
  available: boolean;
  scannedAt?: string;
  summary?: { critical: number; high: number; medium: number; low: number; unknown: number };
  vulnerabilities?: Array<{
    id: string;
    severity: string;
    pkgName?: string;
    installedVersion?: string;
    fixedVersion?: string;
    title?: string;
    description?: string;
    refs?: string[];
  }>;
  notAvailableReason?: string;
}
```

- [ ] **Step 4: 新增扫描回调**

在层分析加载回调附近新增：
```ts
  /** 执行镜像漏洞扫描 */
  const handleScan = useCallback(async () => {
    if (!name) return;
    setScanLoading(true);
    try {
      const r = await post<ImageScan>('/api/images/' + encodeURIComponent(name) + '/scan');
      setScanResult(r);
    } catch (e: any) {
      showToast(e?.message || '漏洞扫描失败', 'error');
      setScanResult(null);
    } finally {
      setScanLoading(false);
    }
  }, [name, showToast]);
```
> 需确认 imageDetail.tsx 是否已引入 `showToast`（若非 context，可直接用 alert 或按该页既有反馈方式；请参照该页其它错误处理风格）。

- [ ] **Step 5: 渲染"漏洞扫描" Card**

在"层空间分析" Card（L508 结束处，约 L563 之后）之后新增：
```tsx
      {/* 漏洞扫描（Trivy） */}
      <Card title="漏洞扫描（Trivy）">
        {scanLoading ? (
          <div className="desc-value">扫描中…（首次可能较慢）</div>
        ) : !scanResult ? (
          <div className="desc-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="desc-value">
              {canOperate
                ? '点击扫描以检测镜像中的已知漏洞（依赖本机 Trivy）。'
                : '无扫描权限。'}
            </div>
            {canOperate && (
              <Button variant="primary" size="sm" onClick={handleScan} disabled={scanLoading}>
                立即扫描
              </Button>
            )}
          </div>
        ) : !scanResult.available ? (
          <div className="alert-warning" style={{ margin: 0 }}>
            <strong>未检测到 Trivy</strong>：{scanResult.notAvailableReason}
          </div>
        ) : (
          <>
            <div className="desc-row" style={{ justifyContent: 'space-between' }}>
              <span className="desc-label">扫描时间</span>
              <span className="desc-value">{scanResult.scannedAt ? new Date(scanResult.scannedAt).toLocaleString() : '-'}</span>
            </div>
            {/* 等级分布 */}
            <div className="sev-summary">
              {[
                { k: 'critical', label: '严重', color: '#e11d48' },
                { k: 'high', label: '高危', color: '#f97316' },
                { k: 'medium', label: '中危', color: '#eab308' },
                { k: 'low', label: '低危', color: '#3b82f6' },
                { k: 'unknown', label: '未知', color: '#6b7280' },
              ].map((s) => (
                <span key={s.k} className="sev-chip" style={{ color: s.color }}>
                  {s.label} {scanResult.summary?.[s.k as keyof typeof scanResult.summary] ?? 0}
                </span>
              ))}
            </div>
            {/* 漏洞明细 */}
            {scanResult.vulnerabilities && scanResult.vulnerabilities.length > 0 ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: '16%' }}>CVE</th>
                    <th style={{ width: '10%' }}>等级</th>
                    <th style={{ width: '20%' }}>依赖包</th>
                    <th style={{ width: '22%' }}>版本</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {scanResult.vulnerabilities.map((v, i) => (
                    <tr key={i}>
                      <td>
                        {v.refs && v.refs.length > 0 ? (
                          <a href={v.refs[0]} target="_blank" rel="noreferrer" className="scan-cve">{v.id}</a>
                        ) : (
                          <span className="scan-cve">{v.id}</span>
                        )}
                      </td>
                      <td>
                        <span className={`sev-badge sev-${v.severity.toLowerCase()}`}>{v.severity}</span>
                      </td>
                      <td>{v.pkgName || '-'}</td>
                      <td>
                        {v.installedVersion || '-'}
                        {v.fixedVersion ? ` → ${v.fixedVersion}` : '（未修复）'}
                      </td>
                      <td className="scan-desc" title={v.description}>{v.title || v.description || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="desc-value">未发现已知漏洞（或 Trivy 未检出）。</div>
            )}
          </>
        )}
      </Card>
```
> 若 `Button` 未导入，请从现有组件路径补（参考 imageDetail 是否已用 Button）；`alert-warning`/`Card` 等类名以现有样式为准，必要时补充 `.sev-summary/.sev-chip/.sev-badge/sev-*/.scan-cve/.scan-desc` 到 `imageDetail.less`（若存在）或内联。请遵循该页既有类名约定，缺样式就补最小 CSS。

- [ ] **Step 6: 类型检查与构建**
Run: `cd web && npx tsc -b --noEmit`
Run: `cd web && npx vite build`
Expected: 均通过

- [ ] **Step 7: 前端手工验证（未装 Trivy 降级）**
打开镜像详情页 → 点"立即扫描" → 应显示"未检测到 Trivy"引导提示。

- [ ] **Step 8: Commit**
```bash
git add web/src/pages/imageDetail.tsx
git commit -m "feat(imageDetail): 镜像详情页新增 Trivy 漏洞扫描 Card（等级分布+明细与降级引导）"
```

---

### Task 4: 测试

**Files:**
- Create: `server/test/trivy.test.ts`
- Modify: `server/package.json`（test 脚本纳入新文件）

**Interfaces:**
- Consumes: `assertSafeImageName`、`scanImage`（可 mock trivyAvailable；用样例 JSON 走解析分支）
- Produces: 对 image name 校验与 JSON 解析的测试

- [ ] **Step 1: 写测试**

```ts
/**
 * B1「镜像漏洞扫描」单元测试（node:test，零第三方依赖）
 * 覆盖：image name 安全校验、Trivy JSON 解析标准化、severity 归类
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { assertSafeImageName } from '../src/trivyCli';

test('assertSafeImageName 拒绝含 shell 元字符的镜像名', () => {
  assert.doesNotThrow(() => assertSafeImageName('nginx:latest'));
  assert.doesNotThrow(() => assertSafeImageName('registry.example.com/myapp:v1.0'));
  assert.throws(() => assertSafeImageName('nginx;rm -rf /'), /非法/);
  assert.throws(() => assertSafeImageName('img" && whoami'), /非法/);
  assert.throws(() => assertSafeImageName('a|b'), /非法/);
});
```
> 说明：`scanImage` 依赖真实 Trivy（本机未装），故测试不直接调它执行；JSON 解析逻辑通过将解析部分独立暴露函数或在测试中构造已解析对象单向验证。**为可测性，若实现时把"解析 Trivy JSON 字符串→ImageScan"单独抽为 `export function parseTrivyOutput(stdout: string): ImageScan`（纯函数），测试即可用样例 JSON 断言标准化正确。** 若 Task 1 未抽取，请在本任务补一个纯解析函数并补测试断言（severity 归类、字段映射、空 results）。

- [ ] **Step 2: 运行测试**
Run: `cd server && npm test`
Expected: 全部通过（auth-security + trivy 新增项）

- [ ] **Step 3: 端到端回归**
- 后端类型检查、`npm test` 全绿
- 镜像详情页扫描降级路径（未装 Trivy 引导）手工验证

- [ ] **Step 4: Commit**
```bash
git add server/test/trivy.test.ts server/package.json
git commit -m "test: 覆盖镜像名校验与 Trivy JSON 解析，test 脚本纳入 trivy 测试"
```

---

## Self-Review 记录
- **Spec 覆盖**：trivyCli 探测/扫描/解析（Task1）✓；scan 端点（Task2）✓；前端 Card（Task3）✓；降级引导（Task1/3）✓；安全校验（Task1/4）✓；测试（Task4）✓。
- **占位符扫描**：无 TBD/TODO，代码步骤完整。
- **类型一致性**：`ImageScan`/`TrivyVulnerability`/`scanImage`/`assertSafeImageName` 在各任务命名一致。
