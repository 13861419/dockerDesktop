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

const router = Router();

/** 单应用并发部署锁 */
const deploying = new Set<number>();

/**
 * 触发一次部署（异步执行，立即返回）
 * @returns false = 应用不存在或已在部署中（拒绝重复触发）
 */
export function triggerDeployByToken(appId: number, source: string): boolean {
  if (deploying.has(appId)) {
    return false;
  }
  const app = getDb().prepare('SELECT * FROM deploy_apps WHERE id = ?').get(appId) as any;
  if (!app) {
    return false;
  }
  deploying.add(appId);
  getDb().prepare("UPDATE deploy_apps SET last_status = 'deploying', updated_at = ? WHERE id = ?").run(Date.now(), appId);
  deployApp(app, source)
    .then((result) => {
      recordDeploy(appId, app.name, result.ok, source, result.detail);
      if (!result.ok) {
        reportTaskFailure(`Git 部署【${app.name}】`, result.detail.slice(0, 500), source);
      }
    })
    .finally(() => {
      deploying.delete(appId);
    });
  return true;
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
  last_deploy_at: number | null;
  last_status: string | null;
  last_detail: string | null;
  created_at: number;
  updated_at: number;
}

/** 写部署历史 + 更新应用状态 */
function recordDeploy(appId: number, appName: string, ok: boolean, source: string, detail: string): void {
  getDb()
    .prepare('INSERT INTO deploy_logs (app_id, app_name, run_at, status, source, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(appId, appName, Date.now(), ok ? 0 : 1, source, detail.slice(0, 100000));
  getDb()
    .prepare('UPDATE deploy_apps SET last_deploy_at = ?, last_status = ?, last_detail = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), ok ? 'ok' : 'fail', detail.slice(0, 2000), Date.now(), appId);
}

/** 执行一次部署（git 同步 + compose up） */
async function deployApp(app: DeployApp, source: string): Promise<{ ok: boolean; detail: string }> {
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

    // 2. 定位 compose 文件（显式指定优先，否则自动探测）
    const composeFile = app.compose_path ? path.join(repoDir, app.compose_path) : findComposeFile(repoDir);
    if (!composeFile || !fs.existsSync(composeFile)) {
      return { ok: false, detail: `${lines.join('\n')}\n仓库中未找到 compose 文件` };
    }

    // 3. compose up
    const buildFlag = app.also_build ? ' --build' : '';
    const output = await runCmd(`docker compose -f "${composeFile}" up -d${buildFlag}`, repoDir);
    lines.push(output || 'compose up 完成');
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
              CASE WHEN webhook_secret IS NOT NULL AND webhook_secret != '' THEN 1 ELSE 0 END AS webhook_secret_set
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
