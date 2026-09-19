/**
 * Git 部署工作台 API（挂载路径 /api/deploys）
 *
 * - GET    /                    应用列表
 * - POST   /                    新建应用 body: { name, repoUrl, branch?, composePath?, cred? }
 * - PUT    /:id                 更新（body.cred 缺省保持原值）
 * - DELETE /:id                 删除应用（保留 compose 项目目录）
 * - POST   /:id/deploy          立即部署（异步执行；结果写部署历史）
 * - GET    /:id/logs            部署历史（最近 50 条）
 * - POST   /:id/webhook-token   重置 webhook token
 * - POST   /:id/webhook-secret  设置/清除 Git Webhook HMAC 签名密钥
 *
 * 部署动作 = gitCloneOrPull 到 COMPOSE_ROOT/<name> → docker compose up -d [--build]
 * webhook 触发：POST /api/webhook/<deploy_apps.webhook_token>（见 routes/webhook.ts）
 */
import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAdmin, requireAuth } from '../auth';
import { getDb, encryptSecret, decryptSecret } from '../storage';
import { logOperation } from '../operationLog';
import { gitCloneOrPull, gitAvailable, randomHex, type GitCred } from '../gitCli';
import { reportTaskFailure } from '../alerting';
import { COMPOSE_ROOT, findComposeFile, runCmd } from './composePaths';
import { isCommitSha, parseCiTarget, pollCiGate, fetchCiRuns } from '../ciGate';

const router = Router();

/** 单应用并发部署锁 */
const deploying = new Set<number>();

/** CI 门禁检查中的应用（不占部署锁；期间手动部署仍可执行） */
const ciChecking = new Set<number>();

/** GitOps 轮询判断：该应用是否正在部署或 CI 检查中（1.77.0） */
export function deployBusy(appId: number): boolean {
  return deploying.has(appId) || ciChecking.has(appId);
}

/**
 * 触发一次部署（异步执行，立即返回）
 * @param commitSha Webhook push 携带的 commit SHA（手动部署为空）；启用 CI 门禁时用于查询检查状态
 * @returns false = 应用不存在或已在部署中（拒绝重复触发）
 */
export function triggerDeployByToken(appId: number, source: string, commitSha = ''): boolean {
  if (deploying.has(appId) || ciChecking.has(appId)) {
    return false;
  }
  const app = getDb().prepare('SELECT * FROM deploy_apps WHERE id = ?').get(appId) as any;
  if (!app) {
    return false;
  }
  // CI 状态门禁（1.75.0）：作用于 webhook / gitops 触发且携带 commit 的部署；手动部署视为管理员显式放行
  if (app.ci_gate_enabled && (source === 'webhook' || source === 'gitops') && commitSha && isCommitSha(commitSha)) {
    if (ciChecking.has(app.id)) {
      return false;
    }
    ciChecking.add(app.id);
    getDb().prepare("UPDATE deploy_apps SET last_status = 'ci-checking', updated_at = ? WHERE id = ?").run(Date.now(), appId);
    runCiGate(app, commitSha, source);
    return true;
  }
  deploying.add(appId);
  getDb().prepare("UPDATE deploy_apps SET last_status = 'deploying', updated_at = ? WHERE id = ?").run(Date.now(), appId);
  deployApp(app, source)
    .then((result) => {
      recordDeploy(appId, app.name, result.ok, source, result.detail, commitSha);
      if (!result.ok) {
        reportTaskFailure(`Git 部署【${app.name}】`, result.detail.slice(0, 500), source);
      } else if (commitSha && isCommitSha(commitSha)) {
        // 绿快照：部署成功即记录当前 commit（若启用门禁，实际是 CI 绿灯的 commit）
        getDb().prepare('UPDATE deploy_apps SET last_green_commit = ? WHERE id = ?').run(commitSha, appId);
      }
    })
    .finally(() => {
      deploying.delete(appId);
    });
  return true;
}

/**
 * CI 门禁异步等待：轮询外部 CI 直到出结论/超时，再按策略放行或拦截部署
 */
