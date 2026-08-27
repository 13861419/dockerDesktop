/**
 * AI 文件分析模块
 *
 * 支持 Dockerfile / Compose / 日志 / 配置文件 / 纯文本的分析。
 * - Dockerfile 先经过本地规则引擎（评分 + 问题列表），再交由 AI 补充优化建议。
 * - 其他类型直接交由 AI 分析。
 */
import { chatCompletion, AiConfig } from './aiClient';

/** 文件大小上限（字符），超出截断 */
export const MAX_FILE_CHARS = 50000;

/** 允许的文件类型 */
export type AnalyzeFileType = 'dockerfile' | 'compose' | 'log' | 'config' | 'text';

export interface FileAnalyzeInput {
  filename: string;
  type: string;
  content: string;
}

export interface AnalysisIssue {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  line?: number;
}

export interface AnalysisResult {
  fileType: AnalyzeFileType;
  score: { security: number; performance: number; maintainability: number };
  issues: AnalysisIssue[];
  suggestions: string;
}

/**
 * 根据文件名与内容推断文件类型
 */
export function detectFileType(filename: string, content: string): AnalyzeFileType {
  const name = filename.toLowerCase();
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'dockerfile';
  if (name === 'docker-compose.yml' || name === 'docker-compose.yaml' || name.endsWith('compose.yml') || name.endsWith('compose.yaml')) return 'compose';
  if (name.endsWith('.log') || name.endsWith('.txt')) {
    // 日志文件特征：时间戳行
    const head = content.slice(0, 2000);
    if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(head) || /^\d{2}:\d{2}:\d{2}/.test(head)) return 'log';
    return 'text';
  }
  if (name.endsWith('.yml') || name.endsWith('.yaml') || name.endsWith('.json') || name.endsWith('.conf') || name.endsWith('.ini') || name.endsWith('.toml')) return 'config';
  return 'text';
}

/**
 * Dockerfile 本地规则引擎
 */
export function analyzeDockerfileRules(content: string): AnalysisIssue[] {
  const lines = content.split('\n');
  const issues: AnalysisIssue[] = [];
  const inMultiStage = /FROM\s+.+AS\s+\w+/i.test(content);
  let usesUser = false;

  const scanLine = (i: number): void => {
    const lineNo = i + 1;
    const line = lines[i];

    // 基础镜像用 latest
    const fromMatch = /^FROM\s+(.+)$/im.exec(line);
    if (fromMatch && /:\s*latest\s*$/i.test(fromMatch[1])) {
      issues.push({ severity: 'warning', message: `第${lineNo}行：基础镜像使用 latest 标签，不可复现，建议固定版本`, line: lineNo });
    }

    // USER 指令
    if (/^USER\s+\w+/i.test(line)) usesUser = true;

    // ENV 中的敏感信息
    if (/^\s*ENV\s+(\w*PASS|TOKEN|SECRET|API_KEY|KEY)=/i.test(line)) {
      issues.push({ severity: 'critical', message: `第${lineNo}行：ENV 中可能含敏感信息，构建产物会暴露，建议使用构建 secret`, line: lineNo });
    }

    // RUN 中硬编码端口/证书等
    if (/^\s*ADD\s+.*https?:\/\//i.test(line)) {
      issues.push({ severity: 'info', message: `第${lineNo}行：使用 ADD 从 URL 下载，建议改用 RUN curl 配合校验`, line: lineNo });
    }

    // EXPOSE 但没有 HEALTHCHECK（另统计）
    // 同时使用 RUN + ENV 密钥
    if (/^\s*RUN\s+/i.test(line) && /\b(password|token|secret)\b/i.test(line)) {
      issues.push({ severity: 'warning', message: `第${lineNo}行：RUN 命令中疑似包含密钥`, line: lineNo });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // 跳过 FROM 行（用正则单独处理 latest）
    if (/^FROM/i.test(trimmed)) continue;
    scanLine(i);
  }

  // 多阶段但不使用 USER
  if (inMultiStage && !usesUser) {
    issues.push({ severity: 'warning', message: '多阶段构建未使用 USER 指令，最终运行仍以 root 执行，建议添加非 root 用户', line: undefined });
  }
  if (!usesUser && !inMultiStage) {
    issues.push({ severity: 'warning', message: '未使用 USER 指令，容器默认以 root 运行，存在安全风险', line: undefined });
  }

  // HEALTHCHECK
  if (!/^\s*HEALTHCHECK/im.test(content)) {
    issues.push({ severity: 'info', message: '未定义 HEALTHCHECK，生产环境建议添加', line: undefined });
  }

  return issues;
}

/**
 * 计算基于问题的评分（0-10）
 */
function scoreFromIssues(issues: AnalysisIssue[]): { security: number; performance: number; maintainability: number } {
  let security = 10;
  let performance = 10;
  let maintainability = 10;
  for (const it of issues) {
    const penalty = it.severity === 'critical' ? 2 : it.severity === 'warning' ? 1 : 0.5;
    const msg = it.message;
    if (/敏感|密钥|root|USER|latest/.test(msg)) security = Math.max(0, security - penalty);
    if (/健康|HEALTHCHECK|多阶段/.test(msg)) maintainability = Math.max(0, maintainability - penalty * 0.5);
    if (/latest|性能/.test(msg)) performance = Math.max(0, performance - penalty);
  }
  return {
    security: Math.round(security * 10) / 10,
    performance: Math.round(performance * 10) / 10,
    maintainability: Math.round(maintainability * 10) / 10,
  };
}

/**
 * 构建分析 prompt
 */
export function buildAnalyzePrompt(filename: string, type: AnalyzeFileType, content: string): string {
  const typeLabel: Record<AnalyzeFileType, string> = {
    dockerfile: 'Dockerfile',
    compose: 'Docker Compose 文件',
    log: '日志文件',
    config: '配置文件',
    text: '文本文件',
  };
  return `请分析以下${typeLabel[type]}文件（文件名：${filename}），并给出评估。

要求：
1. 指出存在的问题（安全、性能、可维护性）
2. 对安全/性能/可维护性分别按 0-10 打分
3. 给出可操作的具体优化建议
4. 语言使用与文件内容相同的语言（通常为中文）

文件内容如下：
\`\`\`
${content}
\`\`\`

请用简洁的结构化方式回答，先给评分，再列问题，最后给建议。`;
}

/**
 * 综合分析入口
 * @param cfg AI 配置
 * @param input 文件输入
 * @returns 结构化分析结果
 */
export async function analyzeFile(cfg: AiConfig, input: FileAnalyzeInput): Promise<AnalysisResult> {
  const content = input.content.length > MAX_FILE_CHARS ? input.content.slice(0, MAX_FILE_CHARS) + '\n...[内容过长已截断]' : input.content;
  const fileType = input.type ? (input.type as AnalyzeFileType) : detectFileType(input.filename, content);

  let issues: AnalysisIssue[] = [];
  if (fileType === 'dockerfile') {
    issues = analyzeDockerfileRules(content);
  }

  const prompt = buildAnalyzePrompt(input.filename, fileType, content);
  const suggestions = await chatCompletion(cfg, [
    { role: 'system', content: '你是 Docker 运维专家，擅长分析配置文件并给出专业建议。回答简洁、准确、可操作。' },
    { role: 'user', content: prompt },
  ]);

  const score = scoreFromIssues(issues);
  return { fileType, score, issues, suggestions };
}
