/**
 * CI 状态门禁（1.75.0）
 *
 * 面板定位为「CI 状态消费者」而非执行器：Git 部署的 Webhook 触发路径上，
 * 先异步查询该 commit 在外部 CI（GitHub Actions / Gitea / GitLab）的汇总状态，
 * 绿了才真正部署；查询不可达或超时按 ci_policy 降级（fail-open 放行 / fail-closed 拦截），
 * 绝不阻塞部署主路径。零第三方依赖，全部用 Node 内置 fetch。
 *
 * 状态汇总口径（与各平台对齐）：
 *  - GitHub：check-runs 聚合（Actions 结果在此），404/无权限时回退 legacy combined status
 *  - Gitea：commit status API（success/failure/pending/warning）
 *  - GitLab：commit statuses 聚合（任一 failed → failure，全部 success → success）
 */

export type CiState = 'success' | 'failure' | 'pending' | 'error';
export type CiProvider = 'github' | 'gitea' | 'gitlab';
export type CiPolicy = 'fail-open' | 'fail-closed';

/** 从部署应用表解出的 CI 门禁配置（行数据为 snake_case） */
export interface CiGateConfig {
  ci_provider?: string | null;
  ci_api_url?: string | null;
  ci_token_enc?: string | null;
  ci_policy?: string | null;
}

/** 从仓库 URL 解析 CI 查询目标；无法识别返回 null */
export function parseCiTarget(
  repoUrl: string,
  explicitProvider?: string | null,
  apiUrlOverride?: string | null,
): { provider: CiProvider; apiBase: string; owner: string; repo: string; fullPath: string } | null {
  const url = repoUrl.trim();
  let host = '';
  let pathPart = '';
  let scheme = 'https';
  const scp = /^git@([^:/]+):(.+?)(?:\.git)?\/?$/i.exec(url);
  if (scp) {
    host = scp[1];
    pathPart = scp[2];
  } else {
    const m = /^(https?):\/\/([^/]+)\/(.+)$/i.exec(url);
    if (!m) return null;
    scheme = m[1].toLowerCase();
    host = m[2];
    pathPart = m[3].replace(/\.git$/i, '').replace(/\/+$/, '');
  }
  const segs = pathPart.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0];
  const repo = segs[1].replace(/\.git$/i, '');
  const provider: CiProvider =
    explicitProvider === 'github' || explicitProvider === 'gitea' || explicitProvider === 'gitlab'
      ? explicitProvider
      : /github\.com$/i.test(host)
        ? 'github'
        : /gitlab/i.test(host)
          ? 'gitlab'
          : 'gitea'; // gitea 为自建默认猜测（API 形状也兼容部分 Forgejo）
  let apiBase: string;
  if (apiUrlOverride && apiUrlOverride.trim()) {
    apiBase = apiUrlOverride.trim().replace(/\/+$/, '');
  } else if (provider === 'github') {
    apiBase = 'https://api.github.com';
  } else if (provider === 'gitlab') {
    apiBase = `${scheme}://${host}/api/v4`;
  } else {
    apiBase = `${scheme}://${host}/api/v1`;
  }
  return { provider, apiBase, owner, repo, fullPath: pathPart };
}

/** 严格校验 commit SHA（hex 7-40 位），防止注入 */
export function isCommitSha(sha: string): boolean {
  return /^[0-9a-fA-F]{7,40}$/.test(sha);
}

/** GitHub check-runs 聚合：任一失败 → failure；存在且全部 success → success；否则 pending */
function aggregateCheckRuns(data: any): CiState {
  const runs: any[] = Array.isArray(data?.check_runs) ? data.check_runs : [];
  if (runs.length === 0) return 'pending';
  let allSuccess = true;
  let sawPending = false;
  for (const r of runs) {
    const c = String(r?.conclusion || r?.status || 'pending').toLowerCase();
    if (['failure', 'timed_out', 'action_required', 'cancelled', 'startup_failure'].includes(c)) return 'failure';
    if (c !== 'success') allSuccess = false;
    if (['pending', 'queued', 'in_progress', 'waiting', 'requested'].includes(c)) sawPending = true;
  }
  if (allSuccess) return 'success';
  return sawPending ? 'pending' : 'pending';
}

