/**
 * 镜像中心页
 *
 * 浏览 Docker Hub 上的镜像仓库：支持搜索、查看每个镜像的标签列表并拉取镜像。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import { Field, Input, Select } from '../components/Form';
import Empty from '../components/Empty';
import ConfirmDialog from '../components/ConfirmDialog';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import './hub.less';

/** 镜像源条目 */
interface HubSource {
  id: string;
  host: string;
  name?: string;
  builtin?: boolean;
  enabled?: boolean;
}

/** Docker Hub 搜索结果中的单个仓库 */
interface HubRepo {
  name: string;
  full_name: string;
  description: string;
  star_count: number;
  pull_count: number;
  last_updated: string;
  is_official: boolean;
}

/** 仓库标签列表中的单个标签 */
interface HubTag {
  name: string;
  size: number;
  last_updated: string;
  digest: string;
}

/**
 * 常用镜像快捷列表：在国内网络下在线搜索不可用时，
 * 可直接点选这些常见镜像通过镜像源拉取，无需搜索。
 */
const COMMON_REPOS: Array<{ name: string; desc: string }> = [
  { name: 'nginx', desc: 'HTTP 与反向代理服务器' },
  { name: 'redis', desc: '开源内存数据库' },
  { name: 'mysql', desc: 'MySQL 关系型数据库' },
  { name: 'mysql:8', desc: 'MySQL 8 关系型数据库' },
  { name: 'postgres', desc: 'PostgreSQL 数据库' },
  { name: 'mongo', desc: 'MongoDB 文档数据库' },
  { name: 'rabbitmq', desc: 'RabbitMQ 消息队列' },
  { name: 'busybox', desc: '精简 Linux 工具集合' },
  { name: 'alpine', desc: '轻量 Linux 发行版' },
  { name: 'ubuntu', desc: 'Ubuntu 发行版' },
  { name: 'node', desc: 'Node.js 运行时' },
  { name: 'python', desc: 'Python 运行时' },
  { name: 'portainer/portainer-ce', desc: 'Docker 可视化管理工具' },
  { name: 'gitlab/gitlab-ce', desc: 'GitLab 代码托管' },
  { name: 'nextcloud', desc: '私有云盘' },
  { name: 'wordpress', desc: '博客内容管理系统' },
  { name: 'mariadb', desc: 'MariaDB 数据库' },
  { name: 'elasticsearch', desc: 'Elasticsearch 搜索引擎' },
  { name: 'prom/prometheus', desc: 'Prometheus 监控系统' },
  { name: 'grafana/grafana', desc: 'Grafana 可视化面板' },
];

/** 默认搜索关键字 */
const DEFAULT_QUERY = 'nginx';

/**
 * 将 ISO 时间字符串格式化为本地可读时间
 * @param iso ISO8601 时间字符串
 */
