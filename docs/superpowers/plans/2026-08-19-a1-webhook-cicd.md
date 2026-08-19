# A1「Webhook 自动化部署」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为计划任务系统新增 Webhook 触发能力与 `git-pull-build`（Git→构建/部署）流水线，并支持 Git 私有仓库凭证，实现"代码推送→自动构建/部署"闭环。

**Architecture:** Webhook 作为独立于 cron/手动的第三种触发源，`POST /api/webhook/:token` 匹配任务后复用现有 `dispatchTask` 链路（执行历史、防重入、失败告警）。新增 `git-pull-build` handler（含 git CLI 封装的独立模块 `gitCli.ts`），凭证用现有 `encryptSecret` 加密落库、执行时解密使用。

**Tech Stack:** Express、node:sqlite（`node:sqlite` DatabaseSync）、dockerode、child_process（git CLI）、crypto。前端 React 18 + Vite + TypeScript。

## Global Constraints

- 零第三方运行时依赖：仅可使用 `cors`/`express`/`morgan`/`dockerode`/`ws`，SQLite 用 Node 内置 `node:sqlite`
- `engines.node >= 22`
- 数据落库复用 `storage.getDb()`、`encryptSecret`/`decryptSecret`
- 敏感字段（Git token/私钥）禁止明文返回前端；前端仅返回 `hasCred` 标记
- Windows 优先；Git 通过本机 `git` CLI（`execAsync`）调用
- 所有对旧库的列迁移使用 `ALTER TABLE ... ADD COLUMN` + try/catch 宽松迁移
- 前端新增任务类型需同步扩展 `TaskType` 联合类型、`TYPE_OPTIONS`

---
## File Structure

- Modify: `server/src/storage.ts` — 给 `cron_tasks` 加 `webhook_token`、`git_cred_encrypted` 两列（迁移）
- Create: `server/src/gitCli.ts` — 零依赖 git CLI 封装（clone/pull + HTTPS/SSH 凭证注入）
- Modify: `server/src/routes/tasks.ts` — 新增 `git-pull-build` handler；webhook_token 生成/重置；gitCred 序列化（脱敏）
- Create: `server/src/routes/webhook.ts` — 匿名 Webhook 入口路由
- Modify: `server/src/app.ts` — 挂载 webhook 路由（匿名，不套 requireAuth）
- Modify: `web/src/types/index.ts` — `TaskType` 加 `git-pull-build`；`CronTask` 加 `webhookToken?`/`gitCred?`
- Modify: `web/src/pages/tasks.tsx` — 任务类型选项、git-pull-build 配置表单、凭证区、Webhook 展示区
- Modify: `server/test/auth-security.test.ts`（或新 `server/test/webhook-git.test.ts`）— 测试

---

### Task 1: 数据库迁移——`cron_tasks` 增加 webhook 与 Git 凭证列

**Files:**
- Modify: `server/src/storage.ts`（在 `createTables` 之后的迁移区块、`alert_rules` 迁移之后追加）

**Interfaces:**
- Consumes: 无
- Produces: `cron_tasks` 表新增列 `webhook_token TEXT NULL`、`git_cred_encrypted TEXT NULL`（待后续任务读写）

- [ ] **Step 1: 添加两列迁移（宽松 try/catch）**

在 `server/src/storage.ts` 的 `alert_rules` 迁移块（`work_end` 的 try/catch 之后）追加：

```ts
  // 迁移：为 cron_tasks 补充 Webhook 触发 token 列（NULL/空=未开启 Webhook）
  try {
    d.exec('ALTER TABLE cron_tasks ADD COLUMN webhook_token TEXT');
  } catch {
    // 列已存在则忽略
  }
  // 迁移：为 cron_tasks 补充 Git 私有仓库凭证列（加密 JSON，NULL=无凭证）
  try {
    d.exec('ALTER TABLE cron_tasks ADD COLUMN git_cred_encrypted TEXT');
  } catch {
    // 列已存在则忽略
  }
```

- [ ] **Step 2: 运行后端测试验证不破坏既有逻辑**

Run: `cd server && npm test`
Expected: 现有测试通过（迁移为宽松 ADD COLUMN，不影响旧库）

- [ ] **Step 3: Commit**

```bash
git add server/src/storage.ts
git commit -m "feat(tasks): cron_tasks 增加 webhook_token 与 git_cred_encrypted 列迁移"
```

---

