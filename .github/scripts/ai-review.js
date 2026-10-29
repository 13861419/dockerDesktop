#!/usr/bin/env node
/**
 * AI 审查脚本 —— 由 .github/workflows/ai-review.yml 在 PR 上调用
 *
 * 兼容 GitHub 托管 runner 与 Windows/Linux 自托管 runner（仅依赖 git + node）：
 *   1. 提取 PR diff（相对 base 分支，超 AI_DIFF_MAX_CHARS 截断）
 *   2. 组装 REVIEW.md 章程 + PR 信息 + diff，调用 OpenAI 兼容 /chat/completions
 *   3. 结果以 PR 评论形式回填（先占位再编辑，失败留痕）
 *
 * 环境变量：
 *   必填  AI_API_KEY / AI_BASE_URL / AI_MODEL   模型接口配置
 *         GH_TOKEN / PR_NUMBER / BASE_REF       GitHub 注入
 *         PR_TITLE / PR_BODY                    PR 元信息
 *   可选  AI_DIFF_MAX_CHARS                     diff 截断阈值（默认 60000）
 */
const { execSync } = require('child_process');
const fs = require('fs');

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GH_TOKEN || '';
const PR_NUMBER = process.env.PR_NUMBER;
const BASE_REF = process.env.BASE_REF || 'main';
const BASE_URL = (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.AI_MODEL || 'deepseek-chat';
const API_KEY = process.env.AI_API_KEY || '';
const DIFF_CAP = Number(process.env.AI_DIFF_MAX_CHARS || 60000);

// 双平台兼容：GitHub（Bearer）与 Gitea Actions（token 认证头，GITHUB_API_URL 自带 /api/v1 前缀）
const IS_GITEA = /\/api\/v1$/.test(API) || process.env.GITEA_ACTIONS === 'true';
const AUTH_VALUE = IS_GITEA ? `token ${TOKEN}` : `Bearer ${TOKEN}`;

async function ghRequest(path, method, bodyObj) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: AUTH_VALUE,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  return res;
}

