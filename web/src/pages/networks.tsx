/**
 * 网络列表页
 *
 * 展示 Docker 网络，支持刷新、新建网络、删除网络与查看网络详情。
 */
import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { Field, Input, Select } from '../components/Form';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import { useCanManage } from '../hooks/useCanManage';
import { NetworkItem, ContainerListItem } from '../types';
import './networks.less';

/** 网络 inspect 中连接容器条目（id → {Name, IPv4Address, Aliases}） */
interface NetworkContainer {
  Name: string;
  IPv4Address: string;
  IPv6Address: string;
  MacAddress: string;
  Aliases: string[];
}

/** 网络完整 inspect 结构 */
interface NetworkInspect {
  Name: string;
  Id: string;
  Created: string;
  Scope: string;
  Driver: string;
  EnableIPv6: boolean;
  IPAM: { Driver: string; Options: any; Config: any[] };
  Internal: boolean;
  Attachable: boolean;
  Containers: Record<string, NetworkContainer> | null;
  Options: Record<string, string>;
  Labels: Record<string, string>;
}

/**
 * 获取网络子网（取 IPAM.Config[0].Subnet）
 * @param net 网络项
 */
function getSubnet(net: NetworkItem): string {
  const cfg = net?.IPAM?.Config;
  return cfg && cfg.length > 0 && cfg[0]?.Subnet ? cfg[0].Subnet : '-';
}

/**
 * 网络列表页组件
 */
