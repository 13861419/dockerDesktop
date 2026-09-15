/**
 * Edge 节点页（1.63.0）：远程主机 agent 反向连接管理
 *
 * 新建节点 → 复制 token 与 agent 启动命令 → 远端运行 agent → 状态在线
 * → 连通性测试 / 只读查看远端容器。
 */
import { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import { Field, Input, TextArea } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { translateNow as t } from '../i18n';
import MoreMenu from '../components/MoreMenu';
import './edge.less';

interface EdgeNode {
  id: string;
  name: string;
  agentVersion: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
}

interface EdgeContainer {
  Id: string;
  Names?: string[];
  Image: string;
  State: string;
  Status?: string;
}

interface EdgeVersion {
  Version?: string;
  Os?: string;
  Arch?: string;
}

/** 节点资源采样点（agent 每 10 秒上报，1.71.0） */
interface EdgeStatPoint {
  t: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
}

/** 迷你曲线（SVG 折线，零依赖）：values 取 0-100 百分比序列 */
function Spark({ values, color, title }: { values: number[]; color: string; title: string }) {
  const w = 320;
  const h = 70;
  if (values.length < 2) {
    return <Empty title={t('采样中，请稍候...')} />;
  }
  const step = w / (values.length - 1);
  const pts = values
    .map((v, i) => {
      const clamped = Math.max(0, Math.min(100, v));
      const y = h - 4 - (clamped / 100) * (h - 8);
      return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary, #666)', marginBottom: 4 }}>{title}</div>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', background: 'var(--bg-tertiary, #f5f6f7)', borderRadius: 6 }}>
        <polyline points={`0,${h} ${pts} ${w},${h}`} fill={`${color}22`} stroke="none" />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
      </svg>
    </div>
  );
}

interface EdgeVersion {
  Version?: string;
  Os?: string;
  Arch?: string;
}

const PAGE_TITLE = 'Edge 节点';

export default function EdgePage() {
  const toast = useToast();
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  // 面板内置 agent 版本（与节点上报版本不一致时提示升级，1.71.0）
  const [agentLatest, setAgentLatest] = useState('');
  const [upgradingId, setUpgradingId] = useState('');
  // 资源监控弹窗（1.71.0）
  const [statsView, setStatsView] = useState<EdgeNode | null>(null);
  const [statsSeries, setStatsSeries] = useState<EdgeStatPoint[]>([]);
  const [created, setCreated] = useState<{ node: EdgeNode; token: string } | null>(null);
  const [containers, setContainers] = useState<Record<string, EdgeContainer[]>>({});
  const { showToast } = useToast();
  const admin = isAdmin();
  const [deployNode, setDeployNode] = useState<EdgeNode | null>(null);
  const [dImage, setDImage] = useState('');
  const [dName, setDName] = useState('');
  const [dPorts, setDPorts] = useState('');
  const [dEnv, setDEnv] = useState('');
  const [logsView, setLogsView] = useState<{ node: EdgeNode; cid: string; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await get<{ items: EdgeNode[]; latestAgentVersion?: string }>('/api/edge/nodes');
    setNodes(r.items || []);
    setAgentLatest(r.latestAgentVersion || '');
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // 资源监控轮询：弹窗打开期间每 5 秒刷新
  useEffect(() => {
    if (!statsView) return;
    const pull = () => {
      get<{ series: EdgeStatPoint[] }>(`/api/edge/nodes/${statsView.id}/stats`)
        .then((r) => setStatsSeries(r.series || []))
        .catch(() => {});
    };
    pull();
    const timer = setInterval(pull, 5000);
    return () => clearInterval(timer);
  }, [statsView]);

  /** 下发 agent 自升级指令（agent 覆盖自身后由服务管理器拉起） */
  const upgradeAgent = async (n: EdgeNode) => {
    setUpgradingId(n.id);
    try {
      await post(`/api/edge/nodes/${n.id}/upgrade`, {});
      showToast(t('升级指令已下发，agent 将自动重启并重连'), 'success');
      setTimeout(load, 10_000);
    } catch (e: any) {
      showToast(e?.message || t('升级失败'), 'error');
    } finally {
      setUpgradingId('');
    }
  };

  const createNode = async () => {
    if (!name.trim()) {
      showToast(t('请填写节点名称'), 'error');
      return;
    }
    const r = await post<{ node: EdgeNode; token: string }>('/api/edge/nodes', { name: name.trim() });
    setCreated(r);
    setName('');
    setAddOpen(false);
    await load();
  };

  const removeNode = async (id: string) => {
    if (!confirm(t('确定删除该节点？'))) return;
    await del(`/api/edge/nodes/${id}`);
    showToast(t('节点已删除'), 'success');
    await load();
  };

  const ping = async (id: string) => {
    try {
      const r = await post<{ ok: boolean; version?: EdgeVersion; error?: string }>(
        `/api/edge/nodes/${id}/ping`,
        {},
      );
      if (r.ok) {
        showToast(`${t('连通正常')} Docker ${r.version?.Version || ''}`, 'success');
      } else {
        showToast(r.error || t('节点离线或隧道未连接'), 'error');
      }
    } catch {
      showToast(t('节点离线或隧道未连接'), 'error');
    }
  };

  const loadContainers = async (n: EdgeNode) => {
    if (containers[n.id]) {
      setContainers((prev) => {
        const next = { ...prev };
        delete next[n.id];
        return next;
      });
      return;
    }
    try {
      const r = await get<EdgeContainer[]>(`/api/edge/nodes/${n.id}/docker/containers/json?all=true`);
      setContainers((prev) => ({ ...prev, [n.id]: r || [] }));
    } catch {
      setContainers((prev) => ({ ...prev, [n.id]: [] }));
    }
  };

  const agentCommand = created
    ? `curl -fsSL ${location.origin}/api/edge/agent.sh | PANEL_URL=${location.origin} EDGE_TOKEN=${created.token} sh`
    : '';

  /** 端口/环境变量文本解析：host:container[/proto] 与 K=V */
  const parseSpecs = () => {
    const exposed: Record<string, Record<string, never>> = {};
    const bindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const line of dPorts.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/^(\d+):(\d+)(\/(tcp|udp))?$/);
      if (!m) continue;
      const proto = m[4] || 'tcp';
      exposed[`${m[2]}/${proto}`] = {};
      bindings[`${m[2]}/${proto}`] = [{ HostPort: m[1] }];
    }
    const env = dEnv
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('='));
    return { exposed, bindings, env };
  };

  const deployContainer = async () => {
    if (!deployNode || !dImage.trim()) {
      showToast(t('请填写镜像名'), 'error');
      return;
    }
    try {
      const { exposed, bindings, env } = parseSpecs();
      const qs = dName.trim() ? `?name=${encodeURIComponent(dName.trim())}` : '';
      const r = await post<{ Id: string; error?: string; echo?: string; fake?: boolean }>(
        `/api/edge/nodes/${deployNode.id}/docker/containers/create${qs}`,
        { Image: dImage.trim(), Env: env, ExposedPorts: exposed, HostConfig: { PortBindings: bindings } },
      );
      const cid = (r as any).Id || '';
      if (cid) {
        await post(`/api/edge/nodes/${deployNode.id}/docker/containers/${cid.slice(0, 12)}/start`, {});
      }
      showToast(t('部署成功'), 'success');
      setDeployNode(null);
      setDImage('');
      setDName('');
      setDPorts('');
      setDEnv('');
      const list = await get<EdgeContainer[]>(
        `/api/edge/nodes/${deployNode.id}/docker/containers/json?all=true`,
      );
      setContainers((prev) => ({ ...prev, [deployNode.id]: list || [] }));
    } catch (e: any) {
      showToast(e?.message || t('操作失败'), 'error');
    }
  };

  const viewLogs = async (n: EdgeNode, cid: string) => {
    try {
      const r = await get<{ type: string; lines: Array<{ s: string; t: string }> }>(
        `/api/edge/nodes/${n.id}/docker/containers/${cid}/logs?stdout=1&stderr=1&tail=200&timestamps=1`,
      );
      const text = (r?.lines || []).map((l) => l.t).join('');
      setLogsView({ node: n, cid, text: text || t('暂无日志') });
    } catch {
      showToast(t('节点离线或隧道未连接'), 'error');
    }
  };

  return (
    <div className="edge-page">
      <Card
        title={PAGE_TITLE}
        extra={
          admin && (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              {t('添加节点')}
            </Button>
          )
        }
      >
        <p className="edge-page__hint">{t('在一台远程主机上运行轻量 agent，主动反向连接本面板（适合 NAT / 防火墙后无法暴露 2375 的主机），即可在面板中管理其 Docker。')}</p>
        {nodes.length === 0 ? (
          !addOpen ? (
            <Empty title={t('暂无 Edge 节点')} />
          ) : null
        ) : (
          <table className="edge-table">
            <thead>
              <tr>
                <th>{t('名称')}</th>
                <th>{t('状态')}</th>
                <th>{t('Agent 版本')}</th>
                <th>{t('最后心跳')}</th>
                <th>{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.id}>
                  <td>
                    <strong>{n.name}</strong>
                    <span className="edge-table__id">{n.id}</span>
                  </td>
                  <td>
                    <span className={`edge-status ${n.online ? 'is-online' : 'is-offline'}`}>
                      {n.online ? t('在线') : t('离线')}
                    </span>
                  </td>
                  <td>{n.agentVersion || '—'}</td>
                  <td>{n.lastSeenAt ? new Date(n.lastSeenAt).toLocaleString() : '—'}</td>
                  <td className="edge-table__actions">
                    <Button size="sm" onClick={() => ping(n.id)}>
                      {t('测试连接')}
                    </Button>
                    <Button size="sm" onClick={() => loadContainers(n)}>
                      {t('查看容器')}
                    </Button>
                    <Button size="sm" onClick={() => setStatsView(n)} disabled={!n.online} title={n.online ? '' : t('节点离线')}>
                      {t('资源')}
                    </Button>
                    {admin && (
                      <MoreMenu
                        items={[
                          { label: t('管理'), group: true, onClick: () => {} },
                          {
                            label: t('部署容器'),
                            disabled: !n.online,
                            title: !n.online ? t('节点离线，无法部署') : '',
                            onClick: () => setDeployNode(n),
                          },
                          ...(agentLatest && n.agentVersion !== agentLatest
                            ? [
                                {
                                  label: t('升级 agent') + (n.agentVersion ? `（${n.agentVersion} → ${agentLatest}）` : ''),
                                  disabled: !n.online || upgradingId === n.id,
                                  title: !n.online ? t('节点离线，无法部署') : '',
                                  onClick: () => upgradeAgent(n),
                                },
                              ]
                            : []),
                          { label: t('删除'), danger: true, onClick: () => removeNode(n.id) },
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {nodes.map((n) =>
        containers[n.id] ? (
          <Card key={`c-${n.id}`} title={`${n.name} — ${t('远端容器')}`}>
            <EdgeContainersTable
              rows={containers[n.id]}
              nodeId={n.id}
              onViewLogs={(nodeId, cid) => viewLogs(nodes.find((x) => x.id === nodeId)!, cid)}
              onAction={async (nodeId, cid, action) => {
                await post(`/api/edge/nodes/${nodeId}/docker/containers/${cid}/${action}`, {});
                showToast(t('操作成功'), 'success');
                const r = await get<EdgeContainer[]>(
                  `/api/edge/nodes/${nodeId}/docker/containers/json?all=true`,
                );
                setContainers((prev) => ({ ...prev, [nodeId]: r || [] }));
              }}
              onDeleteRow={async (nodeId, cid) => {
                await del(`/api/edge/nodes/${nodeId}/docker/containers/${cid}`);
                showToast(t('操作成功'), 'success');
                const r = await get<EdgeContainer[]>(
                  `/api/edge/nodes/${nodeId}/docker/containers/json?all=true`,
                );
                setContainers((prev) => ({ ...prev, [nodeId]: r || [] }));
              }}
            />
          </Card>
        ) : null,
      )}

      <Modal open={addOpen} title={t('添加节点')} onClose={() => setAddOpen(false)}>
        <Field label={t('节点名称')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('例如：office-nas')} />
        </Field>
        <div className="edge-modal__actions">
          <Button onClick={() => setAddOpen(false)}>{t('取消')}</Button>
          <Button variant="primary" onClick={createNode}>
            {t('创建')}
          </Button>
        </div>
      </Modal>

      <Modal open={!!created} title={t('节点创建成功')} onClose={() => setCreated(null)}>
        <p className="edge-page__hint">{t('在远程主机上以以下环境变量运行 agent（token 仅显示一次）：')}</p>
        <pre className="edge-command">{agentCommand}</pre>
        <div className="edge-modal__footer">
          <Button
            variant="primary"
            onClick={async () => {
              await navigator.clipboard.writeText(agentCommand);
              showToast(t('已复制'), 'success');
            }}
          >
            {t('复制启动命令')}
          </Button>
        </div>
      </Modal>

      <Modal open={!!deployNode} title={`${t('部署容器')} — ${deployNode?.name || ''}`} onClose={() => setDeployNode(null)}>
        <Field label={t('镜像')}>
          <Input value={dImage} onChange={(e) => setDImage(e.target.value)} placeholder={t('例如：nginx:alpine')} />
        </Field>
        <Field label={t('容器名称')}>
          <Input value={dName} onChange={(e) => setDName(e.target.value)} placeholder={t('留空自动生成')} />
        </Field>
        <Field label={t('端口映射（每行一条 host:container）')}>
          <TextArea value={dPorts} onChange={(e) => setDPorts(e.target.value)} rows={3} placeholder={'8080:80\n5353:53/udp'} />
        </Field>
        <Field label={t('环境变量（每行一条 K=V）')}>
          <TextArea value={dEnv} onChange={(e) => setDEnv(e.target.value)} rows={3} placeholder={'TZ=Asia/Shanghai'} />
        </Field>
        <div className="edge-modal__actions">
          <Button onClick={() => setDeployNode(null)}>{t('取消')}</Button>
          <Button variant="primary" onClick={deployContainer}>
            {t('部署')}
          </Button>
        </div>
      </Modal>

      <Modal
        open={!!logsView}
        title={`${logsView?.node.name || ''} — ${logsView?.cid || ''} ${t('日志')}`}
        onClose={() => setLogsView(null)}
        width={860}
      >
        <pre className="edge-command edge-logs">{logsView?.text || ''}</pre>
      </Modal>

      <Modal
        open={!!statsView}
        title={`${statsView?.name || ''} — ${t('资源监控')}`}
        onClose={() => {
          setStatsView(null);
          setStatsSeries([]);
        }}
        width={420}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Spark values={statsSeries.map((s) => s.cpu)} color="#2f6fed" title={t('CPU 使用率（%）')} />
          <Spark
            values={statsSeries.map((s) => (s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0))}
            color="#27ae60"
            title={t('内存使用率（%）')}
          />
          {statsSeries.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted, #999)' }}>
              {t('内存')}{' '}
              {(statsSeries[statsSeries.length - 1].memUsed / 1024 / 1024 / 1024).toFixed(2)} GB /{' '}
              {(statsSeries[statsSeries.length - 1].memTotal / 1024 / 1024 / 1024).toFixed(2)} GB · {t('每 10 秒采样，保留最近 15 分钟')}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );

  function EdgeContainersTable({
    rows,
    nodeId,
    onAction,
    onDeleteRow,
    onViewLogs,
  }: {
    rows: EdgeContainer[];
    nodeId: string;
    onAction: (nodeId: string, cid: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
    onDeleteRow: (nodeId: string, cid: string) => Promise<void>;
    onViewLogs: (nodeId: string, cid: string) => void;
  }) {
    if (!rows.length) return <Empty title={t('远端暂无容器')} />;
    return (
      <table className="edge-table">
        <thead>
          <tr>
            <th>{t('名称')}</th>
            <th>{t('镜像')}</th>
            <th>{t('运行状态')}</th>
            <th>{t('操作')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const cid = c.Id.slice(0, 12);
            const running = c.State === 'running';
            return (
              <tr key={c.Id}>
                <td>{c.Names?.[0]?.replace(/^\//, '') || cid}</td>
                <td>{c.Image}</td>
                <td>{c.Status || c.State}</td>
                <td className="edge-table__actions">
                  {running ? (
                    <Button size="sm" onClick={() => onAction(nodeId, cid, 'stop')}>
                      {t('停止')}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => onAction(nodeId, cid, 'start')}>
                      {t('启动')}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => onAction(nodeId, cid, 'restart')}>
                    {t('重启')}
                  </Button>
                  <Button size="sm" onClick={() => onViewLogs(nodeId, cid)}>
                    {t('日志')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      if (confirm(t('确定删除该容器？'))) onDeleteRow(nodeId, cid);
                    }}
                  >
                    {t('删除')}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
}
