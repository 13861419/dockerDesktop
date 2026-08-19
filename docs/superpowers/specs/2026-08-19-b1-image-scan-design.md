# B1「镜像漏洞扫描」设计文档

> 日期：2026-08-19
> 类型：功能设计（brainstorming → design）
> 状态：待用户审阅

## 1. 背景与目标

在镜像详情页新增**漏洞扫描**能力，通过封装本机 **Trivy** 二进制对镜像做 CVE 扫描，展示漏洞等级分布与明细。未装 Trivy 时优雅降级（提示安装引导），不报错。

保持项目**零第三方 npm 依赖、Windows、Node>=22、SQLite** 约束。

### 已确认决策
- 扫描器：封装本机 Trivy（`trivy image --format json <name>`），真实可靠、零 npm 依赖，与 A1 gitCli 模式一致
- 未装 Trivy 时降级引导，不自动安装

## 2. 现状分析
- 后端 [images.ts](file:///f:/ai_work/dockerDesktop/server/src/routes/images.ts) 已有 `GET /api/images/:name`（L253）、`GET /api/images/:name/layers`（L424）等，采用 `router.get('/:name/layers', ...)` + `asyncHandler`
- 前端 [imageDetail.tsx](file:///f:/ai_work/dockerDesktop/web/src/pages/imageDetail.tsx) 已有"层空间分析（Layer）" Card（L508），可紧随其后新增"漏洞扫描" Card；`get`/`post` 从 client 导入
- 权限：镜像操作多为 requireOperator；扫描属于运行操作，用 requireOperator
- A1 已建立零依赖 CLI 封装模式（[gitCli.ts](file:///f:/ai_work/dockerDesktop/server/src/gitCli.ts)：child_process/promisify exec + 探测 + 降级），B1 采用相同风格

## 3. 架构
```
镜像详情页 "立即扫描"按钮
        │ POST /api/images/:name/scan
        ▼
server: trivyCli.trivyAvailable() 探测（无则返回 {available:false + 引导文案}，HTTP 200）
        │ 可用 → trivyCli.scanImage(name)
        ▼
解析 Trivy JSON → 标准化漏洞列表（等级/包/当前版本/修复版本/标题/描述/References）
        │
        ▼ 返回 { available:true, scannedAt, summary{critical,high,medium,low}, vulnerabilities[] }
前端渲染：等级分布色块 + 漏洞明细表
```

## 4. 后端设计

### 4.1 新模块 `server/src/trivyCli.ts`（零依赖封装）
- `export interface TrivyVulnerability { id: string; severity: string; pkgName?: string; installedVersion?: string; fixedVersion?: string; title?: string; description?: string; refs?: string[] }`
- `export function trivyAvailable(): Promise<boolean>` — 探测 `trivy --version`
- `export interface ImageScan { available: boolean; scannedAt?: string; summary?: { critical: number; high: number; medium: number; low: number; unknown: number }; vulnerabilities?: TrivyVulnerability[]; notAvailableReason?: string }`
- `export async function scanImage(name: string, timeoutMs?: number): Promise<ImageScan>` — 执行 `trivy image --format json --no-progress <name>`（子进程），解析输出；未装返回 `{available:false, notAvailableReason}`；超时/失败抛可读错误
- 解析逻辑：遍历 Trivy JSON 的 `Results[].Vulnerabilities[]`，映射字段、归类 severity（CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN）
- 子进程超时默认 180s，超时 kill 并抛错
- image name 需做参数校验（禁止 shell 元字符），避免注入（复用 A1 的校验思路）

### 4.2 新增端点（images.ts）
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `POST` | `/api/images/:name/scan` | requireOperator | 调用 trivyCli.scanImage，返回扫描结果 |

- `available=false` 时 HTTP 200（非错误，避免前端误判）
- Trivy 未装时 notAvailableReason 含安装引导文案

## 5. 数据模型
**不落库**（YAGNI）。扫描为用户主动一次性行为，结果实时返回，不引入 DB 表与缓存。

## 6. 前端设计（imageDetail.tsx）
在"层空间分析" Card 之后新增 **"漏洞扫描" Card**：
- "立即扫描"按钮（受 `canOperate` 权限控制，loading 态）
- 点击 `POST /api/images/:name/scan`
- 渲染：
  - `available=false` → 引导提示条（含安装说明）
  - 扫描完成 → **等级分布色块**（严重/高/中/低/未知 计数）+ **漏洞明细表**（CVE ID 外链、等级徽章、依赖包、当前版本→修复版本、简介）

## 7. 错误处理
- Trivy 未装 → `{available:false, notAvailableReason}`（200 引导）
- 扫描失败（镜像不存在、Trivy DB 未初始化、超时）→ 抛可读错误（400），前端 toast
- 子进程超时保护 180s，超时 kill
- image name 参数校验，防命令注入

## 8. 测试与验证
- `server/test` 新增 trivy 测试：`trivyAvailable()` 未装时返回 false；JSON 解析逻辑（用样例 Trivy JSON 断言标准化字段正确、severity 归类正确）
- 后端类型检查、`npm test` 全绿
- 端到端：未装 Trivy 时点扫描返回 `available:false` 引导（本机验证降级路径）
- 前端 `tsc -b` 与 `vite build`

## 9. 范围边界（不做）
- 不做健康体检深度扫描集成（后续可加）
- 不做扫描结果持久化/历史
- 不自动安装 Trivy
- 仅默认 OS + 语言依赖扫描（`trivy image`），不做 --license / --misconfig 等高级模式