function runCiGate(app: any, commitSha: string, source: 'webhook' | 'gitops'): void {
  const target = parseCiTarget(app.repo_url, app.ci_provider, app.ci_api_url);
  const policy: 'fail-open' | 'fail-closed' = app.ci_policy === 'fail-closed' ? 'fail-closed' : 'fail-open';
  const short = commitSha.slice(0, 7);
  const proceed = (note: string) => {
    getDb().prepare("UPDATE deploy_apps SET last_status = 'deploying', updated_at = ? WHERE id = ?").run(Date.now(), app.id);
    deployApp(app, source, commitSha)
      .then((result) => {
        recordDeploy(app.id, app.name, result.ok, source, `${note}\n${result.detail}`, commitSha);
        if (!result.ok) {
          reportTaskFailure(`Git 部署【${app.name}】`, result.detail.slice(0, 500), source);
        } else {
          getDb().prepare('UPDATE deploy_apps SET last_green_commit = ? WHERE id = ?').run(commitSha, app.id);
        }
      })
      .finally(() => {
        ciChecking.delete(app.id);
      });
  };
  const block = (detail: string) => {
    recordGateBlocked(app.id, app.name, short, detail);
    reportTaskFailure(`CI 门禁【${app.name}】`, detail.slice(0, 500), 'ci-gate');
    ciChecking.delete(app.id);
  };
  if (!target) {
    // 仓库地址无法解析为可查询的 CI —— 按策略降级，避免部署永久卡死
    if (policy === 'fail-open') {
      proceed(`[CI 门禁] 无法识别 CI 仓库（${app.repo_url}），fail-open 放行`);
      return;
    }
    block(`[CI 门禁] 无法识别 CI 仓库（${app.repo_url}），fail-closed 拦截部署`);
    return;
  }
  const token = app.ci_token_enc ? safeDecrypt(app.ci_token_enc) : '';
  pollCiGate(target, commitSha, token)
    .then(({ state }) => {
      if (state === 'success') {
        proceed(`[CI 门禁] commit ${short} CI 绿灯，放行部署`);
      } else if (state === 'failure') {
        block(`[CI 门禁] commit ${short} CI 检查未通过，已拦截部署`);
      } else {
        // timeout：按策略处置
        if (policy === 'fail-open') {
          proceed(`[CI 门禁] commit ${short} CI 检查超时（约 10 分钟），fail-open 放行部署`);
        } else {
          block(`[CI 门禁] commit ${short} CI 检查超时（约 10 分钟），fail-closed 拦截部署`);
        }
      }
    })
    .catch((err) => {
      if (policy === 'fail-open') {
        proceed(`[CI 门禁] CI 状态查询异常（${String(err?.message || err).slice(0, 200)}），fail-open 放行部署`);
      } else {
        block(`[CI 门禁] commit ${short} CI 状态查询异常，fail-closed 拦截部署`);
      }
      ciChecking.delete(app.id);
    });
}

/** 解密 CI Token（容错） */
function safeDecrypt(enc: string): string {
  try {
    return decryptSecret(enc) || '';
  } catch {
    return '';
  }
}