/** GitLab statuses 数组聚合：任一 failed → failure；非空且全 success → success；否则 pending */
function aggregateGitlabStatuses(data: any): CiState {
  const items: any[] = Array.isArray(data) ? data : [];
  if (items.length === 0) return 'pending';
  let allSuccess = true;
  for (const it of items) {
    const s = String(it?.status || '').toLowerCase();
    if (s === 'failed' || s === 'canceled') return 'failure';
    if (s !== 'success') allSuccess = false;
  }
  return allSuccess ? 'success' : 'pending';
}

/** 查询单次 CI 汇总状态（网络异常抛出） */
export async function fetchCiState(
  target: { provider: CiProvider; apiBase: string; owner: string; repo: string; fullPath: string },
  commitSha: string,
  token: string,
): Promise<CiState> {
  const headers: Record<string, string> = { 'User-Agent': 'DockerManager-CiGate', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let url: string;
  if (target.provider === 'github') {
    url = `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${commitSha}/check-runs`;
    headers.Accept = 'application/vnd.github+json';
  } else if (target.provider === 'gitlab') {
    const project = encodeURIComponent(target.fullPath);
    url = `${target.apiBase}/projects/${project}/repository/commits/${commitSha}/statuses`;
  } else {
    url = `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${commitSha}/status`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  if (res.status === 404) {
    // GitHub 细粒度 PAT 无 checks:read 时回退 legacy combined status
    if (target.provider === 'github') {
      const fallback = await fetch(
        `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${commitSha}/status`,
        { headers, signal: AbortSignal.timeout(12000) },
      );
      if (fallback.ok) {
        const state = String((<any>await fallback.json())?.state || '').toLowerCase();
        return state === 'success' ? 'success' : state === 'failure' ? 'failure' : 'pending';
      }
    }
    return 'error';
  }
  if (res.status === 401 || res.status === 403) return 'error';
  if (!res.ok) return 'error';
  const data: any = await res.json();
  if (target.provider === 'github') {
    const state = aggregateCheckRuns(data);
    if (state === 'success') return 'success';
    if (state === 'failure') return 'failure';
    // check-runs 为空时可能是外部 commit status，回退 combined status
    try {
      const fb = await fetch(
        `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${commitSha}/status`,
        { headers, signal: AbortSignal.timeout(12000) },
      );
      if (fb.ok) {
        const s = String((<any>await fb.json())?.state || '').toLowerCase();
        return s === 'success' ? 'success' : s === 'failure' ? 'failure' : state;
      }
    } catch {
      // 回退失败保持原状态
    }
    return state;
  }
  if (target.provider === 'gitlab') return aggregateGitlabStatuses(data);
  const state = String(data?.status || '').toLowerCase();
  return state === 'success' ? 'success' : state === 'failure' ? 'failure' : 'pending';
}

/** 轮询参数（20s × 30 次 ≈ 10 分钟，覆盖绝大多数 CI 时长） */
const POLL_INTERVAL_MS = 20000;
const POLL_MAX_ATTEMPTS = 30;

export type GateOutcome = { state: 'success' | 'failure' | 'timeout' };

/**
 * 轮询等待 CI 结论；success/failure 立即返回，超过时限返回 timeout（由调用方按 policy 处置）
 */
export async function pollCiGate(
  target: { provider: CiProvider; apiBase: string; owner: string; repo: string; fullPath: string },
  commitSha: string,
  token: string,
  onAttempt?: (attempt: number, state: CiState) => void,
): Promise<GateOutcome> {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const state = await fetchCiState(target, commitSha, token);
      onAttempt?.(attempt, state);
      if (state === 'success') return { state: 'success' };
      if (state === 'failure') return { state: 'failure' };
      // pending / error：error 可能是网络抖动，继续重试
    } catch {
      onAttempt?.(attempt, 'error');
    }
    if (attempt < POLL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  return { state: 'timeout' };
}
