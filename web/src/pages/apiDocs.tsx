/**
 * API 文档页（1.4.0）
 *
 * 拉取 GET /api/openapi.json 并按业务域分组渲染端点骨架：
 * 方法徽标 / 路径 / 说明 / 查询参数。支持关键字搜索。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import { Input } from '../components/Form';
import { get } from '../api/client';
import { useToast } from '../components/Toast';
import { useLang } from '../i18n';
import './apiDocs.less';

interface OpenApiOperation {
  summary: string;
  tags: string[];
  parameters?: Array<{ name: string; in: string; required: boolean; description: string }>;
  security?: unknown[];
}

interface OpenApiDoc {
  info: { title: string; description: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

/** 方法 → 徽标配色 */
const METHOD_COLORS: Record<string, string> = {
  get: '#3b82f6',
  post: '#22c55e',
  put: '#eab308',
  delete: '#ef4444',
};

export default function ApiDocsPage() {
  const { t } = useLang();
  const { showToast } = useToast();
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDoc(await get<OpenApiDoc>('/api/openapi.json'));
    } catch (e: any) {
      showToast(e?.message || t('加载 API 文档失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 按业务域分组并过滤 */
  const groups = useMemo(() => {
    if (!doc) return [];
    const kw = keyword.trim().toLowerCase();
    const byTag = new Map<string, Array<{ method: string; path: string; op: OpenApiOperation }>>();
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const hit =
          !kw ||
          path.toLowerCase().includes(kw) ||
          op.summary.toLowerCase().includes(kw) ||
          op.tags.join(' ').toLowerCase().includes(kw);
        if (!hit) continue;
        for (const tag of op.tags || ['其他']) {
          if (!byTag.has(tag)) byTag.set(tag, []);
          byTag.get(tag)!.push({ method, path, op });
        }
      }
    }
    return [...byTag.entries()].map(([tag, list]) => ({ tag, list }));
  }, [doc, keyword]);

  return (
    <div className="page api-docs">
      <p className="page__desc">
        {t('面板后端 OpenAPI 3.0 接口骨架，可用于二次开发与自动化对接（完整字段以路由实现为准）。')}
      </p>

      <Card title={doc ? `${doc.info.title} · v${doc.info.version}` : t('API 文档')}>
        <div className="api-docs__search">
          <Input
            type="text"
            value={keyword}
            placeholder={t('搜索路径 / 说明 / 分组')}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKeyword(e.target.value)}
          />
        </div>
        {loading && !doc ? (
          <div className="api-docs__empty">{t('加载中…')}</div>
        ) : (
          groups.map(({ tag, list }) => (
            <div key={tag} className="api-docs__group">
              <div className="api-docs__tag">{t(tag)}</div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: '9%' }}>{t('方法')}</th>
                    <th style={{ width: '38%' }}>{t('路径')}</th>
                    <th>{t('说明')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(({ method, path, op }) => (
                    <tr key={method + path}>
                      <td>
                        <span className="api-docs__method" style={{ background: METHOD_COLORS[method] || '#6b7280' }}>
                          {method.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <code>{path}</code>
                      </td>
                      <td>
                        {op.summary}
                        {op.parameters && op.parameters.length > 0 && (
                          <div className="api-docs__params">
                            {op.parameters.map((pr) => (
                              <span key={pr.name} className="api-docs__param">
                                {pr.name}
                                {pr.required ? '*' : ''}（{pr.description}）
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
        {!loading && doc && groups.length === 0 && <div className="api-docs__empty">{t('无匹配的端点')}</div>}
      </Card>
    </div>
  );
}