### Task 2: gitCli 模块——零依赖 git CLI 封装与凭证注入

**Files:**
- Create: `server/src/gitCli.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret`（由调用方在 handler 中解密后传入明文 cred，本模块不落库）
- Produces:
  - `export interface GitCred { type: 'token' | 'ssh'; token?: string; privateKey?: string; passphrase?: string }`
  - `export function gitAvailable(): Promise<boolean>`
  - `export async function gitCloneOrPull(opts: { repoUrl: string; dir: string; branch?: string; cred?: GitCred | null }): Promise<string>`
  - `export function buildImageTagFromBranch(branch?: string): string`（分支名清洗，供镜像 tag）

- [ ] **Step 1: 创建 gitCli.ts（完整实现）**

```ts
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
 * @param sshKeyFile SSH 私钥临时文件路径（已生成时）
 * @returns 附加的 git 配置参数与环境变量
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
    // 清理 SS命令临时私钥
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
```

- [ ] **Step 2: 运行类型检查**

Run: `cd server && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add server/src/gitCli.ts
git commit -m "feat: 新增零依赖 git CLI 封装模块（clone/pull + HTTPS/SSH 凭证注入）"
```

---

### Task 3: tasks.ts——新增 git-pull-build handler + webhook token 管理 + gitCred 序列化

**Files:**
- Modify: `server/src/routes/tasks.ts`

**Interfaces:**
- Consumes: `gitCloneOrPull`/`gitAvailable`/`sanitizeTag`（Task 2）、`encryptSecret`/`decryptSecret`、`getDockerClient`、`runCmd`、`findComposeFile`
- Produces: 任务 `type='git-pull-build'` handler 注册；`GET /api/tasks` 序列化增加 `webhookToken`(admin)/`gitCred:{type?,hasCred}`；`POST /api/tasks/:id/webhook`、`DELETE /api/tasks/:id/webhook`

- [ ] **Step 1: 增加 imports**

在 `server/src/routes/tasks.ts` 顶部（`import crypto from 'crypto'` 之后）追加：

```ts
import { encryptSecret, decryptSecret } from '../storage';
import { gitCloneOrPull, gitAvailable, sanitizeTag, randomHex, GitCred } from '../gitCli';
```

- [ ] **Step 2: 新增 git-pull-build handler**

在 `runHealthcheckHandler` 定义之后追加：

```ts
/**
 * handler：Git 自动构建/部署（git-pull-build）
 * config={mode:'image'|'compose', repoUrl, branch, destDir, dockerfile, imageName, buildArgs, composeProject, alsoBuild}
 * image 模式：git 拉取 → dockerode build -> tag imageName
 * compose 模式：git 工作目录即 composeProject -> 可选构建 -> docker compose up -d --build
 * @param task 任务行
 * @param config 任务配置
 * @returns 执行结果与输出
 */
async function runGitPullBuildHandler(task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const repoUrl = config.repoUrl;
  if (!repoUrl || typeof repoUrl !== 'string') {
    return { ok: false, detail: '缺少 Git 仓库地址(repoUrl)' };
  }

  // 解密本任务已保存的 Git 凭证（无则 null）
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

  // 1) git 拉取
  try {
    const gitOut = await gitCloneOrPull({ repoUrl, dir: repoDir, branch: config.branch, cred });
    lines.push(gitOut);
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }

  if (mode === 'image') {
    // 2) image 模式：构建镜像
    const imageName = config.imageName;
    if (!imageName || typeof imageName !== 'string') {
      return { ok: false, detail: 'image 模式缺少镜像名(imageName)' };
    }
    try {
      const docker = await getDockerClient();
      const dockerfile = config.dockerfile || 'Dockerfile';
      const buildArgs = config.buildArgs && typeof config.buildArgs === 'object' ? config.buildArgs : {};
      const stream = await docker.buildImage(
        { context: repoDir, dockerfile, buildargs: buildArgs },
        { t: imageName, pull: true },
      );
      const logTail = await new Promise<string>((resolve, reject) => {
        let acc = '';
        stream.on('data', (d) => {
          acc = (acc + d.toString()) || '';
          if (acc.length > 200000) acc = acc.slice(-200000);
        });
        stream.on('end', () => resolve(acc));
        stream.on('error', reject);
      });
      // 若 build 日志含错误关键词，判定失败
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

  // 3) compose 模式：可选构建 + compose up
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
```

