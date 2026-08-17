/**
 * 全局搜索组件
 *
 * 渲染一个带图标的搜索输入框，输入防抖后调用 GET /api/search?q= 获取结果，
 * 并以分组下拉面板展示容器 / 镜像 / 数据卷 / 网络 / Compose 的匹配项。
 * 支持点击外部关闭、Esc 关闭、键盘上下 + 回车选择。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api/client';
import './GlobalSearch.less';

/** 单组最多展示条数，超出则显示“更多…” */
const MAX_PER_GROUP = 8;
/** 输入防抖延迟（ms） */
const DEBOUNCE_MS = 300;

/** 搜索结果接口形状，与后端 GET /api/search 返回结构对应 */
interface SearchResult {
  containers?: { id: string; name: string; image: string; state: string }[];
  images?: { id: string; name: string }[];
  volumes?: { id: string; name: string; driver: string }[];
  networks?: { id: string; name: string; driver: string }[];
  compose?: { id: string; name: string }[];
}

/** 分组配置：标题、路由、数据来源 */
const GROUPS: {
  key: keyof Omit<SearchResult, 'name'>;
  title: string;
  route: string;
  getMeta?: (item: any) => string;
}[] = [
  { key: 'containers', title: '容器', route: '/containers', getMeta: (i) => `${i.image} · ${i.state}` },
  { key: 'images', title: '镜像', route: '/images' },
  { key: 'volumes', title: '数据卷', route: '/volumes', getMeta: (i) => i.driver },
  { key: 'networks', title: '网络', route: '/networks', getMeta: (i) => i.driver },
  { key: 'compose', title: 'Compose', route: '/compose' },
];

/**
 * 全局搜索
 */
export default function GlobalSearch() {
  const navigate = useNavigate();
  // 输入关键字
  const [keyword, setKeyword] = useState('');
  // 防抖后的实际查询关键字
  const [query, setQuery] = useState('');
  // 搜索结果
  const [result, setResult] = useState<SearchResult | null>(null);
  // 是否正在请求
  const [loading, setLoading] = useState(false);
  // 请求错误信息
  const [error, setError] = useState('');
  // 下拉面板是否可见
  const [open, setOpen] = useState(false);
  // 当前键盘选中的“组:索引”
  const [active, setActive] = useState('');
  // 容器根节点引用，用于点击外部关闭
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * 输入防抖：关键字变化后延迟更新实际查询值
   */
  useEffect(() => {
    const timer = setTimeout(() => setQuery(keyword), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword]);

  /**
   * 查询关键字变化时调用后端接口；空关键字则清空结果并关闭面板
   */
  useEffect(() => {
    // 空关键字直接清空，不发请求
    if (!query.trim()) {
      setResult(null);
      setLoading(false);
      setError('');
      return;
    }
    // 标记防抖句柄，避免过期请求覆盖新结果
    let cancelled = false;
    setLoading(true);
    setError('');
    setOpen(true);
    get<SearchResult>('/api/search', { q: query })
      .then((data) => {
        if (!cancelled) {
          setResult(data || {});
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message || '搜索失败');
          setLoading(false);
          setResult(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  /**
   * 点击外部关闭下拉面板
   */
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  /**
   * 构建扁平化的可选项列表，用于键盘上下选择与焦点定位
   */
  const flatItems = useMemo(() => {
    const list: { key: string; index: number; item: any; route: string; meta?: string }[] = [];
    for (const group of GROUPS) {
      const items = result?.[group.key] || [];
      const visible = items.slice(0, MAX_PER_GROUP);
      visible.forEach((item, idx) => {
        list.push({ key: group.key, index: idx, item, route: group.route, meta: group.getMeta?.(item) });
      });
    }
    return list;
  }, [result]);

  /**
   * 键盘选中高亮的“组:索引”
   */
  const activeKey = useMemo(() => {
    const idx = flatItems.findIndex((f) => f.key === active.split(':')[0] && String(f.index) === active.split(':')[1]);
    return idx;
  }, [flatItems, active]);

  /**
   * 关闭下拉并清空输入与结果
   */
  function reset() {
    setOpen(false);
    setKeyword('');
    setQuery('');
    setResult(null);
    setError('');
    setActive('');
  }

  /**
   * 跳转到指定路由并重置搜索
   * @param route 目标路由路径
   */
  function go(route: string) {
    navigate(route);
    reset();
  }

  /**
   * 处理输入框按键：支持 Esc 关闭、上下选择、回车跳转
   */
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!flatItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = activeKey < 0 ? 0 : (activeKey + 1) % flatItems.length;
      const f = flatItems[next];
      setActive(`${f.key}:${f.index}`);
      setOpen(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = activeKey <= 0 ? flatItems.length - 1 : activeKey - 1;
      const f = flatItems[prev];
      setActive(`${f.key}:${f.index}`);
      setOpen(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeKey >= 0) {
        const f = flatItems[activeKey];
        go(f.route);
      }
    }
  }

  /**
   * 计算带关键词高亮显示的名称片段，无匹配时原样返回
   * @param name 原始名称
   */
  function highlight(name: string): React.ReactNode {
    const q = query.trim();
    if (!q) return name;
    const idx = name.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return name;
    return (
      <>
        {name.slice(0, idx)}
        <strong style={{ color: 'var(--primary)' }}>{name.slice(idx, idx + q.length)}</strong>
        {name.slice(idx + q.length)}
      </>
    );
  }

  /**
   * 渲染单个分组
   */
  function renderGroup(group: (typeof GROUPS)[number]) {
    const items = result?.[group.key] || [];
    if (!items.length) return null;
    const visible = items.slice(0, MAX_PER_GROUP);
    const hasMore = items.length > MAX_PER_GROUP;
    return (
      <div className="global-search__group" key={group.key}>
        <div className="global-search__group-title">
          <span>{group.title}（{items.length}）</span>
          {hasMore && (
            <button className="global-search__more" onClick={() => go(group.route)}>
              更多…
            </button>
          )}
        </div>
        {visible.map((item, idx) => {
          const key = `${group.key}:${idx}`;
          return (
            <button
              key={key}
              className={`global-search__item ${active === key ? 'global-search__item--active' : ''}`}
              onClick={() => go(group.route)}
              onMouseEnter={() => setActive(key)}
            >
              <span className="global-search__item-name">{highlight(item.name)}</span>
              {group.getMeta && (
                <span className="global-search__item-meta">{group.getMeta(item)}</span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  // 是否有可展示的有效分组
  const hasRows = GROUPS.some((g) => (result?.[g.key] || []).length > 0);

  return (
    <div className="global-search" ref={rootRef}>
      <div className="global-search__box">
        <span className="global-search__icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </span>
        <input
          className="global-search__input"
          type="text"
          value={keyword}
          placeholder="搜索容器/镜像/卷/网络/Compose..."
          onChange={(e) => setKeyword(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {keyword && (
          <button
            className="global-search__clear"
            aria-label="清空搜索"
            onClick={() => reset()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div className="global-search__dropdown">
          {loading && (
            <div className="global-search__status">
              <span className="global-search__spinner" />
              搜索中…
            </div>
          )}
          {!loading && error && (
            <div className="global-search__status">搜索失败：{error}</div>
          )}
          {!loading && !error && query.trim() && !hasRows && (
            <div className="global-search__status">无匹配结果</div>
          )}
          {!loading && !error && hasRows && (
            <>
              {GROUPS.map(renderGroup)}
              <div className="global-search__hint">↑↓ 选择 · Enter 跳转 · Esc 关闭</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