async function main() {
  // ---- Guard：未配置 Key 时优雅跳过（job 显示 pass + notice，不红） ----
  if (!API_KEY) {
    console.log('::notice::未配置 AI_API_KEY，跳过 AI 审查。添加路径：Settings → Secrets and variables → Actions');
    return;
  }

  // ---- Node 版本守卫：内置 fetch 需要 ≥ 18 ----
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) {
    console.error(`::error::Node 版本过低（${process.versions.node}），自托管 runner 需要 Node ≥ 18（内置 fetch）`);
    process.exit(1);
  }

  // ---- 提取 diff，保护 token 预算 ----
  // Gitea Actions 的自动克隆可能不含基线分支，先确保 origin/<BASE_REF> 存在（GitHub 上无害）
  try {
    const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
    execSync(`git remote set-url origin "https://x-access-token:${TOKEN}@${server.replace(/^https?:\/\//, '')}/${REPO}.git"`, { stdio: 'ignore' });
    execSync(`git fetch origin ${BASE_REF} --quiet`, { stdio: 'ignore' });
  } catch (e) {
    // origin/<BASE_REF> 已存在时失败可忽略
  }
  const rawDiff = execSync(`git diff origin/${BASE_REF}...HEAD`, {
    maxBuffer: 64 * 1024 * 1024
  }).toString();

  if (!rawDiff.trim()) {
    await ghRequest(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, 'POST', {
      body: '🤖 AI 审查：✅ 无代码 diff（纯分支同步），跳过审查。'
    });
    return;
  }

  let diffText = rawDiff;
  if (diffText.length > DIFF_CAP) {
    diffText = diffText.slice(0, DIFF_CAP) + '\n...（diff 超长已截断，请结合本地深度审查）';
  }

  const charter = fs.existsSync('REVIEW.md') ? fs.readFileSync('REVIEW.md', 'utf8') : '见仓库根目录 REVIEW.md';
  const prBody = (process.env.PR_BODY || '').slice(0, 2000);
  const prTitle = process.env.PR_TITLE || '';

  const systemPrompt = [
    '你是本仓库的 AI 代码审查器。优先级明文：先抓真 bug，其次减少审查轮数。',
    '',
    '重点检查（REVIEW.md 高风险区）：',
    '1. 认证与凭据：禁止放宽校验、明文落库',
    '2. 命令执行：拼接 shell 必须转义；用户输入/AI 生成的命令进入 exec 前必须有白名单或审批边界',
    '3. 主机文件：路径穿越（../、符号链接）必须边界校验；删除/覆写必须有范围限制',
    '4. 防火墙/站点/证书：破坏性操作需二次确认与回滚说明',
    '5. SQLite schema：改动必须幂等兼容存量数据库，新增列给默认值或允许 NULL',
    '6. 打包升级：版本号同步、原生模块 externals',
    '',
    '硬性要求：',
    '- 每个发现必须给证据：文件名 + 行号 + 引用代码说明为什么错',
    '- 分级：Important（数据丢失/命令注入/越权/锁死服务器）、Nit（最多 3 条）、Pre-existing（标注不阻塞）',
    '- 纯风格问题（引号、空行、命名偏好）一律不提',
    '- 输出使用中文 markdown，以「## AI 审查」开头'
  ].join('\n');

  const userContent = [
    '请审查以下 Pull Request。',
    '',
    '## PR 标题',
    prTitle,
    '',
    '## PR 描述',
    prBody,
    '',
    '## 审查章程（REVIEW.md）',
    charter,
    '',
    '## Diff',
    '```diff',
    diffText,
    '```'
  ].join('\n');

  // ---- 先占位评论（体现"审查进行中"，失败也有留痕） ----
  const placeholder = await ghRequest(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, 'POST', {
    body: '🤖 AI 审查进行中……'
  });
  const placeholderBody = await placeholder.json();
  const commentId = placeholderBody && placeholderBody.id;

  // ---- 调用 OpenAI 兼容接口（5 分钟超时），捕获状态码与错误体便于排障 ----
  let response;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), 300000);
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.2,
        max_tokens: 4000
      }),
      signal: timeoutCtrl.signal
    });
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? '请求超时（5 分钟无响应）'
      : (err && err.message) || 'network error';
    await ghRequest(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, 'POST', {
      body: `🤖 AI 审查：❌ 接口连接失败（\`${msg}\`），请确认自托管 runner 能访问 ${BASE_URL}`
    });
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = (await response.text()).slice(0, 300);
    console.error(`::error::AI 接口调用失败：HTTP ${response.status} — ${errText}（BASE_URL=${BASE_URL}, MODEL=${MODEL}）`);
    await ghRequest(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, 'POST', {
      body: `🤖 AI 审查：❌ 接口调用失败 HTTP \`${response.status}\`，请检查 AI_API_KEY / AI_BASE_URL / AI_MODEL 配置（详细错误见 Actions 日志）`
    });
    process.exit(1);
  }

  const data = await response.json();
  const review =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';

  // ---- 回填正式审查结果（直接编辑占位评论，省一次列表请求） ----
  const patchOrPost = (body) =>
    commentId
      ? ghRequest(`/repos/${REPO}/issues/comments/${commentId}`, 'PATCH', { body })
      : ghRequest(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, 'POST', { body });

  if (review && review.trim()) {
    await patchOrPost(review);
  } else {
    await patchOrPost('🤖 AI 审查：❌ 接口返回 200 但无审查内容，请确认 AI_MODEL 名称正确');
  }

  console.log('AI review posted.');
}

process.on('unhandledRejection', (err) => {
  console.error('::error::AI 审查脚本异常：' + (err && err.message ? err.message : err));
  process.exit(1);
});

main().catch((err) => {
  console.error('::error::AI 审查脚本异常：' + (err && err.message ? err.message : err));
  process.exit(1);
});
