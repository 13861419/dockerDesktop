/**
 * GitOps 定时同步（1.77.0）
 *
 * 面板仍定位为「CI 状态消费者」：本模块只做只读的 Git 平台 API 轮询——
 * 定时查询部署应用分支的最新 commit，发现新提交后按配置动作：
 *  - gitops_auto=1：走既有部署链路（含 CI 状态门禁）自动部署
 *  - gitops_auto=0：仅写一条 GitOps 提醒记录，由管理员决定是否部署
 * 首次启用（gitops_last_commit 为空）仅记录基线 commit，不触发部署。
 *
 * API 形状：
 *  - GitHub：GET /repos/{owner}/{repo}/commits/{ref}        → { sha, commit: { message } }
 *  - Gitea ：GET /api/v1/repos/{owner}/{repo}/commits/{ref} → 同 GitHub 形状
 *  - GitLab：GET /api/v4/projects/{path}/repository/commits/{ref} → { id, title }
 */

import { getDb } from './storage';
import { parseCiTarget, isCommitSha } from './ciGate';
import { triggerDeployByToken, deployBusy } from './routes/deploys';
import { decryptSecret } from './storage';

interface LatestCommit {
  sha: string;
  message: string;
}

/** 查询分支最新 commit（网络异常抛出） */
export async function fetchLatestCommit(
  target: { provider: 'github' | 'gitea' | 'gitlab'; apiBase: string; owner: string; repo: string; fullPath: string },
  branch: string,
  token: string,
): Promise<LatestCommit> {
  const headers: Record<string, string> = { 'User-Agent': 'DockerManager-GitOps', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ref = encodeURIComponent(branch || 'HEAD');
  let url: string;
  if (target.provider === 'github') {
    url = `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${ref}`;
    headers.Accept = 'application/vnd.github+json';
  } else if (target.provider === 'gitlab') {
    url = `${target.apiBase}/projects/${encodeURIComponent(target.fullPath)}/repository/commits/${ref}`;
  } else {
    url = `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${ref}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Git API ${res.status}`);
  const data: any = await res.json();
  const sha = String(data?.sha || data?.id || '');
  const message = String(data?.commit?.message || data?.title || '').split('\n')[0].trim();
  if (!isCommitSha(sha)) throw new Error('Git API 返回了无效的 commit SHA');
  return { sha, message };
}

/** 解密 CI Token（容错） */
function safeDecrypt(enc: string): string {
  try {
    return decryptSecret(enc) || '';
  } catch {
    return '';
  }
}

/** 对单个部署应用执行一轮 GitOps 检查 */
export async function runGitOpsSync(app: any): Promise<void> {
  const db = getDb();
  const target = parseCiTarget(app.repo_url, app.ci_provider, app.ci_api_url);
  // 无论成败都刷新检查时间：失败时下个周期再试，避免 30s tick 连续打爆不可达的 API
  const markChecked = () => db.prepare('UPDATE deploy_apps SET gitops_last_check = ? WHERE id = ?').run(Date.now(), app.id);
  if (!target) {
    markChecked();
    return;
  }
  let latest: LatestCommit;
  try {
    latest = await fetchLatestCommit(target, app.branch || '', app.ci_token_enc ? safeDecrypt(app.ci_token_enc) : '');
  } catch {
    markChecked();
    return;
  }
  const first = !app.gitops_last_commit;
  const changed = app.gitops_last_commit !== latest.sha;
  if (!changed) {
    markChecked();
    return;
  }
  // 首次启用：仅记录基线，不触发部署
  db.prepare('UPDATE deploy_apps SET gitops_last_commit = ?, gitops_last_check = ? WHERE id = ?').run(latest.sha, Date.now(), app.id);
  if (first) return;
  if (app.gitops_auto === 1) {
    triggerDeployByToken(app.id, 'gitops', latest.sha);
  } else {
    db.prepare(
      "INSERT INTO deploy_logs (app_id, app_name, run_at, status, source, detail, commit_sha, ci_state) VALUES (?, ?, ?, 0, 'gitops', ?, ?, NULL)",
    ).run(
      app.id,
      app.name,
      Date.now(),
      `[GitOps] 发现新提交 ${latest.sha.slice(0, 7)}：${latest.message.slice(0, 200)}（未启用自动部署，请手动确认）`,
      latest.sha,
    );
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
const syncing = new Set<number>();

/** 启动 GitOps 轮询（5 秒后首检，此后每 30 秒扫一遍到期应用） */
export function startGitOps(): void {
  if (timer) return;
  const tick = () => {
    try {
      const apps = getDb().prepare('SELECT * FROM deploy_apps WHERE gitops_enabled = 1').all() as any[];
      for (const app of apps) {
        const intervalMs = Math.max(1, Number(app.gitops_interval_min) || 5) * 60000;
        const last = Number(app.gitops_last_check) || 0;
        if (Date.now() - last < intervalMs) continue;
        if (syncing.has(app.id) || deployBusy(app.id)) continue;
        syncing.add(app.id);
        runGitOpsSync(app)
          .catch(() => {
            // 单应用异常不影响其他应用
          })
          .finally(() => syncing.delete(app.id));
      }
    } catch {
      // 数据库未就绪等启动期异常，下轮重试
    }
  };
  setTimeout(tick, 5000);
  timer = setInterval(tick, 30000);
}

/** 停止轮询（进程退出用） */
export function stopGitOps(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