/** 记录一次被门禁拦截的部署（写历史 + 置状态，不执行部署） */
function recordGateBlocked(appId: number, appName: string, shortSha: string, detail: string): void {
  getDb()
    .prepare('INSERT INTO deploy_logs (app_id, app_name, run_at, status, source, detail, commit_sha, ci_state) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
    .run(appId, appName, Date.now(), 'ci-gate', detail.slice(0, 100000), shortSha, 'blocked');
  getDb()
    .prepare("UPDATE deploy_apps SET last_status = 'ci-blocked', last_deploy_at = ?, last_detail = ?, updated_at = ? WHERE id = ?")
    .run(Date.now(), detail.slice(0, 2000), Date.now(), appId);
}

interface DeployApp {
  id: number;
  name: string;
  repo_url: string;
  branch: string;
  compose_path: string;
  also_build: number;
  cred_encrypted: string | null;
  webhook_token: string;
  ci_gate_enabled?: number;
  ci_provider?: string | null;
  ci_api_url?: string | null;
  ci_policy?: string | null;
  last_green_commit?: string | null;
  /** 部署钩子（1.78.0）：compose up 前后逐行执行的自定义命令 */
  pre_hook?: string | null;
  post_hook?: string | null;
  last_deploy_at: number | null;
  last_status: string | null;
  last_detail: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 解析钩子脚本为命令列表：逐行切分，去空行与 # 注释行（1.78.0）
 */
export function parseHookLines(hook: string | null | undefined): string[] {
  return String(hook || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** 执行钩子脚本：命令逐行按序执行，任一失败立即中止并返回 false */
async function runHookLines(hook: string | null | undefined, cwd: string): Promise<{ ok: boolean; output: string }> {
  const lines = parseHookLines(hook);
  const outputs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const out = await runCmd(lines[i], cwd);
      outputs.push(`$ ${lines[i]}\n${out || '(无输出)'}`.trim());
    } catch (e: any) {
      return { ok: false, output: `第 ${i + 1} 条命令失败（${lines[i].slice(0, 200)}）：${String(e?.message || e).slice(0, 2000)}` };
    }
  }
  return { ok: true, output: outputs.join('\n') };
}

/** 写部署历史 + 更新应用状态 */
function recordDeploy(appId: number, appName: string, ok: boolean, source: string, detail: string, commitSha = ''): void {
  const sha = commitSha && isCommitSha(commitSha) ? commitSha : null;
  getDb()
    .prepare('INSERT INTO deploy_logs (app_id, app_name, run_at, status, source, detail, commit_sha, ci_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(appId, appName, Date.now(), ok ? 0 : 1, source, detail.slice(0, 100000), sha, ok ? 'success' : null);
  getDb()
    .prepare('UPDATE deploy_apps SET last_deploy_at = ?, last_status = ?, last_detail = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), ok ? 'ok' : 'fail', detail.slice(0, 2000), Date.now(), appId);
}

/** 执行一次部署（git 同步 + compose up；greenRef 非空时先 checkout 到该 commit——绿快照回滚） */
async function deployApp(app: DeployApp, source: string, greenRef = ''): Promise<{ ok: boolean; detail: string }> {
  const lines: string[] = [];
  try {
    if (!(await gitAvailable())) {
      return { ok: false, detail: '本机未检测到 git 命令，无法部署' };
    }
    const repoDir = path.join(COMPOSE_ROOT, app.name);

    // 1. clone / pull
    let cred: GitCred | null = null;
    if (app.cred_encrypted) {
      try {
        cred = JSON.parse(decryptSecret(app.cred_encrypted) || '{}');
      } catch {
        cred = null;
      }
    }
    const gitOut = await gitCloneOrPull({ repoUrl: app.repo_url, dir: repoDir, branch: app.branch, cred });
    lines.push(gitOut);

    // 1.5 绿快照回滚：检出指定 commit（hex 已严格校验）
    if (greenRef) {
      await runCmd(`git fetch --all`, repoDir);
      const checkoutOut = await runCmd(`git checkout -f ${greenRef}`, repoDir);
      lines.push(`[绿快照] 已检出 ${greenRef.slice(0, 7)}\n${checkoutOut || ''}`);
    }

    // 2. 定位 compose 文件（显式指定优先，否则自动探测）
    const composeFile = app.compose_path ? path.join(repoDir, app.compose_path) : findComposeFile(repoDir);
    if (!composeFile || !fs.existsSync(composeFile)) {
      return { ok: false, detail: `${lines.join('\n')}\n仓库中未找到 compose 文件` };
    }

    // 2.5 部署前钩子（1.78.0）：任一命令失败即中止本次部署
    if (app.pre_hook) {
      const pre = await runHookLines(app.pre_hook, repoDir);
      lines.push(`[部署前钩子]\n${pre.output || '(无命令)'}`);
      if (!pre.ok) {
        return { ok: false, detail: `${lines.join('\n')}\n部署前钩子失败，已中止本次部署（容器未改动）` };
      }
    }

    // 3. compose up
    const buildFlag = app.also_build ? ' --build' : '';
    const output = await runCmd(`docker compose -f "${composeFile}" up -d${buildFlag}`, repoDir);
    lines.push(output || 'compose up 完成');

    // 4. 后置钩子（1.78.0）：失败不影响已上线容器，仅在详情中记录警告
    if (app.post_hook) {
      const post = await runHookLines(app.post_hook, repoDir);
      lines.push(post.ok ? `[后置钩子]\n${post.output || '(无命令)'}` : `[后置钩子失败（不影响已上线容器）]\n${post.output}`);
    }
    return { ok: true, detail: lines.join('\n') };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

/** GET / — 应用列表 */
router.get('/', requireAuth, (_req: Request, res: Response) => {
  const apps = getDb()
    .prepare(
      `SELECT id, name, repo_url, branch, compose_path, also_build, webhook_token, last_deploy_at, last_status, last_detail, created_at, updated_at,
              CASE WHEN webhook_secret IS NOT NULL AND webhook_secret != '' THEN 1 ELSE 0 END AS webhook_secret_set,
              ci_gate_enabled, ci_provider, ci_api_url, ci_policy, last_green_commit,
              CASE WHEN ci_token_enc IS NOT NULL AND ci_token_enc != '' THEN 1 ELSE 0 END AS ci_token_set,
              gitops_enabled, gitops_interval_min, gitops_auto, gitops_last_commit, gitops_last_check,
              pre_hook, post_hook
       FROM deploy_apps ORDER BY id DESC`,
    )
    .all();
  res.json({ items: apps });
});

/** POST / — 新建部署应用 */
router.post('/', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim();
  const repoUrl = String(req.body?.repoUrl || '').trim();
  if (!name || !repoUrl) {
    return res.status(400).json({ error: '缺少应用名或仓库地址' });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    return res.status(400).json({ error: '应用名仅允许字母数字与 . _ -（作为 compose 项目名）' });
  }
  const branch = String(req.body?.branch || '').trim();
  const composePath = String(req.body?.composePath || '').trim();
  const alsoBuild = req.body?.alsoBuild !== false;
  let credEnc: string | null = null;
  if (req.body?.cred && typeof req.body.cred === 'object') {
    credEnc = encryptSecret(JSON.stringify(req.body.cred));
  }
  const now = Date.now();
  try {
    getDb()
      .prepare(
        `INSERT INTO deploy_apps (name, repo_url, branch, compose_path, also_build, cred_encrypted, webhook_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, repoUrl, branch, composePath, alsoBuild ? 1 : 0, credEnc, randomHex(16), now, now);
  } catch (e: any) {
    return res.status(400).json({ error: String(e?.message || e) });
  }
  logOperation(res.locals.username, '新建部署应用', 'compose', name, repoUrl, true);
  res.json({ ok: true });
});

/** PUT /:id — 更新部署应用（cred/ciToken 缺省保持原值；1.75.0 起含 CI 门禁配置） */
router.put('/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const app = getDb().prepare('SELECT * FROM deploy_apps WHERE id = ?').get(id) as any;
  if (!app) {
    return res.status(404).json({ error: '应用不存在' });
  }
  const name = String(req.body?.name || app.name).trim();
  const repoUrl = String(req.body?.repoUrl || app.repo_url).trim();
  if (!name || !repoUrl) {
    return res.status(400).json({ error: '缺少应用名或仓库地址' });
  }
  const branch = String(req.body?.branch ?? app.branch).trim();
  const composePath = String(req.body?.composePath ?? app.compose_path).trim();
  const alsoBuild = req.body?.alsoBuild === undefined ? app.also_build : req.body.alsoBuild ? 1 : 0;
  let credEnc = app.cred_encrypted;
  if (req.body?.cred && typeof req.body.cred === 'object') {
    credEnc = encryptSecret(JSON.stringify(req.body.cred));
  }
  // CI 门禁配置：显式传布尔才变更；token 传非空覆盖、空串清除、缺省保持
  const ciGateEnabled = req.body?.ciGateEnabled === undefined ? (app.ci_gate_enabled ? 1 : 0) : req.body.ciGateEnabled ? 1 : 0;
  const ciProvider = String(req.body?.ciProvider ?? app.ci_provider ?? '').trim();
  const ciApiUrl = String(req.body?.ciApiUrl ?? app.ci_api_url ?? '').trim();
  const ciPolicy = req.body?.ciPolicy === 'fail-closed' ? 'fail-closed' : 'fail-open';
  let ciTokenEnc = app.ci_token_enc;
  if (req.body?.ciToken !== undefined) {
    const t = String(req.body.ciToken).trim();
    ciTokenEnc = t ? encryptSecret(t) : null;
  }
  // GitOps 定时同步配置（1.77.0）：显式传布尔才变更；间隔 1–1440 分钟
  const gitopsEnabled = req.body?.gitopsEnabled === undefined ? (app.gitops_enabled ? 1 : 0) : req.body.gitopsEnabled ? 1 : 0;
  const gitopsAuto = req.body?.gitopsAuto === undefined ? (app.gitops_auto ? 1 : 0) : req.body.gitopsAuto ? 1 : 0;
  const gitopsIntervalMin = Math.max(1, Math.min(1440, Number(req.body?.gitopsIntervalMin ?? app.gitops_interval_min ?? 5) || 5));
  // 部署钩子（1.78.0）：显式传值才变更（空串=清除）
  const preHook = req.body?.preHook !== undefined ? String(req.body.preHook).trim().slice(0, 10000) || null : app.pre_hook;
  const postHook = req.body?.postHook !== undefined ? String(req.body.postHook).trim().slice(0, 10000) || null : app.post_hook;
  try {
    getDb()
      .prepare(
        `UPDATE deploy_apps SET name = ?, repo_url = ?, branch = ?, compose_path = ?, also_build = ?, cred_encrypted = ?,
           ci_gate_enabled = ?, ci_provider = ?, ci_api_url = ?, ci_policy = ?, ci_token_enc = ?,
           gitops_enabled = ?, gitops_auto = ?, gitops_interval_min = ?, pre_hook = ?, post_hook = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(name, repoUrl, branch, composePath, alsoBuild, credEnc, ciGateEnabled, ciProvider || null, ciApiUrl || null, ciPolicy, ciTokenEnc, gitopsEnabled, gitopsAuto, gitopsIntervalMin, preHook, postHook, Date.now(), id);
  } catch (e: any) {
    return res.status(400).json({ error: String(e?.message || e) });
  }
  logOperation(res.locals.username, '更新部署应用', 'compose', name, repoUrl, true);
  res.json({ ok: true });
});

/** POST /:id/deploy-green — 部署最后一次 CI 绿 + 部署成功的 commit（绿快照回滚，1.75.0） */
router.post('/:id/deploy-green', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const app = getDb().prepare('SELECT * FROM deploy_apps WHERE id = ?').get(id) as any;
  if (!app) {
    return res.status(404).json({ error: '应用不存在' });
  }
  const sha = String(app.last_green_commit || '');
  if (!isCommitSha(sha)) {
    return res.status(400).json({ error: '尚无绿构建记录（需要启用 CI 门禁并成功部署过一次）' });
  }
  if (deploying.has(id)) {
    return res.status(409).json({ error: '该应用正在部署中' });
  }
  deploying.add(id);
  getDb().prepare("UPDATE deploy_apps SET last_status = 'deploying', updated_at = ? WHERE id = ?").run(Date.now(), id);
  deployApp(app, 'manual', sha)
    .then((result) => {
      recordDeploy(id, app.name, result.ok, 'manual', result.detail, sha);
      if (!result.ok) {
        reportTaskFailure(`Git 部署【${app.name}】`, result.detail.slice(0, 500), 'manual');
      }
    })
    .finally(() => {
      deploying.delete(id);
    });
  logOperation(res.locals.username, '部署最后绿构建', 'compose', app.name, sha.slice(0, 7), true);
  res.json({ ok: true, message: '绿快照部署已开始，结果见部署历史' });
});

/** DELETE /:id — 删除应用 */
router.delete('/:id', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT name FROM deploy_apps WHERE id = ?').get(Number(req.params.id)) as any;
  if (!row) {
    return res.status(404).json({ error: '应用不存在' });
  }
  getDb().prepare('DELETE FROM deploy_apps WHERE id = ?').run(Number(req.params.id));
  getDb().prepare('DELETE FROM deploy_logs WHERE app_id = ?').run(Number(req.params.id));
  logOperation(res.locals.username, '删除部署应用', 'compose', row.name, '', true);
  res.json({ ok: true });
});

/** POST /:id/deploy — 立即部署（异步执行，立即返回） */
router.post('/:id/deploy', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const app = getDb().prepare('SELECT * FROM deploy_apps WHERE id = ?').get(id) as any;
  if (!app) {
    return res.status(404).json({ error: '应用不存在' });
  }
  const source = req.body?.source === 'webhook' ? 'webhook' : 'manual';
  const started = triggerDeployByToken(id, source);
  if (!started) {
    return res.status(409).json({ error: '该应用正在部署中' });
  }
  logOperation(res.locals.username, '触发 Git 部署', 'compose', app.name, source, true);
  res.json({ ok: true, message: '部署已开始，结果见部署历史' });
});

/** GET /:id/logs — 部署历史 */
router.get('/:id/logs', requireAuth, (req: Request, res: Response) => {
  const logs = getDb()
    .prepare('SELECT * FROM deploy_logs WHERE app_id = ? ORDER BY id DESC LIMIT 50')
    .all(Number(req.params.id));
  res.json({ items: logs });
});

/** GET /:id/ci-runs — CI 运行记录只读看板（1.79.0，最近 10 条工作流运行） */
router.get('/:id/ci-runs', requireAuth, async (req: Request, res: Response) => {
  const app = getDb().prepare('SELECT * FROM deploy_apps WHERE id = ?').get(Number(req.params.id)) as any;
  if (!app) {
    return res.status(404).json({ error: '应用不存在' });
  }
  const target = parseCiTarget(app.repo_url, app.ci_provider, app.ci_api_url);
  if (!target) {
    return res.status(400).json({ error: '无法识别仓库对应的 CI 平台（仅支持 GitHub / Gitea / GitLab）' });
  }
  try {
    const items = await fetchCiRuns(target, app.ci_token_enc ? safeDecrypt(app.ci_token_enc) : '');
    res.json({ items });
  } catch (e: any) {
    res.status(502).json({ error: String(e?.message || e).slice(0, 300) });
  }
});

/** POST /:id/webhook-token — 重置 webhook token */
router.post('/:id/webhook-token', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const token = randomHex(16);
  getDb().prepare('UPDATE deploy_apps SET webhook_token = ?, updated_at = ? WHERE id = ?').run(token, Date.now(), Number(req.params.id));
  logOperation(res.locals.username, '重置部署 Webhook Token', 'compose', String(req.params.id), '', true);
  res.json({ ok: true, token });
});

/** POST /:id/webhook-secret — 设置/清除 Git Webhook HMAC 签名密钥（body.secret 为空串或省略=清除） */
router.post('/:id/webhook-secret', requireAuth, requireAdmin, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = getDb().prepare('SELECT name FROM deploy_apps WHERE id = ?').get(id) as any;
  if (!row) {
    return res.status(404).json({ error: '应用不存在' });
  }
  const raw = req.body?.secret;
  const secret = raw === undefined || raw === null ? '' : String(raw).trim();
  if (secret.length > 256) {
    return res.status(400).json({ error: '签名密钥过长（上限 256 字符）' });
  }
  getDb()
    .prepare('UPDATE deploy_apps SET webhook_secret = ?, updated_at = ? WHERE id = ?')
    .run(secret || null, Date.now(), id);
  logOperation(
    res.locals.username,
    secret ? '设置部署 Webhook 签名密钥' : '清除部署 Webhook 签名密钥',
    'compose',
    row.name || String(id),
    '',
    true,
  );
  res.json({ ok: true, enabled: !!secret });
});

export default router;
