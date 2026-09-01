/**
 * OpenAPI 3.0 文档骨架（1.4.0）
 *
 * 手工维护的核心端点文档，供 GET /api/openapi.json 输出与前端「API 文档」页渲染。
 * 覆盖主要业务域：认证、监控、容器、镜像、卷、网络、编排、计划任务、审批、系统管理。
 * 完整的请求/响应字段以各路由实现为准，此处提供对接所需的路径、方法、参数与鉴权骨架。
 */

export interface OpenApiOperation {
  summary: string;
  tags: string[];
  /** 是否需要在 Authorization 头携带 Bearer Token（默认 true） */
  auth?: boolean;
  queryParams?: Record<string, { description: string; required?: boolean; type?: string }>;
}

export interface OpenApiPath {
  [method: string]: OpenApiOperation;
}

const p = (
  summary: string,
  tags: string[],
  queryParams?: OpenApiOperation['queryParams'],
  auth = true,
): OpenApiOperation => ({ summary, tags, queryParams, auth });

/** 核心端点文档（按业务域分组） */
export const PATHS: Record<string, OpenApiPath> = {
  '认证 / 会话': {
    'POST /api/auth/login': p('登录，返回会话 Token；启用 2FA 时返回 totpRequired + ticket', ['认证'], {
      username: { description: '用户名', required: true },
      password: { description: '密码', required: true },
      ticket: { description: '2FA 第一步通过后的票据' },
      code: { description: '2FA 六位验证码' },
    }),
    'POST /api/auth/logout': p('登出并销毁当前会话', ['认证']),
    'GET /api/auth/me': p('当前登录用户信息（用户名 / 角色 / 权限列表）', ['认证']),
    'GET /api/auth/sessions': p('在线会话列表（管理员全局，其他用户仅自己）', ['认证']),
    'POST /api/auth/sessions/revoke': p('撤销会话（id 撤销单条，省略撤销除当前外全部）', ['认证'], {
      id: { description: '会话 ID（token 前 8 位）' },
      username: { description: '管理员批量撤销指定用户的全部会话' },
    }),
  },
  '监控': {
    'GET /api/monitor/current': p('当前主机监控快照（CPU / 内存 / 磁盘 / 网络 / 容器数）', ['监控']),
    'GET /api/monitor/history': p('短期内存历史（默认 10 分钟）', ['监控']),
    'GET /api/monitor/history/range': p(
      '指定范围历史趋势：7 天内为原始采样，30d/90d 为小时级聚合（保留 90 天）',
      ['监控'],
      { range: { description: '10m | 1h | 24h | 7d | 30d | 90d' } },
    ),
  },
  容器: {
    'GET /api/containers': p('容器列表', ['容器'], { all: { description: '是否包含已停止容器' } }),
    'GET /api/containers/:id/stats/history': p('容器资源历史曲线', ['容器'], {
      range: { description: '1h | 24h | 7d | 30d | 90d' },
    }),
    'DELETE /api/containers/:id': p('删除容器（开启审批流且无直接权限时转为 202 待审批）', ['容器'], {
      force: { description: '强制删除' },
      v: { description: '同时删除匿名卷' },
    }),
  },
  镜像: {
    'GET /api/images': p('镜像列表', ['镜像']),
    'POST /api/images/:name/scan': p('对镜像执行 Trivy 漏洞扫描（需本机安装 Trivy）', ['镜像']),
    'GET /api/images/vuln-history': p('漏洞扫描历史（全部或按镜像）', ['镜像'], {
      name: { description: '按镜像名过滤' },
      limit: { description: '返回条数上限（默认 50，最大 200）' },
    }),
    'GET /api/images/:name/save': p('导出镜像为 tar（docker save 流式下载）', ['镜像']),
  },
  '卷 / 网络': {
    'GET /api/volumes': p('卷列表', ['卷 / 网络']),
    'DELETE /api/volumes/:name': p('删除卷（可能触发审批）', ['卷 / 网络']),
    'GET /api/networks': p('网络列表', ['卷 / 网络']),
    'POST /api/networks/prune': p('清理未使用网络', ['卷 / 网络']),
  },
  编排: {
    'GET /api/compose/projects': p('compose 项目列表', ['编排']),
    'POST /api/compose/down': p('停止编排项目（可能触发审批）', ['编排']),
  },
  计划任务: {
    'GET /api/tasks': p('计划任务列表', ['计划任务']),
    'POST /api/tasks': p('新建计划任务（类型：prune / backup / pull / vulnScan 等）', ['计划任务']),
    'POST /api/tasks/:id/run': p('立即执行任务', ['计划任务']),
    'GET /api/tasks/:id/logs': p('任务执行历史', ['计划任务']),
  },
  审批: {
    'GET /api/approvals': p('审批列表（管理员全局，其他用户仅自己）', ['审批'], {
      status: { description: 'pending | approved | rejected | cancelled' },
    }),
    'POST /api/approvals/:id/approve': p('批准：多级链推进一级或终批执行（末级须管理员）', ['审批']),
    'POST /api/approvals/:id/reject': p('拒绝（理由必填）', ['审批']),
    'GET /api/approvals/stats': p('审批统计（近 N 天按状态 / 动作 / 提交人汇总）', ['审批'], {
      days: { description: '统计回溯天数（默认 30）' },
    }),
    'GET /api/approvals/export': p('导出审批记录 CSV', ['审批']),
  },
  系统管理: {
    'GET /api/system/users': p('用户列表（含按用户 IP 白名单）', ['系统管理']),
    'POST /api/system/users': p('新增用户', ['系统管理']),
    'GET /api/settings': p('系统参数列表（含分组与类型描述）', ['系统管理']),
    'PUT /api/settings': p('批量保存系统参数（body 为 key → value 对象）', ['系统管理']),
    'GET /api/system/totp/status': p('当前账号 2FA 启用状态', ['系统管理']),
    'POST /api/system/totp/setup': p('生成 2FA 密钥（Base32 + otpauth URI）', ['系统管理']),
    'GET /api/openapi.json': p('本 OpenAPI 文档', ['系统管理']),
  },
};

/** 汇总为 OpenAPI 3.0 文档对象 */
export function buildOpenApiDocument(baseUrl: string): Record<string, any> {
  const paths: Record<string, Record<string, any>> = {};
  for (const [, group] of Object.entries(PATHS)) {
    for (const [pathWithMethod, op] of Object.entries(group)) {
      const spaceIdx = pathWithMethod.indexOf(' ');
      const method = pathWithMethod.slice(0, spaceIdx).toLowerCase();
      const path = pathWithMethod.slice(spaceIdx + 1);
      paths[path] = paths[path] || {};
      paths[path][method] = {
        summary: op.summary,
        tags: op.tags,
        ...(op.queryParams
          ? {
              parameters: Object.entries(op.queryParams).map(([name, q]) => ({
                name,
                in: 'query',
                required: !!q.required,
                description: q.description,
                schema: { type: q.type || 'string' },
              })),
            }
          : {}),
        security: op.auth === false ? [] : [{ bearerAuth: [] }],
      };
    }
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Docker Manager API',
      description:
        'Docker 管理面板后端 API。除登录等少数端点外均需携带 `Authorization: Bearer <token>`；' +
        '开启审批流的高危操作在无直接权限时返回 202 + approvalPending。',
      version: '1.4.0',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque token' },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}
