/**
 * 本地 mock Docker Hub 搜索服务（用于回归测试）
 *
 * 镜像中心 /hub 的搜索依赖外部 Docker Hub / 镜像加速源，在受限测试网络下
 * 全部候选源均不可达（DNS 失败 / 403 / 404 / 超时或返回非法结构），导致搜索
 * 始终 502。本项目提供本 mock 服务，模拟 Docker Hub 开放搜索接口，使回归可以
 * 稳定走到「搜索成功 → 渲染结果」与「空态」两条真实路径，不再受外网影响。
 *
 * 对齐 server/src/hubConfig.ts::searchHubRepos() 的解析约定：
 *  - registry 协议：GET {base}/v2/search?term=xxx     → { num_results, results: [...] }
 *  - web 协议：    GET {base}/v2/search/repositories/?query=xxx → { count, results: [...] }
 *  - 结果条目需满足 toHubResult() 消费的字段（repo_name/name、description 等）。
 *
 * 启动：
 *   node scripts/mock-hub-search.js [port]
 * 默认端口 9530；可通过环境变量 MOCK_HUB_PORT 覆盖。
 * 通过 POST /api/hub/search-source 将本服务基址配置为自定义搜索源后生效。
 */
const http = require('http');

const PORT = Number(process.env.MOCK_HUB_PORT || process.argv[2] || 9530);

/** 预置的镜像仓库样本（字段与 HubSearchResult 一致） */
const REPOS = [
  { repo_name: 'library/nginx', name: 'nginx', description: 'Nginx 官方镜像', star_count: 20000, pull_count: 1000000000, last_updated: '2025-01-01T00:00:00Z', is_official: true },
  { repo_name: 'library/redis', name: 'redis', description: 'Redis 官方镜像', star_count: 15000, pull_count: 900000000, last_updated: '2025-01-02T00:00:00Z', is_official: true },
  { repo_name: 'library/mysql', name: 'mysql', description: 'MySQL 官方镜像', star_count: 18000, pull_count: 800000000, last_updated: '2025-01-03T00:00:00Z', is_official: true },
  { repo_name: 'library/postgres', name: 'postgres', description: 'PostgreSQL 官方镜像', star_count: 12000, pull_count: 700000000, last_updated: '2025-01-04T00:00:00Z', is_official: true },
  { repo_name: 'library/alpine', name: 'alpine', description: 'Alpine Linux 官方镜像', star_count: 10000, pull_count: 600000000, last_updated: '2025-01-05T00:00:00Z', is_official: true },
  { repo_name: 'library/mongo', name: 'mongo', description: 'MongoDB 官方镜像', star_count: 9000, pull_count: 500000000, last_updated: '2025-01-06T00:00:00Z', is_official: true },
  { repo_name: 'nginxinc/nginx-unprivileged', name: 'nginx-unprivileged', description: '非特权 Nginx', star_count: 2000, pull_count: 50000000, last_updated: '2025-02-01T00:00:00Z', is_official: false },
];

/**
 * 依据关键字过滤内置样本（小写包含匹配，忽略命名空间）
 * @param {string} term 搜索关键字
 * @returns {Array} 匹配的结果条目
 */
function filterRepos(term) {
  const kw = String(term || '').trim().toLowerCase();
  if (!kw) return REPOS;
  return REPOS.filter((r) => r.name.toLowerCase().includes(kw));
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://127.0.0.1:${PORT}`);
  res.setHeader('Content-Type', 'application/json');

  // registry 传统搜索协议
  if (pathname === '/v2/search') {
    const term = searchParams.get('term') || '';
    const results = filterRepos(term);
    res.end(JSON.stringify({ num_results: results.length, query: term, results }));
    return;
  }

  // Docker Hub web 搜索协议
  if (pathname === '/v2/search/repositories/') {
    const query = searchParams.get('query') || '';
    const results = filterRepos(query);
    res.end(JSON.stringify({ count: results.length, next: null, previous: null, query, results }));
    return;
  }

  // 其余路径返回 404，让 searchHubRepos 按预期丢弃该候选
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  // 明确只监听回环地址，避免暴露到局域网
  console.log(`mock-hub-search listening on http://127.0.0.1:${PORT}`);
});
