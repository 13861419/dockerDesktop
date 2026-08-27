/**
 * AI 运维知识库模块（ai_knowledge 表）
 *
 * 双模式检索：
 *  - 优先：Ollama embedding 向量 + 余弦相似度（需配置本地 Ollama）
 *  - 回退：TF-IDF 关键词匹配（零依赖）
 */
import { getDb } from './storage';
import { ollamaEmbeddings } from './ollamaClient';

export interface KnowledgeEntry {
  id: number;
  title: string;
  category: string;
  content: string;
  tags: string[];
  owner: string;
  shared: boolean;
  createdAt: number;
  updatedAt: number;
}

const VALID_CATEGORIES = ['general', 'docker', 'compose', 'network', 'security', 'performance', 'troubleshoot', 'monitoring'];

/** Ollama embedding 模型名（轻量通用模型） */
const EMBEDDING_MODEL = 'nomic-embed-text';

/** 将 Float32Array 编码为 Buffer 存入 SQLite */
function embeddingToBuffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** 将 SQLite BLOB 解码为 Float32Array */
function bufferToEmbedding(buf: Buffer | null): number[] | null {
  if (!buf || buf.length === 0) return null;
  const vec: number[] = [];
  for (let i = 0; i + 3 < buf.length; i += 4) vec.push(buf.readFloatLE(i));
  return vec;
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function mapRow(r: any): KnowledgeEntry {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    content: r.content,
    tags: JSON.parse(r.tags || '[]'),
    owner: r.owner || '',
    shared: r.shared === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 尝试计算 Ollama embedding，失败返回 null（静默回退 TF-IDF）
 */
async function tryEmbedding(text: string): Promise<number[] | null> {
  try {
    const r = await ollamaEmbeddings(EMBEDDING_MODEL, text);
    return r.ok && r.embedding ? r.embedding : null;
  } catch {
    return null;
  }
}

/**
 * 新增知识条目（异步计算 embedding）
 */
export async function createKnowledge(title: string, category: string, content: string, tags: string[] = [], owner: string = '', shared: boolean = false): Promise<KnowledgeEntry> {
  const now = Date.now();
  const cat = VALID_CATEGORIES.includes(category) ? category : 'general';
  const d = getDb();
  // 异步计算 embedding（不阻塞主流程）
  const embedding = await tryEmbedding(`${title}\n${content}`);
  const embBuf = embedding ? embeddingToBuffer(embedding) : null;
  const info = d
    .prepare('INSERT INTO ai_knowledge (title, category, content, tags, embedding, owner, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(title, cat, content, JSON.stringify(tags), embBuf, owner, shared ? 1 : 0, now, now);
  return mapRow(d.prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(info.lastInsertRowid));
}

/**
 * 更新知识条目（重新计算 embedding）
 */
export async function updateKnowledge(id: number, fields: { title?: string; category?: string; content?: string; tags?: string[]; shared?: boolean }): Promise<KnowledgeEntry | null> {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(id) as any;
  if (!existing) return null;
  const title = fields.title ?? existing.title;
  const category = fields.category ? (VALID_CATEGORIES.includes(fields.category) ? fields.category : existing.category) : existing.category;
  const content = fields.content ?? existing.content;
  const tags = fields.tags ? JSON.stringify(fields.tags) : existing.tags;
  const shared = fields.shared !== undefined ? (fields.shared ? 1 : 0) : existing.shared;
  const now = Date.now();
  // 内容变更时重新计算 embedding
  const needReEmbed = fields.content || fields.title;
  let embBuf: Buffer | null = null;
  if (needReEmbed) {
    const embedding = await tryEmbedding(`${title}\n${content}`);
    embBuf = embedding ? embeddingToBuffer(embedding) : null;
  }
  if (embBuf) {
    d.prepare('UPDATE ai_knowledge SET title = ?, category = ?, content = ?, tags = ?, embedding = ?, shared = ?, updated_at = ? WHERE id = ?').run(title, category, content, tags, embBuf, shared, now, id);
  } else {
    d.prepare('UPDATE ai_knowledge SET title = ?, category = ?, content = ?, tags = ?, shared = ?, updated_at = ? WHERE id = ?').run(title, category, content, tags, shared, now, id);
  }
  return mapRow(d.prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(id));
}

/**
 * 删除知识条目
 */
export function deleteKnowledge(id: number): boolean {
  const info = getDb().prepare('DELETE FROM ai_knowledge WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * 获取单条知识
 */
export function getKnowledge(id: number): KnowledgeEntry | null {
  const row = getDb().prepare('SELECT * FROM ai_knowledge WHERE id = ?').get(id) as any;
  return row ? mapRow(row) : null;
}

/**
 * 列表查询（支持分类过滤 + 关键词搜索 + owner 过滤）
 */
export function listKnowledge(opts: { category?: string; keyword?: string; owner?: string; sharedOnly?: boolean; limit?: number; offset?: number } = {}): { items: KnowledgeEntry[]; total: number } {
  const d = getDb();
  const conditions: string[] = [];
  const params: any[] = [];
  if (opts.category) { conditions.push('category = ?'); params.push(opts.category); }
  if (opts.keyword) { conditions.push('(title LIKE ? OR content LIKE ?)'); params.push(`%${opts.keyword}%`, `%${opts.keyword}%`); }
  if (opts.owner) { conditions.push('owner = ?'); params.push(opts.owner); }
  if (opts.sharedOnly) { conditions.push('shared = 1'); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = (d.prepare(`SELECT COUNT(*) as c FROM ai_knowledge${where}`).get(...params) as any).c;
  const limit = opts.limit || 20;
  const offset = opts.offset || 0;
  const rows = d.prepare(`SELECT * FROM ai_knowledge${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
  return { items: rows.map(mapRow), total };
}

/**
 * 获取分类统计
 */
export function getKnowledgeStats(): Array<{ category: string; count: number }> {
  const rows = getDb().prepare('SELECT category, COUNT(*) as count FROM ai_knowledge GROUP BY category ORDER BY count DESC').all() as any[];
  return rows.map((r) => ({ category: r.category, count: r.count }));
}

/**
 * 搜索知识（优先 embedding 余弦相似度，回退 TF-IDF）
 * owner 参数：优先返回自己的知识，然后是 shared 知识
 */
export async function searchKnowledge(query: string, limit: number = 5, owner: string = ''): Promise<KnowledgeEntry[]> {
  const d = getDb();
  // 优先搜索自己的知识，然后是共享知识
  const allRows = owner
    ? d.prepare('SELECT * FROM ai_knowledge WHERE owner = ? OR shared = 1').all(owner) as any[]
    : d.prepare('SELECT * FROM ai_knowledge').all() as any[];
  if (!allRows.length) return [];

  // 1. 尝试 embedding 余弦相似度搜索
  const queryEmbedding = await tryEmbedding(query);
  if (queryEmbedding) {
    const scored = allRows.map((r) => {
      const emb = bufferToEmbedding(r.embedding);
      const score = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
      return { row: r, score };
    });
    const results = scored.filter((s) => s.score > 0.1).sort((a, b) => b.score - a.score).slice(0, limit);
    if (results.length > 0) return results.map((s) => mapRow(s.row));
    // embedding 搜索无结果时回退 TF-IDF
  }

  // 2. TF-IDF 回退
  return tfidfSearch(query, limit, allRows);
}

/**
 * TF-IDF 搜索（同步，作为 embedding 的回退）
 */
function tfidfSearch(query: string, limit: number, allRows: any[]): KnowledgeEntry[] {
  const tokenize = (text: string): string[] =>
    text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').split(/\s+/).filter(Boolean);

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const totalDocs = allRows.length;
  const docFreq = new Map<string, number>();
  const rowTokens = allRows.map((r) => {
    const tokens = tokenize(`${r.title} ${r.content} ${r.tags}`);
    const freq = new Map<string, number>();
    for (const t of tokens) { freq.set(t, (freq.get(t) || 0) + 1); }
    for (const t of new Set(tokens)) { docFreq.set(t, (docFreq.get(t) || 0) + 1); }
    return { row: r, freq };
  });

  const scored = rowTokens.map(({ row, freq }) => {
    let score = 0;
    for (const qt of queryTokens) {
      const tf = (freq.get(qt) || 0) / (freq.size || 1);
      const df = docFreq.get(qt) || 0;
      const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
      score += tf * idf;
    }
    return { row, score };
  });

  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => mapRow(s.row));
}

/** 预置 Docker 运维知识条目（用于自动初始化） */
const PRESET_KNOWLEDGE: Array<{ title: string; category: string; content: string; tags: string[] }> = [
  {
    title: 'Docker 常用命令速查',
    category: 'docker',
    content: `# Docker 常用命令

## 容器管理
- docker run -d --name myapp -p 8080:80 nginx  # 后台运行并映射端口
- docker ps                                     # 查看运行中容器
- docker ps -a                                  # 查看所有容器
- docker stop <container>                       # 停止容器
- docker start <container>                      # 启动已停止容器
- docker restart <container>                    # 重启容器
- docker rm -f <container>                      # 强制删除容器
- docker exec -it <container> /bin/bash         # 进入容器终端

## 镜像管理
- docker images                                 # 列出本地镜像
- docker pull <image>:<tag>                     # 拉取镜像
- docker build -t myimage:latest .              # 构建镜像
- docker rmi <image>                            # 删除镜像
- docker system prune -a                        # 清理未使用资源

## 网络
- docker network ls                             # 列出网络
- docker network create mynet                   # 创建自定义网络
- docker network connect mynet <container>      # 连接容器到网络

## 数据卷
- docker volume create myvol                    # 创建卷
- docker volume ls                              # 列出卷
- docker run -v myvol:/data <image>             # 挂载卷`,
    tags: ['docker', '命令', '速查', '容器', '镜像'],
  },
  {
    title: 'Docker Compose 最佳实践',
    category: 'compose',
    content: `# Docker Compose 最佳实践

## 项目结构
- 使用 .env 文件管理环境变量
- 为每个服务定义明确的 depends_on
- 使用 networks 实现服务间隔离
- 使用 volumes 实现数据持久化

## 生产环境建议
- 始终指定镜像版本号（避免 latest）
- 配置 healthcheck 确保服务可用
- 设置 restart: unless-stopped
- 限制资源（mem_limit, cpus）
- 使用 secrets 管理敏感信息

## 常用命令
- docker compose up -d          后台启动
- docker compose down           停止并移除
- docker compose logs -f        实时日志
- docker compose ps             查看状态
- docker compose exec <svc> sh  进入服务容器

## 网络配置
services:
  web:
    image: nginx
    networks:
      - frontend
  api:
    image: node:alpine
    networks:
      - frontend
      - backend
  db:
    image: postgres
    networks:
      - backend

networks:
  frontend:
  backend:`,
    tags: ['compose', 'docker-compose', '最佳实践', 'yml'],
  },
  {
    title: 'Docker 网络排障指南',
    category: 'network',
    content: `# Docker 网络排障指南

## 常见问题

### 1. 容器间无法通信
- 检查容器是否在同一网络：docker network inspect <network>
- 检查容器名是否正确（DNS 解析用容器名）
- 检查端口是否正确监听（docker exec 进去 curl 测试）

### 2. 端口映射不生效
- 检查 -p 格式：hostPort:containerPort
- 检查容器内服务是否监听 0.0.0.0（而非 127.0.0.1）
- 检查防火墙规则
- 检查云服务器安全组

### 3. DNS 解析失败
- docker exec <container> cat /etc/resolv.conf
- 尝试 --dns 8.8.8.8 指定 DNS
- 检查 Docker daemon 的 DNS 配置

### 4. 宿主机无法访问容器
- 检查端口映射：docker port <container>
- 检查容器内服务是否启动
- 检查宿主机防火墙
- Linux: iptables -L -n 检查规则

## 调试命令
docker network inspect <network>     查看网络详情
docker logs <container>              查看容器日志
docker exec <container> ping <target>  网络连通性测试
docker exec <container> netstat -tlnp  端口监听检查`,
    tags: ['网络', '排障', '故障', 'DNS', '端口'],
  },
  {
    title: 'Docker 安全加固清单',
    category: 'security',
    content: `# Docker 安全加固清单

## 镜像安全
- 使用官方镜像或可信来源
- 固定镜像版本号（不使用 latest）
- 定期更新基础镜像修复 CVE
- 使用多阶段构建减小攻击面
- 扫描漏洞：docker scout cves <image>

## 容器运行时
- 不以 root 运行：USER nonroot:nonroot
- 只读文件系统：--read-only
- 限制资源：--memory, --cpus
- 禁用特权模式
- 使用 seccomp/AppArmor 配置文件

## 网络安全
- 不使用 --net=host
- 仅暴露必要端口
- 使用自定义网络隔离服务
- 不在容器中存储敏感信息

## 密钥管理
- 使用 Docker Secrets（Swarm）
- 使用 .env 文件 + .gitignore
- 不在 Dockerfile 中硬编码密码
- 运行时挂载 secrets：docker run --secret mysecret

## 日志审计
- 启用 Docker 事件日志
- 监控异常容器行为
- 定期审查容器权限`,
    tags: ['安全', '加固', '清单', '漏洞', '密钥'],
  },
  {
    title: 'Docker 性能优化技巧',
    category: 'performance',
    content: `# Docker 性能优化技巧

## 镜像优化
- 使用 alpine 基础镜像（体积小）
- 多阶段构建分离编译和运行环境
- 合并 RUN 指令减少层数
- 使用 .dockerignore 排除无关文件
- 清理缓存：rm -rf /var/cache/apk/*

## 容器性能
- 使用 overlay2 存储驱动
- 合理设置内存限制避免 OOM
- 使用 tmpfs 挂载临时目录
- 避免在容器中存储状态
- 使用 Docker volumes 而非 bind mounts（性能更好）

## 构建优化
- 利用构建缓存：先复制 package.json 等依赖文件
- 使用 BuildKit：DOCKER_BUILDKIT=1
- 并行构建无依赖的服务
- 缓存 npm/pip 等包管理器缓存

## 监控
docker stats                     实时资源监控
docker system df                 磁盘使用情况
docker inspect <container>       详细配置
docker events                    实时事件流`,
    tags: ['性能', '优化', 'alpine', '构建', '监控'],
  },
];

/**
 * 自动初始化预置知识库（仅当知识库为空时执行）
 */
export function autoInitKnowledge(username: string): number {
  const { total } = listKnowledge({ limit: 1 });
  if (total > 0) return 0;
  let count = 0;
  for (const item of PRESET_KNOWLEDGE) {
    try {
      createKnowledge(item.title, item.category, item.content, item.tags);
      count++;
    } catch { /* 忽略写入失败 */ }
  }
  return count;
}