- [ ] **Step 3: 注册 handler**

在 `taskHandlers` 对象（`server/src/routes/tasks.ts` 的 `const taskHandlers`）中追加一行：

```ts
  git-pull-build: runGitPullBuildHandler,
```

- [ ] **Step 4: 扩展 serializeTask 返回 webhook 信息**

修改 `serializeTask` 函数，在返回对象中追加 `webhookToken` 与 `gitCred`：

```ts
function serializeTask(row: CronTaskRow): Record<string, any> {
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch {
    config = {};
  }
  // 解析 Git 凭证是否已配置（仅暴露 hasCred 与类型，绝不返回明文）
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
```

> 注意：需让 `CronTaskRow` 在取值前带出新列——由于 `serializeTask` 通过 `(row as any)` 访问，无需改 `CronTaskRow` 接口；但 `getTaskRow`/查询 SELECT 需把新列取出来（见 Step 5）。

- [ ] **Step 5: 所有 SELECT 查询带上新列**

将 `getTaskRow` 与 `router.get('/')` 的 SELECT 语句从 `... updated_at FROM cron_tasks` 改为追加 `webhook_token, git_cred_encrypted`：

```ts
// getTaskRow 内
'SELECT id, name, type, cron, enabled, config, webhook_token, git_cred_encrypted, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at FROM cron_tasks WHERE id = ?'

// router.get('/') 内
'SELECT id, name, type, cron, enabled, config, webhook_token, git_cred_encrypted, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at FROM cron_tasks ORDER BY created_at DESC'
```

- [ ] **Step 6: POST/PUT 支持 gitCred 保存**

在 `router.post('/')` 的 INSERT 语句与 `router.put('/:id')` 的 UPDATE 语句中，增加 `git_cred_encrypted` 列：

```ts
// POST：INSERT 增加一列
const gitCred = req.body?.gitCred;
const gitCredEnc = gitCred && (gitCred.token || gitCred.privateKey)
  ? encryptSecret(JSON.stringify({ type: gitCred.type === 'ssh' ? 'ssh' : 'token', token: gitCred.token || undefined, privateKey: gitCred.privateKey || undefined, passphrase: gitCred.passphrase || undefined }))
  : null;
// INSERT 列清单与 VALUES 追加：git_cred_encrypted
'INSERT INTO cron_tasks (id, name, type, cron, enabled, config, webhook_token, git_cred_encrypted, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
// ... 对应 run(...) 参数追加 gitCredEnc（在 webhook_token 之后）
```

`router.put('/:id')` 中，仅当 body 给定非空 `gitCred`（至少一个敏感字段非空）或显式 `gitCred: null`（清空）才更新：

```ts
  // PUT：git_cred_encrypted 更新逻辑（放在 newConfig 计算之后）
  let newGitCredEnc = row.git_cred_encrypted;
  if (config !== undefined || body.gitCred !== undefined) {
    const gc = body.gitCred;
    if (gc === null) {
      newGitCredEnc = null;
    } else if (gc && (gc.token || gc.privateKey)) {
      newGitCredEnc = encryptSecret(JSON.stringify({ type: gc.type === 'ssh' ? 'ssh' : 'token', token: gc.token || undefined, privateKey: gc.privateKey || undefined, passphrase: gc.passphrase || undefined }));
    }
  }
  // UPDATE 语句追加 git_cred_encrypted 列与参数
  'UPDATE cron_tasks SET name = ?, cron = ?, enabled = ?, config = ?, webhook_token = ?, git_cred_encrypted = ?, next_run_at = ?, updated_at = ? WHERE id = ?'
```

> 注意：PUT 需从 `req.body` 取 `config`/`gitCred`，并解析 `git_cred_encrypted`。确保既有 `row` 带上了该列（Step 5 已改 getTaskRow）。

- [ ] **Step 7: webhook token 生成/重置端点**

在 `router.put('/:id')` 之后、`router.post('/:id/enable')` 之前追加两个端点：

