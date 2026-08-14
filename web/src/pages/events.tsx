/**
 * Docker 事件流页面
 *
 * 通过 REST 接口加载最近事件，并通过 WebSocket 实时接收新事件。
 * 支持按类型 / 动作过滤，以及实时滚动开关与清屏。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, del, download } from '../api/client';
import { isAdmin } from '../api/auth';
import { useToast } from '../components/Toast';
import Card from '../components/Card';
import Empty from '../components/Empty';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import { Select } from '../components/Form';
import './events.less';

/** 单个 Docker 事件 */
interface DockerEvent {
  time: number;
  type: string;
  action: string;
  id: string;
  scope: string;
  attributes?: Record<string, string>;
}

/** 事件列表响应 */
interface EventListResponse {
  events: DockerEvent[];
}

/** 浏览器 WebSocket 的兼容别名（Node 环境下无此类型，避免类型冲突） */
declare const WebSocket: any;

/**
 * 将毫秒时间戳格式化为本地时间字符串
 * @param time 毫秒时间戳
 * @returns 格式化的本地时间
 */
function formatTime(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 事件类型徽标样式映射
 * @param type 事件类型
 * @returns 徽标 className
 */
function badgeClass(type: string): string {
  switch (type) {
    case 'container': return 'events-badge--container';
    case 'image': return 'events-badge--image';
    case 'volume': return 'events-badge--volume';
    case 'network': return 'events-badge--network';
    case 'plugin': return 'events-badge--plugin';
    case 'daemon': return 'events-badge--daemon';
    default: return 'events-badge--tombstone';
  }
}

/**
 * Docker 事件流页面组件
 */
export default function EventsPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();
  // 事件列表（内存，最新的在头部）
  const [events, setEvents] = useState<DockerEvent[]>([]);
  // 加载状态
  const [loading, setLoading] = useState(true);
  // 初次加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  // WebSocket 连接状态
  const [live, setLive] = useState(false);
  // 类型过滤
  const [typeFilter, setTypeFilter] = useState('all');
  // 动作过滤
  const [actionFilter, setActionFilter] = useState('all');
  // 是否自动滚动到底部
  const [autoScroll, setAutoScroll] = useState(true);
  // 事件列表滚动容器
  const listRef = useRef<HTMLDivElement>(null);
  // 事件总数（用于清屏后重新计数）
  const countRef = useRef(0);
  // 查看模式：live=实时流 / history=持久化历史
  const [mode, setMode] = useState<'live' | 'history'>('live');
  // 历史加载状态
  const [historyLoading, setHistoryLoading] = useState(false);
  // 历史分页偏移
  const historyOffsetRef = useRef(0);
  // 是否还有更多历史可加载
  const [hasMore, setHasMore] = useState(false);
  // 清空历史确认
  const [clearTarget, setClearTarget] = useState(false);

  // 事件最大值保留（避免无限增长）
  const MAX_EVENTS = 300;
  /** 历史分页每页条数 */
  const HISTORY_PAGE = 100;

  /**
   * 向列表头部插入一条事件（去重按 time+type+action+id）
   * @param ev 新事件
   */
  const prependEvent = useCallback((ev: DockerEvent) => {
    setEvents((prev) => {
      const dup = prev.some(
        (e) => e.time === ev.time && e.type === ev.type && e.action === ev.action && e.id === ev.id,
      );
      if (dup) return prev;
      const next = [ev, ...prev];
      countRef.current += 1;
      return next.slice(0, MAX_EVENTS);
    });
  }, []);

  /**
   * 初始加载：REST 拉取最近事件
   */
  const loadInitial = useCallback(async () => {
    try {
      const data = await get<EventListResponse>('/api/events?limit=100');
      const list = (data?.events || []).slice(0, MAX_EVENTS);
      countRef.current = list.length;
      setEvents(list);
      setLoadError('');
    } catch (e: any) {
      // 失败时保持空列表（WebSocket 仍会推送新事件），并记录错误供错误态展示
      setLoadError(e?.message || '加载事件失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 建立（或重建）WebSocket 实时连接，断线自动重连
   */
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${location.host}/ws/events`;

    let ws: any;
    let closed = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setLive(true);
      };
      ws.onmessage = (evt: any) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'snapshot' && Array.isArray(msg.events)) {
            // 服务端推送的历史快照，合并进列表（快照最新在头部）
            setEvents((prev) => {
              const seen = new Set(prev.map((e) => `${e.time}-${e.type}-${e.action}-${e.id}`));
              const merged = [...prev];
              for (const e of (msg.events as DockerEvent[]).slice().reverse()) {
                const key = `${e.time}-${e.type}-${e.action}-${e.id}`;
                if (!seen.has(key)) {
                  merged.unshift(e);
                }
              }
              countRef.current = merged.length;
              return merged.slice(0, MAX_EVENTS);
            });
          } else if (msg.type === 'event' && msg.event) {
            prependEvent(msg.event);
          }
        } catch {
          // 忽略无法解析的消息
        }
      };
      ws.onclose = () => {
        setLive(false);
        if (!closed) {
          reconnectTimer = window.setTimeout(connect, 3000);
        }
      };
      ws.onerror = () => {
        // 交给 onclose 处理重连
      };
    };

    connect();
    loadInitial();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // 忽略
      }
    };
  }, [loadInitial, prependEvent]);

  // 新事件到达后自动滚动到底部
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [events, autoScroll]);

  // 可用类型清单（从当前事件聚合）
  const types = useMemo(
    () => Array.from(new Set(events.map((e) => e.type))).sort(),
    [events],
  );
  // 可用动作清单（从当前事件聚合）
  const actions = useMemo(
    () => Array.from(new Set(events.map((e) => e.action))).sort(),
    [events],
  );

  // 过滤后的事件
  const filtered = useMemo(
    () =>
      events.filter(
        (e) =>
          (typeFilter === 'all' || e.type === typeFilter) &&
          (actionFilter === 'all' || e.action === actionFilter),
      ),
    [events, typeFilter, actionFilter],
  );

  /**
   * 清空当前列表
   */
  const handleClear = useCallback(() => {
    setEvents([]);
    countRef.current = 0;
  }, []);

  /**
   * 切换查看模式：live <-> history
   * 仅在 UI 层切换；实际加载由 mode effect 驱动
   * @param next 目标模式
   */
  const switchMode = useCallback(async (next: 'live' | 'history') => {
    setMode(next);
  }, []);

  /**
   * 加载一页持久化历史（追加/替换到列表）
   * @param reset 是否重置列表并回到首页
   */
  const loadHistoryPage = useCallback(
    async (reset: boolean) => {
      if (!reset && historyLoading) return;
      setHistoryLoading(true);
      try {
        const params: Record<string, any> = { history: 1, limit: HISTORY_PAGE };
        if (!reset) params.offset = historyOffsetRef.current;
        if (typeFilter !== 'all') params.type = typeFilter;
        if (actionFilter !== 'all') params.action = actionFilter;
        const data = await get<EventListResponse & { history?: boolean }>('/api/events', params);
        const list = data?.events || [];
        // 服务端按新到旧返回；列表以"最新在上"展示
        setEvents((prev) => {
          const merged = reset ? [...list] : [...prev, ...list];
          return merged.slice(0, 2000);
        });
        historyOffsetRef.current = (reset ? 0 : historyOffsetRef.current) + list.length;
        setHasMore(list.length >= HISTORY_PAGE);
      } catch (e: any) {
        showToast(e?.message || '加载历史失败', 'error');
      } finally {
        setHistoryLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyLoading, typeFilter, actionFilter, showToast],
  );

  /**
   * 导出持久化事件历史（CSV）
   */
  const handleExport = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可导出事件历史', 'error');
      return;
    }
    try {
      await download('/api/events/history/export', 'docker-events.csv');
      showToast('已开始导出事件历史');
    } catch (e: any) {
      showToast(e?.message || '导出失败', 'error');
    }
  }, [canManage, showToast]);

  /**
   * 清空全部持久化事件历史
   */
  const confirmClearHistory = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可清空事件历史', 'error');
      setClearTarget(false);
      return;
    }
    try {
      await del('/api/events/history');
      if (mode === 'history') {
        setEvents([]);
        historyOffsetRef.current = 0;
        setHasMore(false);
      }
      setClearTarget(false);
      showToast('事件历史已清空');
    } catch (e: any) {
      showToast(e?.message || '清空失败', 'error');
    }
  }, [canManage, mode, showToast]);

  // 模式切换后驱动数据加载
  useEffect(() => {
    if (mode === 'history') {
      setEvents([]);
      historyOffsetRef.current = 0;
      loadHistoryPage(true);
    } else {
      setEvents([]);
      loadInitial();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // 历史模式下过滤条件变化时重新查询首页
  useEffect(() => {
    if (mode !== 'history') return;
    historyOffsetRef.current = 0;
    loadHistoryPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, actionFilter]);

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">事件流</h1>
        <p className="page__desc">实时查看 Docker 引擎事件（容器 / 镜像 / 数据卷 / 网络 等）</p>
      </div>

      <Card>
        <div className="events-toolbar">
          <span className="events-toolbar__title">事件</span>
          <div className="events-toolbar__filters">
            <div className="events-toolbar__filter">
              <span>类型</span>
              <Select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                style={{ minWidth: 120 }}
              >
                <option value="all">全部</option>
                {types.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            </div>
            <div className="events-toolbar__filter">
              <span>动作</span>
              <Select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                style={{ minWidth: 140 }}
              >
                <option value="all">全部</option>
                {actions.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </Select>
            </div>
            <label className="events-toolbar__filter">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              <span>自动置顶</span>
            </label>
            <Button variant={mode === 'live' ? 'primary' : 'ghost'} size="sm" onClick={() => mode !== 'live' && switchMode('live')}>
              实时
            </Button>
            <Button variant={mode === 'history' ? 'primary' : 'ghost'} size="sm" onClick={() => mode !== 'history' && switchMode('history')}>
              历史
            </Button>
            {mode === 'history' && canManage && (
              <>
                <Button variant="ghost" size="sm" onClick={handleExport}>导出</Button>
                <Button variant="ghost" size="sm" onClick={() => setClearTarget(true)}>清空历史</Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={handleClear}>清空</Button>
          </div>
          <span className={`events-status ${mode === 'history' ? 'events-status--off' : live ? 'events-status--live' : 'events-status--off'}`}>
            <span className="events-status__dot" />
            {mode === 'history' ? '历史模式' : live ? '实时连接中' : '连接断开'}
          </span>
        </div>

        <div className="events-body" ref={listRef} style={{ maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
          {loading ? (
            <div className="empty" style={{ padding: '40px 0' }}>加载中...</div>
          ) : filtered.length === 0 ? (
            events.length === 0 && loadError ? (
              <Empty
                kind="error"
                title="加载事件失败"
                description={loadError}
                action={
                  <Button variant="secondary" size="sm" onClick={loadInitial}>
                    重试
                  </Button>
                }
              />
            ) : (
              <Empty title={events.length === 0 ? '暂无事件' : '无匹配事件'} />
            )
          ) : (
            <div className="events-list">
              {filtered.map((e, idx) => (
                <div className="events-item" key={`${e.time}-${e.type}-${e.action}-${e.id}-${idx}`}>
                  <span className="events-item__time">{formatTime(e.time)}</span>
                  <span className="events-item__type">
                    <span className={`events-badge ${badgeClass(e.type)}`}>{e.type}</span>
                  </span>
                  <div className="events-item__main">
                    <span className="events-item__action">{e.action}</span>
                    {e.id && <span className="events-item__id">{e.id}</span>}
                    <span className="events-item__scope">{e.scope}</span>
                    {e.attributes && Object.keys(e.attributes).length > 0 && (
                      <div className="events-item__attrs">
                        {Object.entries(e.attributes).map(([k, v]) => (
                          <span className="events-attr" key={k}>
                            <strong>{k}</strong>={v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {mode === 'history' && hasMore && (
            <div className="events-more">
              <Button variant="secondary" size="sm" loading={historyLoading} onClick={() => loadHistoryPage(false)}>
                加载更多
              </Button>
            </div>
          )}
          {mode === 'history' && historyLoading && hasMore === false && filtered.length === 0 && (
            <div className="empty" style={{ padding: '24px 0' }}>加载中...</div>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={clearTarget}
        title="清空事件历史"
        message="确定清空全部持久化的事件历史记录吗？此操作不可撤销。"
        confirmText="清空"
        danger
        onConfirm={confirmClearHistory}
        onCancel={() => setClearTarget(false)}
      />
    </div>
  );
}
