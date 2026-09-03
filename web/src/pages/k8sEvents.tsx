/**
 * Kubernetes 集群事件页（1.5.0 一期：只读）
 *
 * 展示集群事件列表，支持命名空间过滤、Warning/Normal 过滤与关键字搜索。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { get } from '../api/client';
import { getToken } from '../api/auth';
import Card from '../components/Card';
import Empty from '../components/Empty';
import Button from '../components/Button';
import { Select } from '../components/Form';
import { translateNow as t } from '../i18n';
import './k8s.less';

/** K8s 事件视图 */
interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  object: string;
  kind: string;
  count: number;
  lastAt: number | null;
}

export default function K8sEvents() {
  const [events, setEvents] = useState<K8sEvent[]>([]);
  const [ns, setNs] = useState('all');
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [level, setLevel] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [fromHistory, setFromHistory] = useState(false);
  const [live, setLive] = useState(false);
  const [liveCount, setLiveCount] = useState(0);

  const load = useCallback(async (nsArg: string, levelArg: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (nsArg && nsArg !== 'all') params.set('namespace', nsArg);
      const res = await get<{ events: K8sEvent[] }>(`/api/k8s/events?${params.toString()}`);
      let list = res.events || [];
      if (levelArg !== 'all') list = list.filter((e) => e.type === levelArg);
      setEvents(list);
      setUnavailable(false);
      setFromHistory(false);
    } catch (err) {
      const msg = (err as Error)?.message || '';
      if (msg.includes('503') || msg.includes('不可用')) {
        // 集群不可达：回退本地历史事件（1.12.0 落库，最近 7 天）
        try {
          const params = new URLSearchParams();
          if (nsArg && nsArg !== 'all') params.set('namespace', nsArg);
          const hist = await get<{ events: K8sEvent[] }>(`/api/k8s/events-history?${params.toString()}`);
          let list = hist.events || [];
          if (levelArg !== 'all') list = list.filter((e) => e.type === levelArg);
          setEvents(list);
          setFromHistory(true);
        } catch {
          setUnavailable(true);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 命名空间列表独立加载（事件接口失败不阻塞切换器）
    get<{ namespaces: string[] }>('/api/k8s/namespaces')
      .then((res) => setNamespaces(res.namespaces || []))
      .catch(() => {
        /* 忽略 */
      });
  }, []);

  useEffect(() => {
    void load(ns, level);
  }, [load, ns, level]);

  // 实时事件流（WebSocket）：开启时建立连接，新事件插到表头
  useEffect(() => {
    if (!live) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getToken();
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/k8sevents${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data?.type === 'event' && data.event) {
          setEvents((prev) => [data.event, ...events]);
          setLiveCount((c) => c + 1);
        }
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return events;
    return events.filter((e) => `${e.kind}/${e.object} ${e.reason} ${e.message}`.toLowerCase().includes(kw));
  }, [events, search]);

  if (unavailable) {
    return (
      <div className="k8s">
        <Card title={t('集群事件')}>
          <Empty title={t('Kubernetes 不可用：请先配置 kubeconfig')} />
        </Card>
      </div>
    );
  }

  return (
    <div className="k8s">
      <div className="k8s__toolbar">
        <h2 className="k8s__title">
          {t('集群事件')}
          {fromHistory && <span className="k8s__badge k8s__badge--warn" style={{ marginLeft: 8 }}>{t('本地历史（集群不可达）')}</span>}
        </h2>
        <div className="k8s__toolbar-controls">
          <input
            className="input k8s__search"
            placeholder={t('搜索事件…')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select className="k8s__select" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="all">{t('全部级别')}</option>
            <option value="Warning">Warning</option>
            <option value="Normal">Normal</option>
          </Select>
          <Select className="k8s__select" value={ns} onChange={(e) => setNs(e.target.value)}>
            <option value="all">{t('全部命名空间')}</option>
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Button variant={live ? 'primary' : 'ghost'} onClick={() => setLive((v) => !v)}>
            {live ? `${t('实时已开启')}${liveCount ? ` (+${liveCount})` : ''}` : t('实时')}
          </Button>
          <Button variant="ghost" onClick={() => void load(ns, level)}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      <Card>
        {loading ? (
          <div className="k8s__loading">{t('加载中…')}</div>
        ) : filtered.length === 0 ? (
          <Empty title={t('暂无事件')} />
        ) : (
          <div className="k8s__table-wrap">
            <table className="k8s__table">
              <thead>
                <tr>
                  <th>{t('级别')}</th>
                  <th>{t('对象')}</th>
                  <th>{t('原因')}</th>
                  <th>{t('消息')}</th>
                  <th>{t('次数')}</th>
                  <th>{t('最近时间')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr key={i}>
                    <td>
                      <span className={e.type === 'Warning' ? 'k8s__badge k8s__badge--warn' : 'k8s__badge k8s__badge--ok'}>
                        {e.type || '—'}
                      </span>
                    </td>
                    <td className="k8s__mono">
                      {e.kind ? `${e.kind}/${e.object}` : e.object || '—'}
                    </td>
                    <td>{e.reason || '—'}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 240 }}>{e.message || '—'}</td>
                    <td>{e.count ?? '—'}</td>
                    <td>{e.lastAt ? new Date(e.lastAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