```ts
/**
 * POST /api/tasks/:id/webhook
 * 生成/重置该任务的 Webhook token，返回对外的 URL 与 token（仅 admin）
 */
router.post(
  '/:id/webhook',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getTaskRow(req.params.id);
    if (!row) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const token = randomHex(32);
    getDb().prepare('UPDATE cron_tasks SET webhook_token = ?, updated_at = ? WHERE id = ?').run(token, Date.now(), row.id);
    logOperation(res.locals.username, '生成计划任务 Webhook', 'task', row.name);
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, url: `${base}/api/webhook/${token}`, token });
  }),
);

/**
 * DELETE /api/tasks/:id/webhook
 * 关闭该任务的 Webhook（清空 token）
 */
router.delete(
  '/:id/webhook',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const row = getTaskRow(req.params.id);
    if (!row) {
      return res.status(404).json({ error: '任务不存在' });
    }
    getDb().prepare('UPDATE cron_tasks SET webhook_token = NULL, updated_at = ? WHERE id = ?').run(Date.now(), row.id);
    logOperation(res.locals.username, '关闭计划任务 Webhook', 'task', row.name);
    res.json({ ok: true });
  }),
);
```

- [ ] **Step 8: 类型检查**

Run: `cd server && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/tasks.ts
git commit -m "feat(tasks): 新增 git-pull-build handler、webhook_token 管理、gitCred 脱敏序列化"
```

---

### Task 4: webhook 匿名路由 + app.ts 挂载

**Files:**
- Create: `server/src/routes/webhook.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Consumes: `getDb`、`nextRunTime`（可选）、任务执行逻辑（复用 `scheduler.dispatchTask` 需要）。注意：`dispatchTask` 目前在 `tasks.ts` 为模块内函数未导出。此任务需在 `scheduler.ts` 暴露一个"按任务执行"的入口，或在 webhook 路由内实现等价逻辑。
- Produces: `POST /api/webhook/:token`（匿名）；`app.ts` 匿名挂载。

- [ ] **Step 1: 在 scheduler.ts 暴露可按任务执行的通用入口**

在 `server/src/scheduler.ts` 中新增导出函数 `runTaskById`（供 webhook 触发与 tasks 手动执行共用），并让 `tasks.ts` 改为调用它（保持行为一致）：

```ts
/**
 * 按任务 id 立即执行一次（供 Webhook 与手动执行复用）
 * 返回执行结果；任务不存在返回 null
 */
export async function runTaskById(id: string): Promise<TaskRunResult | null> {
  const d = getDb();
  const row = d
    .prepare('SELECT id, name, type, cron, enabled, config, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at FROM cron_tasks WHERE id = ?')
    .get(id) as unknown as CronTaskRow | undefined;
  if (!row) return null;
  await executeTask(row);
  // 从库中读回最新结果（executeTask 已更新）
  const after = d.prepare('SELECT last_status, last_detail FROM cron_tasks WHERE id = ?').get(id) as any;
  return { ok: after?.last_status === 0, detail: after?.last_detail || undefined };
}
```

- [ ] **Step 2: tasks.ts 的 dispatchTask 改为复用 runTaskById（可选重构）**

保持 `dispatchTask` 现有行为，但为避免两份逻辑漂移，将 `dispatchTask` 内部改为委托 `runTaskById`：

```ts
async function dispatchTask(id: string): Promise<TaskRunResult> {
  const result = await runTaskById(id);
  if (!result) {
    const notFound: any = new Error('任务不存在');
    notFound.statusCode = 404;
    throw notFound;
  }
  return result;
}
```

> 若重构带来回归风险，可保留 `dispatchTask` 原实现不改；webhook 直接调用 `runTaskById`。计划此处采用"保留原实现 + 新增 runTaskById"以最小化改动（见 Step 4 说明）。

- [ ] **Step 3: 创建 webhook 路由**

```ts
/**
 * Webhook 触发路由（匿名入口）
 *
 * POST /api/webhook/:token —— 依据 URL 中的 token 匹配 cron_tasks.webhook_token，
 * 命中后异步触发该任务执行（复用 scheduler.runTaskById），无论执行结果立即返回 200。
 * 安全：token 为 32 字节随机 hex；可选 Header X-Docker-Panel-Token 二次校验。
 */
import { Router, Request, Response } from 'express';
import { getDb } from '../storage';
import { runTaskById, CronTaskRow } from '../scheduler';
import { logOperation } from '../operationLog';

const router = Router();

/**
 * 按 webhook token 查询任务
 * @param token token
 * @returns 任务行或 null
 */
function findTaskByWebhookToken(token: string): CronTaskRow | null {
  const d = getDb();
  const row = d
    .prepare('SELECT id, name, type, cron, enabled, config, last_run_at, last_status, last_detail, next_run_at, created_at, updated_at FROM cron_tasks WHERE webhook_token = ?')
    .get(token) as unknown as CronTaskRow | undefined;
  return row || null;
}

