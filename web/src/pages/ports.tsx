/**
 * 全局端口占用地图页面
 *
 * 展示跨引擎的宿主端口占用情况：
 * - 摘要统计（宿主端口数 / 映射条目 / 冲突数）
 * - 端口分布条形图（按区间分桶）
 * - 冲突高亮（同引擎多容器争抢同一端口）
 * - 端口占用明细表（可展开查看占用容器，支持过滤）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get } from '../api/client';
import './ports.less';

/** 单条端口映射记录（/api/ports/map 返回） */
interface PortEntry {
  hostPort: number;
  protocol: string;
  engineId: string;
  engineName: string;
  containerId: string;
  containerName: string;
  containerPort: number;
  hostIp: string;
}

/** 同一端口的占用组 */
interface PortGroup {
  hostPort: number;
  protocol: string;
  entries: PortEntry[];
  conflict: boolean;
  crossEngine: boolean;
}

interface PortsMapResponse {
  engines: Array<{ id: string; name: string; online: boolean; error?: string }>;
  entries: PortEntry[];
  groups: PortGroup[];
  conflicts: PortGroup[];
  summary: { entryCount: number; hostPortCount: number; conflictCount: number };
}

/** 端口分布图的分桶数量（0-65535 均分） */
const BUCKETS = 32;

/**
 * 计算端口分布直方图的分桶
 * @param groups 端口分组
 * @returns 每桶占用端口数
 */
function bucketize(groups: PortGroup[]): number[] {
  const buckets = new Array(BUCKETS).fill(0);
  for (const g of groups) {
    const idx = Math.min(BUCKETS - 1, Math.floor((g.hostPort / 65536) * BUCKETS));
    buckets[idx] += 1;
  }
  return buckets;
}

/** 端口地图页面入口 */
export default function Ports() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<PortsMapResponse | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await get<PortsMapResponse>('/api/ports/map');
      setData(resp);
    } catch (e: any) {
      showToast(e?.message || '加载端口地图失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /** 过滤后的端口分组（按端口号/容器名/引擎名匹配） */
  const filtered = useMemo(() => {
    if (!data) return [];
    const kw = filter.trim().toLowerCase();
    if (!kw) return data.groups;
    return data.groups.filter(
      (g) =>
        String(g.hostPort).includes(kw) ||
        g.entries.some(
          (e) => e.containerName.toLowerCase().includes(kw) || e.engineName.toLowerCase().includes(kw),
        ),
    );
  }, [data, filter]);

  const buckets = useMemo(() => bucketize(data?.groups || []), [data]);
  const maxBucket = Math.max(1, ...buckets);

  /** 切换某端口的展开状态 */
  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="ports-page">
      <div className="ports-page__toolbar">
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          刷新
        </Button>
        <input
          className="ports-page__search"
          placeholder="过滤端口号 / 容器名 / 引擎名"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {loading && !data ? (
        <Card title="端口地图">
          <SkeletonRows rows={4} />
        </Card>
      ) : !data ? (
        <Empty kind="error" title="加载失败" description="无法获取端口地图数据" />
      ) : (
        <>
          {/* 摘要 */}
          <div className="ports-page__summary">
            <div className="ports-summary-card">
              <div className="ports-summary-card__value">{data.summary.hostPortCount}</div>
              <div className="ports-summary-card__label">宿主端口数</div>
            </div>
            <div className="ports-summary-card">
              <div className="ports-summary-card__value">{data.summary.entryCount}</div>
              <div className="ports-summary-card__label">映射条目</div>
            </div>
            <div className={`ports-summary-card ${data.summary.conflictCount > 0 ? 'ports-summary-card--bad' : ''}`}>
              <div className="ports-summary-card__value">{data.summary.conflictCount}</div>
              <div className="ports-summary-card__label">端口冲突</div>
            </div>
            {data.engines.filter((e) => !e.online).length > 0 && (
              <div className="ports-summary-card ports-summary-card--warn">
                <div className="ports-summary-card__value">{data.engines.filter((e) => !e.online).length}</div>
                <div className="ports-summary-card__label">离线引擎</div>
              </div>
            )}
          </div>

          {/* 端口分布条形图 */}
          <Card title="端口分布（0-65535 均分 32 桶）">
            <div className="ports-chart">
              {buckets.map((n, i) => (
                <div key={i} className="ports-chart__col" title={`${i * 2048}-${(i + 1) * 2048 - 1}：${n} 个端口`}>
                  <div className="ports-chart__bar" style={{ height: `${(n / maxBucket) * 100}%` }} />
                </div>
              ))}
            </div>
          </Card>

          {/* 冲突高亮 */}
          {data.conflicts.length > 0 && (
            <Card title="端口冲突（同引擎多容器争抢）">
              <div className="ports-conflicts">
                {data.conflicts.map((g) => (
                  <div key={`${g.hostPort}/${g.protocol}`} className="ports-conflict">
                    <span className="ports-conflict__port">
                      {g.hostPort}/{g.protocol}
                    </span>
                    {g.entries.map((e, i) => (
                      <span key={i} className="ports-conflict__item">
                        {e.engineName} · {e.containerName}（容器端口 {e.containerPort}）
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 占用明细 */}
          <Card title={`端口占用明细（${filtered.length}）`}>
            {filtered.length === 0 ? (
              <Empty kind="search" title={filter ? '无匹配的端口' : '暂无端口映射'} />
            ) : (
              <table className="ports-table">
                <thead>
                  <tr>
                    <th style={{ width: '14%' }}>宿主端口</th>
                    <th style={{ width: '16%' }}>引擎</th>
                    <th style={{ width: '30%' }}>占用容器</th>
                    <th style={{ width: '14%' }}>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((g) => {
                    const key = `${g.hostPort}/${g.protocol}`;
                    const isOpen = expanded.has(key);
                    const enginesOf = [...new Set(g.entries.map((e) => e.engineName))];
                    return (
                      <tr
                        key={key}
                        className={g.conflict ? 'ports-table__row--conflict' : ''}
                        onClick={() => toggle(key)}
                      >
                        <td className="ports-table__port">
                          {g.hostPort}/{g.protocol}
                        </td>
                        <td>{enginesOf.join(', ')}</td>
                        <td>
                          {g.entries.map((e) => e.containerName).join(', ')}
                          {isOpen && (
                            <div className="ports-table__detail">
                              {g.entries.map((e, i) => (
                                <div key={i}>
                                  {e.containerName}（{e.containerId}）：{e.hostIp}:{e.hostPort} → 容器 {e.containerPort}
                                  /{e.protocol}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>
                          {g.conflict ? (
                            <span className="ports-badge ports-badge--conflict">冲突</span>
                          ) : g.crossEngine ? (
                            <span className="ports-badge ports-badge--cross">跨引擎重复</span>
                          ) : (
                            <span className="ports-badge ports-badge--ok">正常</span>
                          )}
                        </td>
                        <td className="ports-table__ops">{isOpen ? '收起' : '展开'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
