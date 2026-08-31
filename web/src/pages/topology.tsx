import { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get } from '../api/client';
import type { TopologyResponse, TopoNode } from '../types';
import { translateNow as t } from '../i18n';
import './topology.less';

const W = 1100;
const H = 700;

interface LayoutNode {
  node: TopoNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 简单力导向布局（斥力 + 弹簧）迭代若干次 */
function layout(nodes: TopoNode[], edges: { from: string; to: string }[]): Map<string, { x: number; y: number }> {
  const map = new Map<string, LayoutNode>();
  // 初始化：圆形分布
  const n = nodes.length;
  const centerX = W / 2;
  const centerY = H / 2;
  const R = Math.min(W, H) * 0.36;
  nodes.forEach((nd, i) => {
    const angle = (i / Math.max(1, n)) * Math.PI * 2;
    map.set(nd.id, {
      node: nd,
      x: centerX + R * Math.cos(angle),
      y: centerY + R * Math.sin(angle),
      vx: 0,
      vy: 0,
    });
  });

  const neighbors = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!neighbors.has(e.from)) neighbors.set(e.from, new Set());
    if (!neighbors.has(e.to)) neighbors.set(e.to, new Set());
    neighbors.get(e.from)!.add(e.to);
    neighbors.get(e.to)!.add(e.from);
  }

  const REPULSION = 1200;
  const SPRING = 0.02;
  const ITER = 120;

  for (let iter = 0; iter < ITER; iter++) {
    for (const a of map.values()) {
      let fx = 0;
      let fy = 0;
      for (const b of map.values()) {
        if (a === b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 1;
        const d = Math.sqrt(d2);
        const rep = (REPULSION * (a.node.kind === b.node.kind ? 1.3 : 0.8)) / Math.max(10, d2);
        fx += (dx / d) * rep;
        fy += (dy / d) * rep;
      }
      // 弹簧沿边
      const nb = neighbors.get(a.node.id) || new Set<string>();
      for (const nid of nb) {
        const b = map.get(nid);
        if (!b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const spring = SPRING * (d - 140);
        fx += (dx / d) * spring;
        fy += (dy / d) * spring;
      }
      a.vx = (a.vx * 0.6) + fx;
      a.vy = (a.vy * 0.6) + fy;
    }
    for (const a of map.values()) {
      a.x += a.vx;
      a.y += a.vy;
      // 边界约束
      a.x = Math.min(W - 30, Math.max(30, a.x));
      a.y = Math.min(H - 30, Math.max(30, a.y));
    }
  }

  const out = new Map<string, { x: number; y: number }>();
  for (const a of map.values()) out.set(a.node.id, { x: a.x, y: a.y });
  return out;
}

function nodeColor(node: TopoNode): string {
  if (node.kind === 'network') return '#8b5cf6';
  const status = node.status;
  if (status === 'running') {
    const h = node.health;
    if (h === 'unhealthy' || h === 'starting') return '#f59e0b';
    return '#10b981';
  }
  if (status === 'exited' || status === 'dead') return '#ef4444';
  return '#94a3b8';
}

export default function TopologyPage() {
  const { showToast } = useToast();
  const [data, setData] = useState<TopologyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TopoNode | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState<Map<string, { x: number; y: number }>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await get<TopologyResponse>('/api/topology');
      setData(d);
      setPos(layout(d.nodes || [], d.edges || []));
    } catch (e: any) {
      showToast(e?.message || t('加载拓扑失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const wheel = useCallback((e: any) => {
    e.preventDefault();
    setZoom((z) => Math.min(2, Math.max(0.5, z + (e.deltaY > 0 ? -0.1 : 0.1))));
  }, []);

  return (
    <div className="topo-page">
      <Card
        title={t('网络拓扑')}
        extra={
          <div className="topo-page__toolbar">
            <span className="topo-page__legend">
              <span className="topo-page__dot running" /> 运行
              <span className="topo-page__dot warn" /> 异常
              <span className="topo-page__dot stopped" /> 停止
              <span className="topo-page__dot net" /> 网络
            </span>
            <Button size="sm" onClick={load}>
              {t('刷新')}
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={8} />
        ) : !data || data.nodes.length === 0 ? (
          <Empty title={t('暂无拓扑')} description="没有可展示的容器或网络。" />
        ) : (
          <div className="topo-page__canvas">
            <div className="topo-page__zoom">
              <Button size="sm" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}>-</Button>
              <Button size="sm" onClick={() => setZoom((z) => Math.min(2, z + 0.15))}>+</Button>
            </div>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              style={{ width: `${W * 0.8}px`, maxWidth: '100%' }}
              className="topo-page__svg"
              onWheel={wheel}
            >
              <g transform={`scale(${zoom})`} style={{ transformOrigin: 'center' }}>
                {data.edges.map((e, i) => {
                  const a = pos.get(e.from);
                  const b = pos.get(e.to);
                  if (!a || !b) return null;
                  return (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      className="topo-page__edge"
                    />
                  );
                })}
                {data.nodes.map((n) => {
                  const p = pos.get(n.id);
                  if (!p) return null;
                  const color = nodeColor(n);
                  const r = n.kind === 'network' ? 34 : 26;
                  const selectedClass = selected && selected.id === n.id ? 'is-selected' : '';
                  return (
                    <g
                      key={n.id}
                      className={`topo-page__node ${selectedClass}`}
                      transform={`translate(${p.x}, ${p.y})`}
                      onClick={() => setSelected(n)}
                      style={{ cursor: 'pointer' }}
                    >
                      <circle r={r} fill={color} fillOpacity={0.25} stroke={color} strokeWidth={2} />
                      <text textAnchor="middle" dy={-r - 8} className="topo-page__node-label">
                        {n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label}
                      </text>
                      {n.kind === 'container' && n.projectName && (
                        <text textAnchor="middle" dy={r + 12} className="topo-page__node-project">
                          {n.projectName}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
            {data.truncated && (
              <div className="topo-page__truncated">容器数超限，已截断显示前 {data.counts.containers} 个</div>
            )}
          </div>
        )}
      </Card>

      <Modal open={!!selected} title={selected ? selected.label : ''} onClose={() => setSelected(null)} width={420}>
        {selected && (
          <div className="topo-page__detail">
            <div className="topo-page__detail-row">
              <span className="topo-page__detail-key">{t('类型')}</span>
              <span>{selected.kind === 'network' ? t('网络') : t('容器')}</span>
            </div>
            {selected.kind === 'container' && (
              <>
                <div className="topo-page__detail-row">
                  <span className="topo-page__detail-key">{t('状态')}</span>
                  <span>{selected.status}</span>
                </div>
                {selected.health && (
                  <div className="topo-page__detail-row">
                    <span className="topo-page__detail-key">{t('健康')}</span>
                    <span>{selected.health}</span>
                  </div>
                )}
                {selected.image && (
                  <div className="topo-page__detail-row">
                    <span className="topo-page__detail-key">{t('镜像')}</span>
                    <span>{selected.image}</span>
                  </div>
                )}
                {selected.projectName && (
                  <div className="topo-page__detail-row">
                    <span className="topo-page__detail-key">{t('项目')}</span>
                    <span>{selected.projectName}</span>
                  </div>
                )}
                {selected.ports && selected.ports.length > 0 && (
                  <div className="topo-page__detail-row">
                    <span className="topo-page__detail-key">{t('端口')}</span>
                    <span>
                      {selected.ports
                        .map((p) => (p.published ? `${p.published}:${p.target}/${p.protocol}` : `${p.target}/${p.protocol}`))
                        .join(', ')}
                    </span>
                  </div>
                )}
              </>
            )}
            {selected.kind === 'network' && selected.driver && (
              <div className="topo-page__detail-row">
                <span className="topo-page__detail-key">{t('驱动')}</span>
                <span>{selected.driver}</span>
              </div>
            )}
            {selected.kind === 'container' && (
              <div className="topo-page__detail-row">
                <span className="topo-page__detail-key">{t('所属网络')}</span>
                <span>{selected.networks?.join(', ') || t('无')}</span>
              </div>
            )}
            {/* 容器连接数 */}
            <div className="topo-page__detail-row">
              <span className="topo-page__detail-key">{t('连接数')}</span>
              <span>{data ? data.edges.filter((e) => e.from === selected.id || e.to === selected.id).length : 0}</span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
