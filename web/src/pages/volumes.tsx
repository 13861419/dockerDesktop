/**
 * 数据卷列表页
 *
 * 展示 Docker 数据卷，支持刷新、新建数据卷、删除数据卷与清理未使用数据卷。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { Field, Input, Select } from '../components/Form';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del, download } from '../api/client';
import { useCanManage } from '../hooks/useCanManage';
import { VolumeItem } from '../types';
import VolumeFileExplorer from '../components/VolumeFileExplorer';
import { translateNow as t } from '../i18n';
import './volumes.less';

/**
 * 将 ISO 时间字符串格式化为本地可读时间
 * @param iso ISO8601 时间字符串
 */
function formatTime(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** 数据卷 inspect 结果（/api/volumes/:name 返回，dockerode VolumeInspectInfo） */
interface VolumeInspect {
  Name: string;
  Driver: string;
  Mountpoint: string;
  CreatedAt: string;
  Labels: Record<string, string> | null;
  Scope: string;
  Options: Record<string, string> | null;
  UsageData?: { Size?: number; RefCount?: number } | null;
}

/** 容器挂载项（/api/containers 列表返回结构中的 Mounts） */
interface ContainerMountInfo {
  Type?: string;
  Name?: string;
  Source?: string;
}

/** 容器列表项（/api/containers?all=true 返回结构，含 Mounts） */
interface VolumeContainerItem {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Mounts?: ContainerMountInfo[];
}

/**
 * 将字节数格式化为人类可读大小
 * @param bytes 字节数
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 数据卷列表页组件
 */
export default function VolumesPage() {
  const { showToast } = useToast();
  // 是否可写（创建/删除/清理）：仅管理员可用；普通用户可只读浏览。
  // 采用服务端权威角色判定（useCanManage），防止基于被篡改的 localStorage 误放行
const { checking, hasPerm } = useCanManage();
const canWrite = hasPerm('volumes.write');
const canDelete = hasPerm('volumes.delete');
const canPrune = hasPerm('volumes.prune');
  const [volumes, setVolumes] = useState<VolumeItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 卷名 -> 引用它的容器名数组（用于列表展示「使用中」状态与挂载容器）
  const [volumeUsage, setVolumeUsage] = useState<Record<string, string[]>>({});
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [driver, setDriver] = useState('local');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<VolumeItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 搜索关键字（按名称/挂载点本地过滤）
  const [keyword, setKeyword] = useState('');
  // 按标签筛选：'' 表示不过滤，值如 'com.docker.compose.project=web'（key=value 完整对）
  const [labelFilter, setLabelFilter] = useState('');
  /** 分页每页条数可选值 */
  const PAGE_SIZE_OPTIONS = [15, 30, 50];
  // 当前页码（从 1 开始）
  const [page, setPage] = useState(1);
  // 每页条数（可在运行时切换）
  const [pageSize, setPageSize] = useState(15);
  // 分页跳转：输入的目标页码
  const [pageJump, setPageJump] = useState('');
  // 待查看详情的卷（用于打开详情弹窗）
  const [detailTarget, setDetailTarget] = useState<VolumeItem | null>(null);
  // 卷 inspect 详情（弹窗内拉取）
  const [detail, setDetail] = useState<VolumeInspect | null>(null);
  // 详情弹窗加载中
  const [detailLoading, setDetailLoading] = useState(false);
  // 使用该卷的容器列表
  const [usingContainers, setUsingContainers] = useState<VolumeContainerItem[]>([]);
  // 使用该卷的容器列表加载中
  const [containersLoading, setContainersLoading] = useState(false);
  // 待浏览文件的数据卷（用于打开浏览弹窗）
  const [browseTarget, setBrowseTarget] = useState<VolumeItem | null>(null);
  // 待备份的数据卷（用于打开备份弹窗）
  const [backupTarget, setBackupTarget] = useState<VolumeItem | null>(null);
  // 备份名称（默认 "卷-<name>-<时间>"）
  const [backupName, setBackupName] = useState('');
  // 备份提交进行中
  const [backingUp, setBackingUp] = useState(false);
  // 克隆弹窗状态
  const [cloneTarget, setCloneTarget] = useState<VolumeItem | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloning, setCloning] = useState(false);
  // 正在导出 tar 的卷名（用于该行导出按钮独立 loading）
  const [exportingName, setExportingName] = useState('');

  const fetchVolumes = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<{ volumes: VolumeItem[] }>('/api/volumes');
      const vols = data?.volumes || [];
      setVolumes(vols);
      setLoadError('');
      // 拉取容器列表，构建「卷名 -> 引用它的容器名」映射，用于列表展示使用状态
      try {
        const containers = await get<VolumeContainerItem[]>('/api/containers', { all: true });
        const usage: Record<string, string[]> = {};
        vols.forEach((v) => (usage[v.Name] = []));
        (containers || []).forEach((c) => {
          const cname = (c.Names && c.Names[0]?.replace(/^\//, '')) || c.Id?.slice(0, 12);
          (c.Mounts || []).forEach((m) => {
            if (m && m.Name && usage[m.Name] && !usage[m.Name].includes(cname)) {
              usage[m.Name].push(cname);
            }
          });
        });
        setVolumeUsage(usage);
      } catch {
        // 容器映射拉取失败时保留空映射，仅影响状态增强展示
      }
    } catch (e: any) {
      setLoadError(e?.message || t('拉取数据卷列表失败'));
      showToast(e?.message || t('拉取数据卷列表失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchVolumes();
  }, [fetchVolumes, refreshKey]);

  const handleCreate = useCallback(async () => {
    const volName = name.trim();
    if (!volName) {
      showToast(t('请输入数据卷名称'), 'error');
      return;
    }
    if (!canWrite || checking) {
      showToast(checking ? t('正在确认权限，请稍候') : t('缺少数据卷管理权限'), 'error');
      setCreateOpen(false);
      return;
    }
    setCreating(true);
    try {
      await post('/api/volumes', { name: volName, driver });
      showToast(t('数据卷创建成功'));
      setCreateOpen(false);
      setName('');
      setDriver('local');
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('数据卷创建失败'), 'error');
    } finally {
      setCreating(false);
    }
  }, [name, driver, showToast, canWrite, checking]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (checking) {
      showToast(t('正在确认权限，请稍候'), 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      const resp = await del<{ approvalPending?: boolean }>('/api/volumes/' + encodeURIComponent(deleteTarget.Name));
      if (resp?.approvalPending) {
        showToast(t('该操作已提交审批，等待管理员批准后执行'), 'info');
      } else {
        showToast(t('数据卷删除成功'));
      }
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('数据卷删除失败'), 'error');
    } finally {
      setDeleting(false);
    }
  }, [checking, deleteTarget, showToast]);

  const handlePrune = useCallback(async () => {
    if (checking) {
      showToast(t('正在确认权限，请稍候'), 'error');
      setPruneOpen(false);
      return;
    }
    setPruning(true);
    try {
      const resp = await post<{ approvalPending?: boolean }>('/api/volumes/prune');
      showToast(resp?.approvalPending ? t('该操作已提交审批，等待管理员批准后执行') : t('清理完成'), resp?.approvalPending ? 'info' : 'success');
      setPruneOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('清理失败'), 'error');
    } finally {
      setPruning(false);
    }
  }, [canDelete, checking, showToast]);

  /**
   * 打开数据卷的备份弹窗，并生成默认备份名 "卷-<卷名>-<时间戳>"
   * @param vol 目标卷
   */
  const openBackup = useCallback((vol: VolumeItem) => {
    setBackupTarget(vol);
    setBackupName(t('卷-{{v1}}-{{v2}}', { v1: vol.Name, v2: new Date().toISOString() }));
  }, []);

  /**
   * 打开克隆弹窗，默认目标卷名 "<源卷名>-clone"（若已存在则追加时间戳）
   * @param vol 目标卷
   */
  const openClone = useCallback((vol: VolumeItem) => {
    setCloneTarget(vol);
    const base = `${vol.Name}-clone`;
    setCloneName(volumes.some((v) => v.Name === base) ? `${base}-${Date.now()}` : base);
  }, [volumes]);

  /** 提交克隆：调用 /api/volumes/:name/clone，成功后刷新列表 */
  const handleClone = useCallback(async () => {
    if (!cloneTarget || cloning) return;
    const target = cloneName.trim();
    if (!target) {
      showToast(t('请输入目标卷名'), 'error');
      return;
    }
    if (!canWrite || checking) {
      showToast(checking ? t('正在确认权限，请稍候') : t('缺少数据卷管理权限'), 'error');
      setCloneTarget(null);
      return;
    }
    setCloning(true);
    try {
      await post(`/api/volumes/${encodeURIComponent(cloneTarget.Name)}/clone`, { name: target });
      showToast(t('数据卷已克隆为 "{{target}}"', { target }));
      setCloneTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('克隆数据卷失败'), 'error');
    } finally {
      setCloning(false);
    }
  }, [cloneTarget, cloneName, cloning, canWrite, checking, showToast]);

  /**
   * 导出数据卷为 tar 下载
   * @param vol 目标卷
   */
  const handleExport = useCallback(async (vol: VolumeItem) => {
    setExportingName(vol.Name);
    try {
      await download(`/api/volumes/${encodeURIComponent(vol.Name)}/export`, `${vol.Name}.tar`);
      showToast(t('数据卷已导出'));
    } catch (e: any) {
      showToast(e?.message || t('导出数据卷失败'), 'error');
    } finally {
      setExportingName('');
    }
  }, [showToast]);

  /**
   * 提交数据卷备份：调用 /api/backups 创建备份
   */
  const handleBackup = useCallback(async () => {
    if (!backupTarget || backingUp) return;
    const finalName = backupName.trim();
    if (!finalName) {
      showToast(t('请输入备份名称'), 'error');
      return;
    }
    setBackingUp(true);
    try {
      await post('/api/backups', {
        kind: 'volume',
        name: finalName,
        source: backupTarget.Name,
      });
      showToast(t('数据卷备份已创建，可到「备份」页下载'));
      setBackupTarget(null);
    } catch (e: any) {
      showToast(e?.message || t('创建备份失败'), 'error');
    } finally {
      setBackingUp(false);
    }
  }, [backupTarget, backingUp, backupName, showToast]);

  /**
   * 打开卷详情弹窗并触发详情与使用容器列表的加载
   * @param vol 目标卷
   */
  const openDetail = useCallback((vol: VolumeItem) => {
    setDetail(null);
    setUsingContainers([]);
    setDetailTarget(vol);
  }, []);

  /** 拉取指定卷的 inspect 详情 */
  const fetchVolumeDetail = useCallback(
    async (name: string) => {
      setDetailLoading(true);
      try {
        const data = await get<VolumeInspect>('/api/volumes/' + encodeURIComponent(name));
        setDetail(data || null);
      } catch (e: any) {
        showToast(e?.message || t('拉取卷详情失败'), 'error');
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [showToast]
  );

  /** 拉取容器列表并过滤出使用该卷的容器（按 HostConfig.Mounts 的 Source/Name 匹配） */
  const fetchUsingContainers = useCallback(
    async (volName: string) => {
      setContainersLoading(true);
      try {
        const data = await get<VolumeContainerItem[]>('/api/containers', { all: true });
        const list = (data || []).filter((c) =>
          (c.Mounts || []).some(
            (m) => m.Name === volName || (m.Source || '').includes(volName)
          )
        );
        setUsingContainers(list);
      } catch (e: any) {
        showToast(e?.message || t('拉取容器列表失败'), 'error');
        setUsingContainers([]);
      } finally {
        setContainersLoading(false);
      }
    },
    [showToast]
  );

  // 当详情弹窗打开时，加载该卷的 inspect 与使用该卷的容器
  useEffect(() => {
    if (!detailTarget) return;
    fetchVolumeDetail(detailTarget.Name);
    fetchUsingContainers(detailTarget.Name);
  }, [detailTarget, fetchVolumeDetail, fetchUsingContainers]);

  /** 根据关键字过滤后的卷列表（按名称或挂载点匹配） */
  const filteredVolumes = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let list = volumes;
    if (kw) {
      list = list.filter(
        (vol) =>
          vol.Name.toLowerCase().includes(kw) ||
          (vol.Mountpoint || '').toLowerCase().includes(kw)
      );
    }
    if (labelFilter) {
      const idx = labelFilter.indexOf('=');
      const key = labelFilter.slice(0, idx);
      const value = labelFilter.slice(idx + 1);
      list = list.filter((vol) => (vol.Labels || {})[key] === value);
    }
    return list;
  }, [volumes, keyword, labelFilter]);

  /** 标签下拉选项：聚合卷列表中的全部 key=value 标签，按使用次数降序 */
  const volumeLabelOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const vol of volumes) {
      const labels = vol.Labels || {};
      for (const [k, v] of Object.entries(labels)) {
        const pair = `${k}=${v ?? ''}`;
        counts.set(pair, (counts.get(pair) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([pair]) => pair);
  }, [volumes]);

  /** 总页数（至少 1 页） */
  const totalPages = Math.max(1, Math.ceil(filteredVolumes.length / pageSize));

  /** 当前页码：当分页组合变化导致页码越界时，回退到最大有效页 */
  const safePage = Math.min(page, Math.max(1, totalPages));

  /** 切换每页条数：回到第一页并清空跳转输入 */
  function changePageSize(size: number) {
    setPageSize(size);
    setPage(1);
    setPageJump('');
  }

  /** 跳转到指定页码（限制在有效范围内） */
  function handlePageJump() {
    const n = parseInt(pageJump, 10);
    if (isNaN(n)) {
      setPageJump('');
      return;
    }
    const target = Math.min(Math.max(1, n), totalPages);
    setPage(target);
    setPageJump('');
  }

  /** 当前页起始序号（用于"第 x-y 条"展示，空列表时为 0） */
  const pageStart = filteredVolumes.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  /** 当前页结束序号 */
  const pageEnd = Math.min(safePage * pageSize, filteredVolumes.length);

  /** 当前页要展示的数据卷 */
  const pageItems = filteredVolumes.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="page">
      <Card
        title={t('数据卷')}
        extra={
          <div className="toolbar">
            <Select
              className="volumes-label-filter"
              value={labelFilter}
              onChange={(e) => {
                setLabelFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('全部标签')}</option>
              {volumeLabelOptions.map((pair) => (
                <option key={pair} value={pair}>
                  {pair}
                </option>
              ))}
            </Select>
            <input
              className="input volumes-search"
              placeholder={t('搜索卷名或挂载点')}
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)}>
              {t('刷新')}
            </Button>
            <Button variant="secondary" onClick={() => setPruneOpen(true)} disabled={!canPrune}>
              {t('清理未使用卷')}
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={!canWrite}>
              {t('新建卷')}
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title={t('拉取数据卷列表失败')}
            description={loadError || t('请检查 Docker 引擎连接后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={fetchVolumes}>
                {t('重试')}
              </Button>
            }
          />
        ) : filteredVolumes.length === 0 ? (
          <Empty
            kind={keyword ? 'search' : 'empty'}
            title={keyword ? t('未找到匹配数据卷') : t('暂无数据卷')}
            description={keyword ? t('尝试更换搜索关键字') : t('点击右上角')}
          />
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('名称')}</th>
                  <th>{t('驱动')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('大小')}</th>
                  <th>{t('挂载点')}</th>
                  <th>{t('创建时间')}</th>
                  <th className="col-actions">{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((vol) => (
                <tr key={vol.Name}>
                  <td className="col-name">
                    <div className="name-main" title={vol.Name}>
                      {vol.Name}
                    </div>
                  </td>
                  <td>
                    <span className="badge badge--muted">{vol.Driver}</span>
                  </td>
                  <td className="vol-status">
                    <span
                      className={`badge ${(volumeUsage[vol.Name] || []).length ? 'badge--used' : 'badge--unused'}`}
                      title={
                        (volumeUsage[vol.Name] || []).length
                          ? t('被容器引用：{{v1}}', { v1: (volumeUsage[vol.Name] || []).join(', ') })
                          : t('未被任何容器引用')
                      }
                    >
                      {(volumeUsage[vol.Name] || []).length
                        ? t('使用中 · {{v1}}', { v1: (volumeUsage[vol.Name] || []).join(', ') })
                        : t('未使用')}
                    </span>
                  </td>
                  <td>{vol.UsageData?.Size != null ? formatBytes(vol.UsageData.Size) : '-'}</td>
                  <td className="col-mono" title={vol.Mountpoint}>
                    {vol.Mountpoint}
                  </td>
                  <td>{formatTime(vol.CreatedAt)}</td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <Button variant="ghost" size="sm" onClick={() => setBrowseTarget(vol)}>
                        {t('浏览')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openBackup(vol)}>
                        {t('备份')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openClone(vol)} disabled={!canWrite}>
                        {t('克隆')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExport(vol)}
                        loading={exportingName === vol.Name}
                        disabled={!canWrite}
                      >
                        {t('导出')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openDetail(vol)}>
                        {t('详情')}
                      </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(vol)} disabled={!canDelete}>
                        {t('删除')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              </tbody>
            </table>

            {/* 分页控件 */}
            <div className="volumes__pagination">
              <div className="volumes__pagination-left">
                <span className="volumes__pagination-size">
                  {t('每页')}
                  <Select
                    className="volumes__pagesize"
                    value={String(pageSize)}
                    onChange={(e) => changePageSize(Number(e.target.value))}
                  >
                    {PAGE_SIZE_OPTIONS.map((s) => (
                      <option key={s} value={String(s)}>
                        {s}
                      </option>
                    ))}
                  </Select>
                  {t('条')}
                </span>
                <span className="volumes__pagination-info">
                  {t('共 {{total}} 条，当前第 {{start}}-{{end}} 条', { total: filteredVolumes.length, start: pageStart, end: pageEnd })}
                </span>
              </div>
              <div className="volumes__pagination-controls">
                <button
                  className="volumes__page-btn"
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}
                >
                  {t('上一页')}
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    className={`volumes__page-btn ${p === safePage ? 'volumes__page-btn--active' : ''}`}
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </button>
                ))}
                <button
                  className="volumes__page-btn"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                >
                  {t('下一页')}
                </button>
                <span className="volumes__page-jump">
                  <Input
                    className="volumes__page-jump-input"
                    type="number"
                    min={1}
                    max={totalPages}
                    placeholder={t('页码')}
                    value={pageJump}
                    onChange={(e) => setPageJump(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handlePageJump();
                    }}
                  />
                  <Button variant="ghost" size="sm" onClick={handlePageJump}>
                    {t('跳转')}
                  </Button>
                </span>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* 卷详情弹窗 */}
      <Modal
        open={!!detailTarget}
        title={detailTarget ? t('卷详情 · {{v1}}', { v1: detailTarget.Name }) : t('卷详情')}
        onClose={() => setDetailTarget(null)}
        width={620}
      >
        <div className="vol-detail">
          {detailLoading ? (
            <div className="vol-detail__tip">{t('加载中…')}</div>
          ) : !detail ? (
            <div className="vol-detail__tip">{t('未能加载卷详情')}</div>
          ) : (
            <div className="vol-detail__grid">
              <div className="vol-detail__item">
                <div className="vol-detail__label">{t('名称')}</div>
                <div className="vol-detail__value mono">{detail.Name}</div>
              </div>
              <div className="vol-detail__item">
                <div className="vol-detail__label">{t('驱动')}</div>
                <div className="vol-detail__value">{detail.Driver}</div>
              </div>
              <div className="vol-detail__item vol-detail__item--full">
                <div className="vol-detail__label">{t('挂载点')}</div>
                <div className="vol-detail__value mono">{detail.Mountpoint}</div>
              </div>
              <div className="vol-detail__item">
                <div className="vol-detail__label">{t('创建时间')}</div>
                <div className="vol-detail__value">{formatTime(detail.CreatedAt)}</div>
              </div>
              <div className="vol-detail__item">
                <div className="vol-detail__label">{t('作用域')}</div>
                <div className="vol-detail__value">{detail.Scope || '-'}</div>
              </div>
              <div className="vol-detail__item vol-detail__item--full">
                <div className="vol-detail__label">{t('选项（Options）')}</div>
                <div className="vol-detail__value">
                  {detail.Options && Object.keys(detail.Options).length ? (
                    <div className="line-list">
                      {Object.entries(detail.Options).map(([k, v]) => (
                        <span className="tag-chip" key={k}>
                          {k}={v}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )}
                </div>
              </div>
              <div className="vol-detail__item vol-detail__item--full">
                <div className="vol-detail__label">{t('标签（Labels）')}</div>
                <div className="vol-detail__value">
                  {detail.Labels && Object.keys(detail.Labels).length ? (
                    <div className="line-list">
                      {Object.entries(detail.Labels).map(([k, v]) => (
                        <span className="tag-chip" key={k}>
                          {k}={v}
                        </span>
                      ))}
                    </div>
                  ) : (
                    '-'
                  )}
                </div>
              </div>
              <div className="vol-detail__item">
                <div className="vol-detail__label">{t('引用数（RefCount）')}</div>
                <div className="vol-detail__value">
                  {detail.UsageData?.RefCount != null ? detail.UsageData.RefCount : '-'}
                </div>
              </div>
              <div className="vol-detail__item">
                <div className="vol-detail__label">{t('数据大小')}</div>
                <div className="vol-detail__value">
                  {detail.UsageData?.Size != null ? formatBytes(detail.UsageData.Size) : '-'}
                </div>
              </div>
            </div>
          )}

          <div className="vol-detail__section">{t('使用该卷的容器')}</div>
          {containersLoading ? (
            <div className="vol-detail__tip">{t('加载中…')}</div>
          ) : usingContainers.length === 0 ? (
            <div className="vol-detail__tip">{t('暂无容器使用该卷')}</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('名称')}</th>
                  <th>{t('镜像')}</th>
                  <th>{t('状态')}</th>
                </tr>
              </thead>
              <tbody>
                {usingContainers.map((c) => {
                  const cname = (c.Names && c.Names[0]?.replace(/^\//, '')) || c.Id.slice(0, 12);
                  return (
                    <tr key={c.Id}>
                      <td className="col-name">
                        <div className="name-main" title={cname}>
                          {cname}
                        </div>
                      </td>
                      <td>{c.Image}</td>
                      <td>{c.State}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Modal>

      {/* 数据卷文件浏览弹窗 */}
      <Modal
        open={!!browseTarget}
        title={browseTarget ? t('文件浏览 · {{v1}}', { v1: browseTarget.Name }) : t('文件浏览')}
        onClose={() => setBrowseTarget(null)}
        width={880}
      >
        {browseTarget && <VolumeFileExplorer volume={browseTarget.Name} />}
      </Modal>

      {/* 数据卷备份弹窗 */}
      <Modal
        open={!!backupTarget}
        title={t('备份数据卷')}
        onClose={() => !backingUp && setBackupTarget(null)}
        width={460}
        footer={
          <>
            <Button variant="secondary" onClick={() => setBackupTarget(null)} disabled={backingUp}>
              {t('取消')}
            </Button>
            <Button onClick={handleBackup} loading={backingUp}>
              {t('开始备份')}
            </Button>
          </>
        }
      >
        <Field label={t('备份名称')} required hint={t('创建完成后可到「备份」页下载')}>
          <Input
            value={backupName}
            onChange={(e) => setBackupName(e.target.value)}
            placeholder={t('备份名称')}
            autoFocus
            disabled={backingUp}
          />
        </Field>
      </Modal>

      {/* 新建数据卷弹窗 */}
      <Modal
        open={createOpen}
        title={t('新建数据卷')}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t('取消')}
            </Button>
            <Button onClick={handleCreate} loading={creating}>
              {t('创建')}
            </Button>
          </>
        }
      >
        <Field label={t('名称')} required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('数据卷名称')}
            autoFocus
          />
        </Field>
        <Field label={t('驱动')} hint={t('默认 local')}>
          <Input value={driver} onChange={(e) => setDriver(e.target.value)} placeholder="local" />
        </Field>
      </Modal>

      {/* 克隆数据卷弹窗 */}
      <Modal
        open={!!cloneTarget}
        title={t('克隆数据卷')}
        onClose={() => !cloning && setCloneTarget(null)}
        width={460}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCloneTarget(null)} disabled={cloning}>
              {t('取消')}
            </Button>
            <Button onClick={handleClone} loading={cloning}>
              {t('开始克隆')}
            </Button>
          </>
        }
      >
        <Field
          label={t('源数据卷')}
          hint={cloneTarget ? t('挂载点：{{v1}}', { v1: cloneTarget.Mountpoint }) : undefined}
        >
          <Input value={cloneTarget?.Name || ''} disabled />
        </Field>
        <Field label={t('目标卷名')} required hint={t('将创建新卷并完整复制源卷数据，耗时取决于数据量')}>
          <Input
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
            placeholder={t('目标卷名')}
            autoFocus
            disabled={cloning}
          />
        </Field>
      </Modal>

      {/* 删除数据卷确认框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('删除数据卷')}
        message={t('确定要删除数据卷 "{{v1}}" 吗？此操作不可恢复。', { v1: deleteTarget?.Name || '' })}
        confirmText={t('删除')}
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 清理未使用数据卷确认框 */}
      <ConfirmDialog
        open={pruneOpen}
        title={t('清理未使用数据卷')}
        message={t('确定要清理所有未被容器引用的数据卷吗？此操作不可恢复。')}
        confirmText={t('清理')}
        danger
        loading={pruning}
        onConfirm={handlePrune}
        onCancel={() => setPruneOpen(false)}
      />
    </div>
  );
}
