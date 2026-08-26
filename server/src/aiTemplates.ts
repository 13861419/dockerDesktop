/**
 * AI Prompt 模板模块（ai_prompt_templates 表）
 *
 * 提供预置运维模板 + 用户自定义模板的 CRUD。
 * 零依赖，通过 getDb() 访问 SQLite。
 */
import { getDb } from './storage';

export interface AiPromptTemplate {
  id: number;
  name: string;
  category: string;
  prompt: string;
  isSystem: boolean;
  username: string;
  createdAt: number;
  updatedAt: number;
}

interface TemplateRow {
  id: number;
  name: string;
  category: string;
  prompt: string;
  is_system: number;
  username: string;
  created_at: number;
  updated_at: number;
}

function mapRow(r: TemplateRow): AiPromptTemplate {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    prompt: r.prompt,
    isSystem: r.is_system === 1,
    username: r.username,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ========== 预置模板 ==========

const PRESET_TEMPLATES: Array<{ name: string; category: string; prompt: string }> = [
  {
    name: '生成 Dockerfile',
    category: '容器化',
    prompt: '请为我的项目生成一个优化的 Dockerfile。要求：\n1. 多阶段构建（如适用）\n2. 合理的层缓存策略\n3. 非 root 用户运行\n4. 健康检查配置\n5. 适合生产环境\n\n请先告诉我项目使用的技术栈和主要依赖。',
  },
  {
    name: 'Docker Compose 生成',
    category: '容器化',
    prompt: '请帮我生成 docker-compose.yml 配置。要求：\n1. 服务间网络隔离\n2. 健康检查\n3. 重启策略\n4. 资源限制\n5. 环境变量管理\n\n请先告诉我需要哪些服务及其依赖关系。',
  },
  {
    name: '容器安全审计',
    category: '安全',
    prompt: '请对当前运行的容器进行安全审计检查，重点关注：\n1. 是否以 root 用户运行\n2. 挂载的敏感目录\n3. 开放的端口是否必要\n4. 环境变量中是否有明文密码\n5. 镜像版本是否过旧\n6. 网络暴露面\n\n请列出发现的问题并给出修复建议。',
  },
  {
    name: '镜像安全扫描',
    category: '安全',
    prompt: '请帮我扫描 Docker 镜像的安全漏洞。要求：\n1. 检查已知 CVE 漏洞\n2. 检查基础镜像是否过期\n3. 检查不必要的包安装\n4. 检查 SUID/SGID 文件\n5. 检查敏感文件暴露\n\n请对指定镜像执行安全分析。',
  },
  {
    name: '性能优化分析',
    category: '性能',
    prompt: '请帮我分析当前 Docker 环境的性能瓶颈：\n1. 容器资源使用情况（CPU/内存/磁盘）\n2. 网络 I/O 状况\n3. 存储卷性能\n4. 容器启动时间\n5. 镜像大小优化空间\n\n请给出具体的优化建议和优先级排序。',
  },
  {
    name: '日志分析',
    category: '运维',
    prompt: '请帮我分析容器日志，找出：\n1. 错误和异常模式\n2. 性能警告\n3. 安全相关事件\n4. 资源耗尽迹象\n5. 异常访问模式\n\n请按严重程度排序并给出处理建议。',
  },
  {
    name: '网络诊断',
    category: '运维',
    prompt: '请帮我诊断 Docker 网络问题：\n1. 容器间连通性\n2. DNS 解析是否正常\n3. 端口映射是否正确\n4. 防火墙规则是否阻断\n5. 网络模式选择是否合适\n\n请提供诊断步骤和修复方案。',
  },
  {
    name: '数据备份策略',
    category: '运维',
    prompt: '请帮我制定 Docker 数据备份策略：\n1. 需要备份的数据类型（容器、卷、配置）\n2. 备份频率和保留策略\n3. 备份验证方法\n4. 恢复流程\n5. 异地备份方案\n\n请给出具体的备份脚本和执行计划。',
  },
  {
    name: '监控告警配置',
    category: '运维',
    prompt: '请帮我配置 Docker 监控告警：\n1. 容器健康状态监控\n2. 资源使用阈值告警\n3. 服务可用性检测\n4. 异常重启检测\n5. 磁盘空间预警\n\n请推荐适合的监控方案和配置。',
  },
  {
    name: '容器化迁移方案',
    category: '迁移',
    prompt: '请帮我规划应用容器化迁移：\n1. 现有架构分析\n2. 容器化可行性评估\n3. 迁移步骤和优先级\n4. 数据迁移策略\n5. 回滚方案\n6. 性能对比验证\n\n请先了解我当前的部署方式。',
  },
];

/** 初始化预置模板（幂等：已存在则跳过） */
function ensurePresetTemplates(): void {
  const d = getDb();
  const now = Date.now();
  const existing = d.prepare('SELECT name FROM ai_prompt_templates WHERE is_system = 1').all() as { name: string }[];
  const existSet = new Set(existing.map((r) => r.name));
  const ins = d.prepare('INSERT INTO ai_prompt_templates (name, category, prompt, is_system, username, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)');
  for (const t of PRESET_TEMPLATES) {
    if (!existSet.has(t.name)) {
      ins.run(t.name, t.category, t.prompt, 'system', now, now);
    }
  }
}

// ========== CRUD ==========

/** 列出模板（可选按分类过滤，包含预置 + 当前用户自定义） */
export function listTemplates(category?: string, username?: string): AiPromptTemplate[] {
  ensurePresetTemplates();
  const d = getDb();
  let sql = 'SELECT * FROM ai_prompt_templates WHERE (is_system = 1';
  const params: any[] = [];
  if (username) {
    sql += ' OR username = ?';
    params.push(username);
  }
  sql += ')';
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY is_system DESC, category ASC, name ASC';
  return (d.prepare(sql).all(...params) as unknown as TemplateRow[]).map(mapRow);
}

/** 获取单个模板 */
export function getTemplate(id: number): AiPromptTemplate | null {
  const row = getDb().prepare('SELECT * FROM ai_prompt_templates WHERE id = ?').get(id) as TemplateRow | undefined;
  return row ? mapRow(row) : null;
}

/** 获取所有分类 */
export function listTemplateCategories(): string[] {
  ensurePresetTemplates();
  const rows = getDb().prepare('SELECT DISTINCT category FROM ai_prompt_templates ORDER BY category ASC').all() as { category: string }[];
  return rows.map((r) => r.category);
}

/** 创建用户自定义模板 */
export function createTemplate(input: { name: string; category?: string; prompt: string; username: string }): AiPromptTemplate {
  const now = Date.now();
  const d = getDb();
  const r = d.prepare('INSERT INTO ai_prompt_templates (name, category, prompt, is_system, username, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)').run(
    input.name,
    input.category || '自定义',
    input.prompt,
    input.username,
    now,
    now,
  );
  return getTemplate(Number(r.lastInsertRowid))!;
}

/** 更新用户自定义模板（预置模板不可修改） */
export function updateTemplate(id: number, input: { name?: string; category?: string; prompt?: string }, username?: string): AiPromptTemplate | null {
  const existing = getTemplate(id);
  if (!existing || existing.isSystem) return null;
  if (username && existing.username !== username) return null; // 只能改自己的
  const d = getDb();
  const fields: string[] = [];
  const vals: any[] = [];
  if (input.name !== undefined) { fields.push('name = ?'); vals.push(input.name); }
  if (input.category !== undefined) { fields.push('category = ?'); vals.push(input.category); }
  if (input.prompt !== undefined) { fields.push('prompt = ?'); vals.push(input.prompt); }
  if (fields.length === 0) return existing;
  fields.push('updated_at = ?');
  vals.push(Date.now());
  vals.push(id);
  d.prepare(`UPDATE ai_prompt_templates SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getTemplate(id);
}

/** 删除模板（预置模板不可删除，只能删自己的） */
export function deleteTemplate(id: number, username?: string): boolean {
  const existing = getTemplate(id);
  if (!existing || existing.isSystem) return false;
  if (username && existing.username !== username) return false;
  const r = getDb().prepare('DELETE FROM ai_prompt_templates WHERE id = ?').run(id);
  return r.changes > 0;
}