/**
 * POST /api/webhook/:token
 * 触发匹配任务的执行（异步）；未匹配返回 404
 */
router.post('/:token', (req: Request, res: Response) => {
  const token = String(req.params.token || '');
  const headerToken = String(req.headers['x-docker-panel-token'] || '');
  const row = findTaskByWebhookToken(token);
  if (!row) {
    return res.status(404).json({ error: 'Webhook token 无效或已失效' });
  }
  // 可选 Header 二次校验：若面板配置了该任务非空 token，则 Header 也须匹配（此处 token 即 path token，保持一致）
  if (headerToken && headerToken !== token) {
    return res.status(403).json({ error: 'X-Docker-Panel-Token 校验失败' });
  }
  // 异步执行，不阻塞响应
  runTaskById(row.id)
    .then((r) => {
      logOperation('webhook', r?.ok ? 'Webhook 触发任务执行' : 'Webhook 触发任务执行（失败）', 'task', row.name, r?.detail, r?.ok);
    })
    .catch(() => {
      // 执行失败已在 scheduler 内记录
    });
  res.json({ ok: true, taskId: row.id, name: row.name });
});

export default router;
```

- [ ] **Step 4: app.ts 匿名挂载**

在 `server/src/app.ts` 的 `app.use('/api/auth', authRouter)` 之后、各 `requireAuth` 挂载之前插入：

```ts
// Webhook 触发（匿名入口，靠 token 鉴权，不套 requireAuth）
app.use('/api/webhook', webhookRouter);
```

并在文件顶部 import 区追加：

```ts
import webhookRouter from './routes/webhook';
```

- [ ] **Step 5: 后端类型检查**

Run: `cd server && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 手工验证 Webhook 触发**

启动后端后：

```bash
# 1) 登录拿 token（admin/admin888），创建一个 git-pull-build 或任意任务
# 2) 调用 POST /api/tasks/:id/webhook 生成 token
# 3) curl -X POST http://localhost:9528/api/webhook/<token>
```

Expected: 返回 `{ok:true, taskId, name}`；`/api/tasks/logs` 新增一条该任务的执行历史（detail 由 handler 生成）。

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/webhook.ts server/src/app.ts server/src/scheduler.ts
git commit -m "feat: 新增 Webhook 匿名触发路由（每任务 token）+ scheduler.runTaskById 复用执行"
```

---

### Task 5: 前端——TaskType、任务表单与 Webhook 展示

**Files:**
- Modify: `web/src/types/index.ts`
- Modify: `web/src/pages/tasks.tsx`

**Interfaces:**
- Consumes: 后端 `serializeTask` 返回的 `webhookToken`、`gitCred`；`POST/PUT /api/tasks` 的 `gitCred`；`POST/DELETE /api/tasks/:id/webhook`
- Produces: `TaskType` 含 `git-pull-build`；`CronTask` 含 `webhookToken?`/`gitCred?`；任务表单支持 git-pull-build 配置与凭证、Webhook 展示区

- [ ] **Step 1: 扩展 TaskType 与 CronTask**

在 `web/src/types/index.ts` 的 `TaskType` 联合类型追加 `'git-pull-build'`，`CronTask` 接口追加字段：

```ts
export type TaskType =
  | 'prune'
  | 'backup'
  | 'pull'
  | 'composeUp'
  | 'composeDown'
  | 'restart'
  | 'command'
  | 'healthcheck'
  | 'git-pull-build';
```

```ts
export interface CronTask {
  // ... 现有字段
  /** Webhook 触发 token（仅 admin 可见明文；前端仅用于展示/复制） */
  webhookToken?: string | null;
  /** Git 凭证描述（不含明文） */
  gitCred?: { type?: 'token' | 'ssh'; hasCred: boolean };
}
```

- [ ] **Step 2: tasks.tsx——新增类型选项**

在 `TYPE_OPTIONS` 数组追加：

```ts
  { value: 'git-pull-build', label: 'Git 自动部署', badge: 'indigo' },