export default function NetworksPage() {
  const { showToast } = useToast();
  // 是否可写（创建/删除/清理/连接/断开）：仅管理员可用；普通用户可只读浏览。
  // 采用服务端权威角色判定（useCanManage），防止基于被篡改的 localStorage 误放行
  const { canManage: canDelete, checking: checkingAdmin } = useCanManage();
  const canManage = canDelete;
  const checking = checkingAdmin;
  const [networks, setNetworks] = useState<NetworkItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [driver, setDriver] = useState('bridge');
  const [subnet, setSubnet] = useState('');
  // 网关地址（可选）
  const [gateway, setGateway] = useState('');
  // IP 段范围（可选）
  const [ipRange, setIpRange] = useState('');
  // 是否内部网络
  const [internal, setInternal] = useState(false);
  // 是否启用 IPv6
  const [ipv6, setIpv6] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NetworkItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 清理未使用网络：确认弹窗开关
  const [pruneOpen, setPruneOpen] = useState(false);
  // 清理未使用网络：请求进行中标记
  const [pruning, setPruning] = useState(false);
  const [detailTarget, setDetailTarget] = useState<NetworkItem | null>(null);
  const [detailInfo, setDetailInfo] = useState<NetworkInspect | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [containers, setContainers] = useState<ContainerListItem[]>([]);
  const [connectContainer, setConnectContainer] = useState('');
  const [connectIpv4, setConnectIpv4] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchNetworks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<NetworkItem[]>('/api/networks');
      setNetworks(data || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || '拉取网络列表失败');
      showToast(e?.message || '拉取网络列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchNetworks();
  }, [fetchNetworks, refreshKey]);

  const handleCreate = useCallback(async () => {
    const netName = name.trim();
    if (!netName) {
      showToast('请输入网络名称', 'error');
      return;
    }
    if (!canDelete || checking) {
      showToast(checking ? '正在确认权限，请稍候' : '仅管理员可创建网络', 'error');
      setCreateOpen(false);
      return;
    }
    setCreating(true);
    try {
      await post('/api/networks', {
        name: netName,
        driver,
        subnet: subnet.trim() || undefined,
        gateway: gateway.trim() || undefined,
        ipRange: ipRange.trim() || undefined,
        internal,
        ipv6,
      });
      showToast('网络创建成功');
      setCreateOpen(false);
      setName('');
      setDriver('bridge');
      setSubnet('');
      setGateway('');
      setIpRange('');
      setInternal(false);
      setIpv6(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '网络创建失败', 'error');
    } finally {
      setCreating(false);
    }
  }, [name, driver, subnet, gateway, ipRange, internal, ipv6, showToast, canDelete, checking]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canDelete || checking) {
      showToast(checking ? '正在确认权限，请稍候' : '仅管理员可删除网络', 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await del('/api/networks/' + encodeURIComponent(deleteTarget.Id));
      showToast('网络删除成功');
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '网络删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canDelete, checking, deleteTarget, showToast]);

  /**
   * 一键清理未使用网络
   *
   * 调用后端 prune 接口批量删除未被任何容器连接的网络，
   * 成功后提示删除数量并刷新列表；若没有可清理的网络则提示。
   */
  const handlePrune = useCallback(async () => {
    if (!canDelete || checking) {
      showToast(checking ? '正在确认权限，请稍候' : '仅管理员可清理网络', 'error');
      setPruneOpen(false);
      return;
    }
    setPruning(true);
    try {
      const res = await post<{ success: number; failed: number }>('/api/networks/prune');
      setPruneOpen(false);
      if ((res?.success ?? 0) > 0) {
        showToast(`已清理 ${res.success} 个未使用网络${res.failed ? `，${res.failed} 个删除失败` : ''}`);
        setRefreshKey((k) => k + 1);
      } else {
        showToast('没有未使用的网络');
      }
    } catch (e: any) {
      showToast(e?.message || '清理未使用网络失败', 'error');
    } finally {
      setPruning(false);
    }
  }, [canDelete, checking, showToast]);

  /**
   * 拉取全部容器列表（用于连接容器下拉选择）
   */
  const fetchContainers = useCallback(async () => {
    try {
      const data = await get<ContainerListItem[]>('/api/containers', { all: true });
      setContainers(data || []);
    } catch (e: any) {
      showToast(e?.message || '拉取容器列表失败', 'error');
    }
  }, [showToast]);

  /**
   * 打开网络详情：拉取完整 inspect 并加载容器列表
   * @param net 网络项
   */
  const handleOpenDetail = useCallback(
    async (net: NetworkItem) => {
      setDetailTarget(net);
      setDetailInfo(null);
      setDetailLoading(true);
      setConnectContainer('');
      setConnectIpv4('');
      try {
        const data = await get<NetworkInspect>('/api/networks/' + encodeURIComponent(net.Id));
        setDetailInfo(data);
      } catch (e: any) {
        showToast(e?.message || '拉取网络详情失败', 'error');
      } finally {
        setDetailLoading(false);
      }
      fetchContainers();
    },
    [showToast, fetchContainers]
  );

  /** 关闭详情弹窗 */
  const handleCloseDetail = useCallback(() => {
    setDetailTarget(null);
    setDetailInfo(null);
  }, []);

  /**
   * 刷新当前网络详情
   */
  const refreshDetail = useCallback(async () => {
    if (!detailTarget) return;
    setDetailLoading(true);
    try {
      const data = await get<NetworkInspect>('/api/networks/' + encodeURIComponent(detailTarget.Id));
      setDetailInfo(data);
    } catch (e: any) {
      showToast(e?.message || '刷新网络详情失败', 'error');
    } finally {
      setDetailLoading(false);
    }
  }, [detailTarget, showToast]);

  /**
   * 将容器连接到当前网络
   */
  const handleConnect = useCallback(async () => {
    if (!detailTarget) return;
    if (!canDelete || checking) {
      showToast(checking ? '正在确认权限，请稍候' : '仅管理员可连接容器到网络', 'error');
      return;
    }
    if (!connectContainer) {
      showToast('请选择要连接的容器', 'error');
      return;
    }
    setConnecting(true);
    try {
      await post('/api/networks/' + encodeURIComponent(detailTarget.Id) + '/connect', {
        container: connectContainer,
        ipv4Address: connectIpv4.trim() || undefined,
      });
      showToast('容器连接成功');
      setConnectContainer('');
      setConnectIpv4('');
      await refreshDetail();
    } catch (e: any) {
      showToast(e?.message || '容器连接失败', 'error');
    } finally {
      setConnecting(false);
    }
  }, [detailTarget, connectContainer, connectIpv4, showToast, refreshDetail, canDelete, checking]);

  /**
   * 将容器从当前网络断开
   * @param containerId 容器 id（或名称）
   */
  const handleDisconnect = useCallback(
    async (containerId: string) => {
      if (!detailTarget) return;
      if (!canDelete || checking) {
        showToast(checking ? '正在确认权限，请稍候' : '仅管理员可从网络断开容器', 'error');
        return;
      }
      setDisconnectId(containerId);
      try {
        await post('/api/networks/' + encodeURIComponent(detailTarget.Id) + '/disconnect', {
          container: containerId,
        });
        showToast('容器已断开');
        await refreshDetail();
      } catch (e: any) {
        showToast(e?.message || '断开容器失败', 'error');
      } finally {
        setDisconnectId(null);
      }
    },
    [detailTarget, showToast, refreshDetail, canDelete, checking]
  );

  /** 已连接容器的标识集合（id 与名称），用于过滤下拉中已连接的容器 */
  const connectedIds = new Set<string>();
  if (detailInfo?.Containers) {
    for (const [cid, c] of Object.entries(detailInfo.Containers)) {
      connectedIds.add(cid);
      if (c.Name) connectedIds.add(c.Name);
    }
  }

  return (
    <div className="page">
      <Card
        title="网络"
        extra={
          <div className="toolbar">
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)}>
              刷新
            </Button>
            <Button variant="secondary" onClick={() => setPruneOpen(true)} disabled={!canDelete}>
              清理未使用
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={!canDelete}>
              新建网络
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="拉取网络列表失败"
            description={loadError || '请检查 Docker 引擎连接后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={fetchNetworks}>
                重试
              </Button>
            }
          />
        ) : networks.length === 0 ? (
          <Empty title="暂无网络" description="点击右上角" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>驱动</th>
                <th>作用域</th>
                <th>子网</th>
                <th>内部</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {networks.map((net) => (
                <tr key={net.Id || net.Name}>
                  <td className="col-name">
                    <div className="name-main" title={net.Name}>
                      {net.Name}
                    </div>
                    <div className="name-sub">{net.Id}</div>
                  </td>
                  <td>
                    <span className="badge badge--muted">{net.Driver}</span>
                  </td>
                  <td>{net.Scope}</td>
                  <td className="col-mono">{getSubnet(net)}</td>
                  <td>
                    <span className={`badge ${net.Internal ? 'badge--primary' : 'badge--muted'}`}>
                      {net.Internal ? '是' : '否'}
                    </span>
                  </td>
                  <td className="col-actions">
                    <Button variant="ghost" size="sm" onClick={() => handleOpenDetail(net)}>
                      详情
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(net)} disabled={!canDelete}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 新建网络弹窗 */}
      <Modal
        open={createOpen}
        title="新建网络"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button onClick={handleCreate} loading={creating}>
              创建
            </Button>
          </>
        }
      >
        <Field label="名称" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="网络名称"
            autoFocus
          />
        </Field>
        <Field label="驱动" hint="默认 bridge">
          <Input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="bridge" />
        </Field>
        <Field label="子网" hint="例如：172.20.0.0/16（可选）">
          <Input value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="子网网段" />
        </Field>
        <Field label="网关" hint="例如：172.20.0.1（可选，需配合子网使用）">
          <Input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="网关地址" />
        </Field>
        <Field label="IP 段（IPRange）" hint="例如：172.20.0.0/24（可选，限制自动分配范围）">
          <Input
            value={ipRange}
            onChange={(e) => setIpRange(e.target.value)}
            placeholder="IP 段网段"
          />
        </Field>
        <Field label="内部网络">
          <label className="create-checkbox">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              disabled={creating}
            />
            限制外部访问，仅允许本网络内互通
          </label>
        </Field>
        <Field label="启用 IPv6">
          <label className="create-checkbox">
            <input
              type="checkbox"
              checked={ipv6}
              onChange={(e) => setIpv6(e.target.checked)}
              disabled={creating}
            />
            为网络启用 IPv6 地址
          </label>
        </Field>
      </Modal>

      {/* 删除网络确认框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除网络"
        message={`确定要删除网络 "${deleteTarget?.Name}" 吗？`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 清理未使用网络确认框 */}
      <ConfirmDialog
        open={pruneOpen}
        title="清理未使用网络"
        message="将批量断开并删除所有未被任何容器连接的网络，此操作不可恢复。是否继续？"
        confirmText="清理"
        danger
        loading={pruning}
        onConfirm={handlePrune}
        onCancel={() => setPruneOpen(false)}
      />

      {/* 网络详情弹窗 */}
      <Modal
        open={!!detailTarget}
        title="网络详情"
        onClose={handleCloseDetail}
        width={680}
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseDetail}>
              关闭
            </Button>
            <Button variant="secondary" onClick={refreshDetail} loading={detailLoading}>
              刷新
            </Button>
          </>
        }
      >
        {detailLoading && !detailInfo ? (
          <SkeletonRows rows={6} />
        ) : (
          <>
            <div className="detail">
              <div className="detail__row">
                <span className="detail__label">名称</span>
                <span className="detail__value">{detailInfo?.Name || detailTarget?.Name}</span>
              </div>
              <div className="detail__row">
                <span className="detail__label">ID</span>
                <span className="detail__value detail__mono">{detailInfo?.Id || detailTarget?.Id}</span>
              </div>
              <div className="detail__row">
                <span className="detail__label">驱动</span>
                <span className="detail__value">{detailInfo?.Driver || detailTarget?.Driver}</span>
              </div>
              <div className="detail__row">
                <span className="detail__label">作用域</span>
                <span className="detail__value">{detailInfo?.Scope || detailTarget?.Scope}</span>
              </div>
              <div className="detail__row">
                <span className="detail__label">IPAM 驱动</span>
                <span className="detail__value">{detailInfo?.IPAM?.Driver || '-'}</span>
              </div>
              <div className="detail__row">
                <span className="detail__label">子网</span>
                <span className="detail__value detail__mono">
                  {detailInfo?.IPAM?.Config?.[0]?.Subnet ||
                    (detailTarget ? getSubnet(detailTarget) : '-')}
                </span>
              </div>
              <div className="detail__row">
                <span className="detail__label">内部</span>
                <span className="detail__value">
                  {(detailInfo?.Internal ?? detailTarget?.Internal) ? '是' : '否'}
                </span>
              </div>
              <div className="detail__row">
                <span className="detail__label">启用IPv6</span>
                <span className="detail__value">
                  {(detailInfo?.EnableIPv6 ?? detailTarget?.EnableIPv6) ? '是' : '否'}
                </span>
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-section__header">
                <span>已连接容器</span>
                <span className="detail-section__count">
                  {detailInfo?.Containers ? Object.keys(detailInfo.Containers).length : 0} 个
                </span>
              </div>
              {detailInfo?.Containers && Object.keys(detailInfo.Containers).length > 0 ? (
                <table className="net-cont-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>IPv4 地址</th>
                      <th>别名</th>
                      <th className="col-actions">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(detailInfo.Containers).map(([cid, c]) => (
                      <tr key={cid}>
                        <td className="col-name">
                          <div className="name-main" title={c.Name}>
                            {c.Name}
                          </div>
                        </td>
                        <td className="col-mono">{c.IPv4Address || '-'}</td>
                        <td className="col-mono">
                          {c.Aliases && c.Aliases.length > 0 ? c.Aliases.join(', ') : '-'}
                        </td>
                        <td className="col-actions">
                          <Button
                            variant="danger"
                            size="sm"
                            loading={disconnectId === cid || disconnectId === c.Name}
                            disabled={!canDelete}
                            onClick={() => handleDisconnect(c.Name || cid)}
                          >
                            断开
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty title="暂无已连接容器" description="通过下方表单连接容器" />
              )}
            </div>

            <div className="detail-section">
              <div className="detail-section__header">
                <span>连接容器</span>
              </div>
              {connectedIds.size > 0 ? (
                <div className="connect-form">
                  <Field label="选择容器">
                    <Select
                      value={connectContainer}
                      onChange={(e) => setConnectContainer(e.target.value)}
                    >
                      <option value="">请选择容器</option>
                      {containers
                        .filter((c) => !connectedIds.has(c.Id) && !connectedIds.has(c.Names[0] || ''))
                        .map((c) => {
                          const cname = (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id);
                          return (
                            <option key={c.Id} value={cname}>
                              {cname || c.Id}
                            </option>
                          );
                        })}
                    </Select>
                  </Field>
                  <Field label="IPv4 地址" hint="可选，不填则由 Docker 自动分配">
                    <Input
                      value={connectIpv4}
                      onChange={(e) => setConnectIpv4(e.target.value)}
                      placeholder="例如：172.20.0.10"
                    />
                  </Field>
                  <div className="connect-form__actions">
                    <Button onClick={handleConnect} loading={connecting} disabled={!canDelete}>
                      连接
                    </Button>
                  </div>
                </div>
              ) : (
                <Empty title="暂无可连接容器" description="当前全部容器已连接至该网络" />
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