function formatDate(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 将数字格式化为可读的千分位/缩写
 * @param n 数值
 */
function formatCount(n: number): string {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/**
 * 镜像中心页组件
 */
export default function HubPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  // 搜索输入框内容
  const [queryInput, setQueryInput] = useState(DEFAULT_QUERY);
  // 当前提交的搜索关键字
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [results, setResults] = useState<HubRepo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 搜索加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState(1);
  // 当前展开的仓库（用完整名标识，如 library/nginx）
  const [expanded, setExpanded] = useState<string | null>(null);
  // 展开仓库的标签列表
  const [tags, setTags] = useState<HubTag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  // 待拉取的仓库（用于标签选择弹窗）
  const [pullTarget, setPullTarget] = useState<HubRepo | null>(null);
  // 弹窗中选中的标签
  const [pullTag, setPullTag] = useState('latest');
  // 拉取弹窗中选中的镜像源（''=官方 Docker Hub）
  const [pullSource, setPullSource] = useState('');
  // 常用镜像拉取中正在拉取的名字（null 表示无）
  const [pullingCommon, setPullingCommon] = useState<string | null>(null);
  // 拉取是否进行中
  const [pulling, setPulling] = useState(false);
  // 镜像源列表与配置弹窗
  const [sources, setSources] = useState<HubSource[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // 自定义搜索源基址（可选，国内镜像站普遍不支持搜索时手动填写可用源）
  const [searchSource, setSearchSource] = useState('');
  const [newSourceHost, setNewSourceHost] = useState('');
  const [newSourceName, setNewSourceName] = useState('');
  const [savingSource, setSavingSource] = useState(false);
  // 待确认删除的镜像源 id
  const [deleteSourceId, setDeleteSourceId] = useState<string | null>(null);

  /**
   * 加载已配置的镜像源列表，并选定当前默认源（首个启用的源）
   */
  const loadSources = useCallback(async () => {
    try {
      const data = await get<{ sources: HubSource[] }>('/api/hub/sources');
      const list = data?.sources || [];
      setSources(list);
      // 启用镜像源中第一个作为默认拉取源
      const enabled = list.find((s) => s.enabled);
      setPullSource((prev) => (prev === '' ? (enabled ? enabled.host : '') : prev));
    } catch {
      setSources([]);
    }
    // 单独加载自定义搜索源
    try {
      const ss = await get<{ host: string }>('/api/hub/search-source');
      setSearchSource(ss?.host || '');
    } catch {
      setSearchSource('');
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  /**
   * 新增镜像源
   */
  const handleAddSource = useCallback(async () => {
    const host = newSourceHost.trim();
    if (!host) {
      showToast('请输入镜像源地址', 'error');
      return;
    }
    setSavingSource(true);
    try {
      await post('/api/hub/sources', { host, name: newSourceName.trim() || undefined });
      showToast('镜像源已添加');
      setNewSourceHost('');
      setNewSourceName('');
      await loadSources();
    } catch (e: any) {
      showToast(e?.message || '添加镜像源失败', 'error');
    } finally {
      setSavingSource(false);
    }
  }, [newSourceHost, newSourceName, loadSources, showToast]);

  /**
   * 保存自定义搜索源基址
   */
  const handleSaveSearchSource = useCallback(async () => {
    try {
      await post('/api/hub/search-source', { host: searchSource.trim() });
      showToast('搜索源已保存');
    } catch (e: any) {
      showToast(e?.message || '保存搜索源失败', 'error');
    }
  }, [searchSource, showToast]);

  /**
   * 删除自定义镜像源
   */
  const confirmDeleteSource = useCallback(async () => {
    if (!deleteSourceId) return;
    try {
      await del(`/api/hub/sources/${encodeURIComponent(deleteSourceId)}`);
      showToast('镜像源已删除');
      setDeleteSourceId(null);
      await loadSources();
    } catch (e: any) {
      showToast(e?.message || '删除镜像源失败', 'error');
    }
  }, [deleteSourceId, loadSources, showToast]);

  /**
   * 切换镜像源启用/停用状态
   * @param s 目标镜像源
   */
  const toggleSourceEnabled = useCallback(
    async (s: HubSource) => {
      try {
        await post(`/api/hub/sources/${encodeURIComponent(s.id)}/enabled`, {
          enabled: !s.enabled,
        });
        await loadSources();
      } catch (e: any) {
        showToast(e?.message || '操作失败', 'error');
      }
    },
    [loadSources, showToast]
  );

  /**
   * 执行搜索（重新从第一页开始）
   * @param q 搜索关键字
   */
  const doSearch = useCallback(
    async (q: string) => {
      const kw = q.trim();
      if (!kw) {
        showToast('请输入镜像名称', 'error');
        return;
      }
      setLoading(true);
      setExpanded(null);
      setLoadError('');
      try {
        const data = await get<{ results: HubRepo[]; total: number }>(
          '/api/hub/search?q=' + encodeURIComponent(kw) + '&page=1'
        );
        setResults(data?.results || []);
        setTotal(data?.total || 0);
        setPage(1);
      } catch (e: any) {
        setLoadError(e?.message || '搜索失败');
        showToast(e?.message || '搜索失败', 'error');
        setResults([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  // 首次进入默认搜索一次
  useEffect(() => {
    doSearch(DEFAULT_QUERY);
  }, [doSearch]);

  /**
   * 提交搜索（表单提交 / 回车）
   */
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setQuery(queryInput);
    doSearch(queryInput);
  };

  /**
   * 加载更多结果（下一页）
   */
  const loadMore = useCallback(async () => {
    const next = page + 1;
    setLoading(true);
    try {
      const data = await get<{ results: HubRepo[]; total: number }>(
        '/api/hub/search?q=' + encodeURIComponent(query) + '&page=' + next
      );
      setResults((prev) => [...prev, ...(data?.results || [])]);
      setTotal(data?.total ?? total);
      setPage(next);
    } catch (e: any) {
      showToast(e?.message || '加载更多失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, page, total, showToast]);

  /**
   * 展开/收起某个仓库并加载其标签列表
   * @param repo 目标仓库
   */
  const toggleExpand = useCallback(
    async (repo: HubRepo) => {
      if (expanded === repo.full_name) {
        setExpanded(null);
        setTags([]);
        return;
      }
      setExpanded(repo.full_name);
      setTags([]);
      setTagsLoading(true);
      try {
        const data = await get<{ tags: HubTag[] }>(
          '/api/hub/repositories/' + encodeURIComponent(repo.full_name) + '/tags'
        );
        setTags(data?.tags || []);
      } catch (e: any) {
        showToast(e?.message || '加载标签失败', 'error');
        setTags([]);
      } finally {
        setTagsLoading(false);
      }
    },
    [expanded, showToast]
  );

  /**
   * 打开拉取弹窗（默认选中 latest 标签）
   * @param repo 目标仓库
   */
  const openPull = (repo: HubRepo) => {
    setPullTag('latest');
    setPullTarget(repo);
  };

  /**
   * 提交拉取请求
   */
  const handlePull = useCallback(async () => {
    if (!pullTarget) return;
    const tag = pullTag || 'latest';
    const ref = `${pullTarget.full_name}:${tag}`;
    setPulling(true);
    try {
      await post('/api/hub/pull', { ref, source: pullSource || undefined });
      showToast(`镜像 ${ref} 拉取成功`);
      setPullTarget(null);
    } catch (e: any) {
      showToast(e?.message || '镜像拉取失败', 'error');
    } finally {
      setPulling(false);
    }
  }, [pullTarget, pullTag, pullSource, showToast]);

  /**
   * 从"常用镜像"快捷拉取指定镜像（走当前所选默认镜像源）
   * @param name 镜像名，如 nginx 或 portainer/portainer-ce
   */
  const handlePullCommon = useCallback(
    async (name: string) => {
      if (pullingCommon) return;
      setPullingCommon(name);
      try {
        // 未显式选源时后端会自动用默认镜像源；显式传 pullSource 以跟随下拉
        await post('/api/images/pull', { ref: name, source: pullSource || undefined });
        showToast(`镜像 ${name} 拉取成功`);
      } catch (e: any) {
        showToast(e?.message || `镜像 ${name} 拉取失败`, 'error');
      } finally {
        setPullingCommon(null);
      }
    },
    [pullingCommon, pullSource, showToast]
  );

  return (
    <div className="page">
      <Card
        title="镜像中心"
        extra={
          <div className="hub-toolbar">
            <form className="hub-toolbar__search" onSubmit={handleSearchSubmit}>
              <input
                className="input hub-search"
                placeholder="搜索 Docker Hub 镜像，如 nginx"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
              />
              <Button variant="primary" type="submit">
                搜索
              </Button>
            </form>
            <Button variant="secondary" onClick={() => setSourcesOpen(true)}>
              镜像源
            </Button>
          </div>
        }
      >
        <div className="hub-tip">
          浏览并拉取 Docker Hub 上的镜像，点击条目可查看其标签列表。
          {pullSource && (
            <span className="hub-tip__source">当前拉取源：{pullSource}</span>
          )}
        </div>

        {/* 常用镜像快捷拉取：在线搜索不可用时的兜底入口 */}
        <div className="hub-common">
          <div className="hub-common__title">常用镜像</div>
          <div className="hub-common__grid">
            {COMMON_REPOS.map((m) => (
              <button
                key={m.name}
                className="hub-common__item"
                onClick={() => handlePullCommon(m.name)}
                disabled={pullingCommon !== null}
              >
                <span className="hub-common__name">{m.name}</span>
                {pullingCommon === m.name ? (
                  <span className="hub-common__busy">拉取中…</span>
                ) : (
                  <span className="hub-common__desc">{m.desc || '拉取'}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {loading && results.length === 0 ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="搜索失败"
            description={loadError || '请检查网络连接后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={() => doSearch(query)}>
                重试
              </Button>
            }
          />
        ) : results.length === 0 ? (
          <Empty title="未找到镜像" description="尝试更换搜索关键字" />
        ) : (
          <div className="hub-list">
            {results.map((repo) => {
              const isExpanded = expanded === repo.full_name;
              return (
                <div className="hub-item" key={repo.full_name}>
                  <div
                    className="hub-item__head"
                    onClick={() => toggleExpand(repo)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && toggleExpand(repo)}
                  >
                    <div className="hub-item__meta">
                      <div className="hub-item__name">
                        {repo.name}
                        {repo.is_official && (
                          <span className="hub-item__official">官方</span>
                        )}
                      </div>
                      <div className="hub-item__desc" title={repo.description}>
                        {repo.description || '暂无描述'}
                      </div>
                    </div>
                    <div className="hub-item__stats">
                      <div className="hub-item__stat">
                        <span className="hub-item__stat-label">Star</span>
                        <span className="hub-item__stat-value">{formatCount(repo.star_count)}</span>
                      </div>
                      <div className="hub-item__stat">
                        <span className="hub-item__stat-label">拉取</span>
                        <span className="hub-item__stat-value">{formatCount(repo.pull_count)}</span>
                      </div>
                      <div className="hub-item__stat">
                        <span className="hub-item__stat-label">更新</span>
                        <span className="hub-item__stat-value">{formatDate(repo.last_updated)}</span>
                      </div>
                    </div>
                    <div className="hub-item__actions">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          openPull(repo);
                        }}
                      >
                        拉取
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(repo);
                        }}
                      >
                        {isExpanded ? '收起' : '标签'}
                      </Button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="hub-item__body">
                      {tagsLoading ? (
                        <div className="hub-item__tip">加载标签中…</div>
                      ) : tags.length === 0 ? (
                        <div className="hub-item__tip">该镜像暂无标签</div>
                      ) : (
                        <div className="hub-tags">
                          {tags.map((tag) => (
                            <span className="hub-tags__chip" key={tag.name}>
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {results.length < total && (
              <div className="hub-more">
                <Button variant="secondary" loading={loading} onClick={loadMore}>
                  加载更多
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 拉取镜像弹窗：选择标签 */}
      <Modal
        open={!!pullTarget}
        title={pullTarget ? `拉取 ${pullTarget.name}` : '拉取镜像'}
        onClose={() => !pulling && setPullTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPullTarget(null)} disabled={pulling}>
              取消
            </Button>
            <Button onClick={handlePull} loading={pulling}>
              拉取
            </Button>
          </>
        }
      >
        <div className="hub-pull">
          <div className="hub-pull__row">
            <span className="hub-pull__label">镜像</span>
            <span className="hub-pull__value mono">
              {pullTarget ? `${pullTarget.full_name}:${pullTag || 'latest'}` : '-'}
            </span>
          </div>
          <div className="hub-pull__row">
            <span className="hub-pull__label">选择标签</span>
            <Select value={pullTag} onChange={(e) => setPullTag(e.target.value)}>
              <option value="latest">latest</option>
              {tags.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="hub-pull__row">
            <span className="hub-pull__label">镜像源</span>
            <Select
              value={pullSource}
              onChange={(e) => setPullSource(e.target.value)}
            >
              <option value="">官方 Docker Hub</option>
              {sources
                .filter((s) => s.enabled !== false)
                .map((s) => (
                  <option key={s.id} value={s.host}>
                    {s.name || s.host}
                  </option>
                ))}
            </Select>
          </div>
          <div className="hub-pull__hint">
            选择镜像加速源可在 Docker Hub 访问不稳定时加速拉取。
          </div>
          {pullTarget && (
            <div className="hub-pull__actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPullTarget(null);
                  navigate('/images');
                }}
              >
                前往镜像列表
              </Button>
            </div>
          )}
        </div>
      </Modal>

      {/* 镜像源配置弹窗 */}
      <Modal
        open={sourcesOpen}
        title="镜像源配置"
        onClose={() => setSourcesOpen(false)}
        width={560}
        footer={
          <Button variant="secondary" onClick={() => setSourcesOpen(false)}>
            关闭
          </Button>
        }
      >
        <div className="hub-sources">
          <div className="hub-sources__tip">
            在 Docker Hub 访问不稳定时，可在这里配置镜像加速源。拉取镜像时选择对应源即可，镜像引用会自动带上该源前缀。
          </div>

          <div className="hub-sources__list">
            {sources.length === 0 ? (
              <Empty title="暂无镜像源" description="请在下方添加" />
            ) : (
              sources.map((s) => (
                <div className="hub-sources__item" key={s.id}>
                  <div className="hub-sources__info">
                    <div className="hub-sources__host">
                      {s.host}
                      {s.builtin && <span className="hub-sources__tag">内置</span>}
                      {s.name && <span className="hub-sources__name">{s.name}</span>}
                    </div>
                  </div>
                  <div className="hub-sources__actions">
                    <span className="hub-sources__status">
                      {s.enabled === false ? '未启用' : '启用'}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleSourceEnabled(s)}
                    >
                      {s.enabled === false ? '启用' : '停用'}
                    </Button>
                    {!s.builtin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteSourceId(s.id)}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="hub-sources__add">
            <Field label="镜像源地址" required>
              <Input
                value={newSourceHost}
                onChange={(e) => setNewSourceHost(e.target.value)}
                placeholder="如 https://docker.xuanyuan.me"
              />
            </Field>
            <Field label="名称（可选）">
              <Input
                value={newSourceName}
                onChange={(e) => setNewSourceName(e.target.value)}
                placeholder="如 轩辕镜像源"
              />
            </Field>
            <div className="hub-sources__add-btn">
              <Button variant="primary" onClick={handleAddSource} loading={savingSource}>
                添加镜像源
              </Button>
            </div>
          </div>

          {/* 自定义搜索源（可选） */}
          <div className="hub-sources__search">
            <Field
              label="搜索源（可选）"
              hint="国内镜像站普遍不支持在线搜索，可在此填一个能返回 Docker Hub 搜索结果的 API 基址（如 https://hub.docker.com），留空使用内置源。"
            >
              <Input
                value={searchSource}
                onChange={(e) => setSearchSource(e.target.value)}
                placeholder="https://hub.docker.com"
              />
            </Field>
            <div className="hub-sources__add-btn">
              <Button variant="primary" onClick={handleSaveSearchSource}>
                保存搜索源
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* 删除镜像源二次确认 */}
      <ConfirmDialog
        open={!!deleteSourceId}
        title="删除镜像源"
        message="确定删除该自定义镜像源吗？"
        danger
        onCancel={() => setDeleteSourceId(null)}
        onConfirm={confirmDeleteSource}
      />
    </div>
  );
}