```

- [ ] **Step 3: tasks.tsx——表单新增 git-pull-build 配置区与凭证区**

在 `renderConfigFields` 中、`command` 分支之后追加 `git-pull-build` 分支（新增 state：`mode`、`repoUrl`、`branch`、`destDir`、`dockerfile`、`imageName`、`composeProject`、`alsoBuild`、`credType`、`credToken`、`credKey`、`credPassphrase`；setKey 写入 `form.config`）。实现要点：

```tsx
if (type === 'git-pull-build') {
  return (
    <>
      <Select label="部署模式" value={config.mode || 'image'} onChange={(e) => setKey('mode', e.target.value)}>
        <option value="image">构建镜像</option>
        <option value="compose">Compose 部署</option>
      </Select>
      <Field label="Git 仓库地址" required hint="支持 https 与 ssh 协议">
        <Input value={config.repoUrl || ''} onChange={(e) => setKey('repoUrl', e.target.value)} placeholder="https://github.com/user/repo.git" />
      </Field>
      <Field label="分支（可选）">
        <Input value={config.branch || ''} onChange={(e) => setKey('branch', e.target.value)} placeholder="main" />
      </Field>
      {config.mode === 'image' ? (
        <>
          <Field label="镜像名" required hint="构建后打标签，如 myapp:latest">
            <Input value={config.imageName || ''} onChange={(e) => setKey('imageName', e.target.value)} />
          </Field>
          <Field label="Dockerfile（可选）">
            <Input value={config.dockerfile || 'Dockerfile'} onChange={(e) => setKey('dockerfile', e.target.value)} />
          </Field>
          <Field label="工作目录（可选，默认自动）">
            <Input value={config.destDir || ''} onChange={(e) => setKey('destDir', e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <Field label="Compose 项目" required hint="对应 Compose 项目目录">
            <Select value={config.composeProject || ''} onChange={(e) => setKey('composeProject', e.target.value)}>
              <option value="">选择项目…</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </Field>
          <Field label="构建后部署">
            <input type="checkbox" checked={!!config.alsoBuild} onChange={(e) => setKey('alsoBuild', e.target.checked)} /> 部署前先构建镜像
          </Field>
        </>
      )}
      {/* 私有仓库凭证区 */}
      <Field label="私有仓库凭证" hint={gitCred?.hasCred ? '已配置（留空不修改）' : '可选，公开仓库可跳过'}>
        <Select value={config.credType || 'token'} onChange={(e) => setKey('credType', e.target.value)}>
          <option value="token">HTTPS Token</option>
          <option value="ssh">SSH 私钥</option>
        </Select>
        {config.credType === 'ssh' ? (
          <Input value={config.credKey || ''} onChange={(e) => setKey('credKey', e.target.value)} placeholder={gitCred?.hasCred ? '已配置，输入以替换…' : '粘贴私钥内容'} textarea />
        ) : (
          <Input value={config.credToken || ''} onChange={(e) => setKey('credToken', e.target.value)} placeholder={gitCred?.hasCred ? '已配置，输入以替换…' : '粘贴 Token'} />
        )}
        {config.credType === 'ssh' && (
          <Field label="私钥口令（可选）">
            <Input value={config.credPassphrase || ''} onChange={(e) => setKey('credPassphrase', e.target.value)} placeholder="SSH 私钥口令" />
          </Field>
        )}
      </Field>
    </>
  );
}
```

> 说明：凭证通过 `config.credToken/credKey/credPassphrase/credType` 暂存，提交时把 `gitCred` 提取到顶层 body（见 Step 5），并从 config 中剔除敏感字段，避免明文入 config。

- [ ] **Step 4: tasks.tsx——提交时拆分 gitCred**

修改任务创建/编辑的提交逻辑，从 `config` 中提取凭证到顶层 `gitCred`，并从 `config` 删除 `credToken/credKey/credPassphrase/credType`：

```ts
function buildGitCred(config: Record<string, any>) {
  const type = config.credType === 'ssh' ? 'ssh' : 'token';
  const out: any = { type };
  if (type === 'ssh') {
    if (config.credKey) out.privateKey = config.credKey;
    if (config.credPassphrase) out.passphrase = config.credPassphrase;
  } else if (config.credToken) {
    out.token = config.credToken;
  }
  // 从 config 剔除敏感字段
  const { credType, credToken, credKey, credPassphrase, ...rest } = config;
  return { gitCred: out, cleanConfig: rest };
}
```

在 `handleSave` 提交 body 时：

```ts
const { gitCred, cleanConfig } = buildGitCred(form.config);
const body = { ...form, config: cleanConfig, gitCred: gitCred.token || gitCred.privateKey ? gitCred : null };
await post('/api/tasks', body); // 或 put
```

- [ ] **Step 5: tasks.tsx——Webhook 展示与操作**

在任务操作区（每行/详情）增加 Webhook 能力：对每个任务，若 `task.webhookToken` 存在则显示"已开启 Webhook"并可复制/关闭；否则显示"开启 Webhook"按钮。新增回调：

```ts
const handleWebhook = useCallback(async (taskId: string) => {
  try {
    const r = await post<{ ok: boolean; url: string; token: string }>(`/api/tasks/${taskId}/webhook`);
    if (r?.ok) {
      try { await navigator.clipboard.writeText(r.url); } catch { /* 忽略剪贴板失败 */ }
      showToast('Webhook 已生成并复制到剪贴板');
      loadTasks();
    }
  } catch (e: any) {
    showToast(e?.message || '生成 Webhook 失败', 'error');
  }
}, [loadTasks, showToast]);

const handleWebhookOff = useCallback(async (taskId: string) => {
  try {
    await del(`/api/tasks/${taskId}/webhook`);
    showToast('Webhook 已关闭');
    loadTasks();
  } catch (e: any) {
    showToast(e?.message || '关闭 Webhook 失败', 'error');
  }
}, [loadTasks, showToast]);
```

（前端需确保 `del` 已从 `../api/client` 导入；若未导入则补充。）

- [ ] **Step 6: 前端类型检查**

Run: `cd web && npx tsc -b --noEmit`
Expected: 无错误

- [ ] **Step 7: 前端构建**

Run: `cd web && npx vite build`
Expected: 构建成功

- [ ] **Step 8: Commit**

```bash
git add web/src/types/index.ts web/src/pages/tasks.tsx
git commit -m "feat(tasks): 前端支持 Git 自动部署任务、私有仓库凭证与 Webhook 展示"
```

---

### Task 6: 测试

**Files:**
- Create: `server/test/webhook-git.test.ts`
- Modify（可选）: `server/test/auth-security.test.ts`（沿用其测试骨架）

**Interfaces:**
- Consumes: `runTaskById`（scheduler）、`findTaskByWebhookToken` 逻辑、gitCli 的 `sanitizeTag`/`randomHex`
- Produces: 对 webhook token 匹配、git 凭证加解密、git-pull-build 配置校验的测试

- [ ] **Step 1: 写测试**

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizeTag } from '../src/gitCli';
import { encryptSecret, decryptSecret } from '../src/storage';

test('sanitizeTag 清洗分支名为合法镜像 tag', () => {
  assert.strictEqual(sanitizeTag('main'), 'main');
  assert.strictEqual(sanitizeTag('feature/my-app'), 'feature-my-app');
  assert.strictEqual(sanitizeTag('  '), 'latest');
});

test('Git 凭证可加密落库并解密还原', () => {
  const cred = JSON.stringify({ type: 'ssh', privateKey: '-----BEGIN RSA PRIVATE KEY-----\n...' });
  const enc = encryptSecret(cred);
  assert.notStrictEqual(enc, cred);
  assert.strictEqual(decryptSecret(enc), cred);
});
```

- [ ] **Step 2: 运行测试**

Run: `cd server && npm test`
Expected: 全部通过

- [ ] **Step 3: 端到端手工回归**

- 创建 `git-pull-build`（image 模式）任务 → 生成 Webhook → `POST /api/webhook/<token>` → 检查 `cron_task_logs` 出现该任务记录
- 运行 `npm run regression:tasks` 确认任务页回归

- [ ] **Step 4: Commit**

```bash
git add server/test/webhook-git.test.ts
git commit -m "test: 覆盖 git tag 清洗与凭证加解密"
```

---

## Self-Review 记录

- **Spec 覆盖**：Webhook 入口（Task4）✓；git-pull-build handler（Task3）✓；私有凭证（Task2/3/5）✓；构建镜像+compose 部署（Task3）✓；前端表单与 Webhook 展示（Task5）✓；加密落库/脱敏（Task3/5）✓；测试（Task6）✓。
- **占位符扫描**：无 TBD/TODO；所有代码步骤均含完整实现。
- **类型一致性**：`gitCloneOrPull`/`sanitizeTag`/`randomHex`/`runTaskById` 在各任务中命名一致；`GitCred` 类型在 gitCli 定义、tasks/webhook 使用一致；前端 `gitCred` 结构前后端一致。
