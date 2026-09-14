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
import { Field, Input } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { translateNow as t } from '../i18n';
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

const PAGE_TITLE = 'Edge 节点';

export default function EdgePage() {
  const toast = useToast();
  const [nodes, setNodes] = useState<EdgeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ node: EdgeNode; token: string } | null>(null);
  const [containers, setContainers] = useState<Record<string, EdgeContainer[]>>({});
  const { showToast } = useToast();
  const admin = isAdmin();

  const load = useCallback(async () => {
    const r = await get<{ items: EdgeNode[] }>('/api/edge/nodes');
    setNodes(r.items || []);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

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
    ? `PANEL_URL=${location.origin}\nEDGE_TOKEN=${created.token}\nnode agent.js`
    : '';

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
                    {admin && (
                      <Button size="sm" variant="danger" onClick={() => removeNode(n.id)}>
                        {t('删除')}
                      </Button>
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
            <EdgeContainersTable rows={containers[n.id]} />
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
    </div>
  );

  function EdgeContainersTable({ rows }: { rows: EdgeContainer[] }) {
    if (!rows.length) return <Empty title={t('远端暂无容器')} />;
    return (
      <table className="edge-table">
        <thead>
          <tr>
            <th>{t('名称')}</th>
            <th>{t('镜像')}</th>
            <th>{t('运行状态')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.Id}>
              <td>{c.Names?.[0]?.replace(/^\//, '') || c.Id.slice(0, 12)}</td>
              <td>{c.Image}</td>
              <td>{c.Status || c.State}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
}
