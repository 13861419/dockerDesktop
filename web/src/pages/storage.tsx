/**
 * 系统存储管理页
 *
 * 顶部展示磁盘使用统计（镜像 / 容器 / 卷 / build cache），
 * 下方提供各类别勾选后的「一键清理」（含二次确认），清理后自动刷新统计。
 * 额外提供按粒度选择的「镜像清理」：悬空镜像（dangling）与全部未使用镜像。
 */
import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import ConfirmDialog from '../components/ConfirmDialog';
import Empty from '../components/Empty';
import { useToast } from '../components/Toast';
import { get, post } from '../api/client';
import { useCanManage } from '../hooks/useCanManage';
import { translateNow as t } from '../i18n';
import './storage.less';

/** df 概要字段（后端 /api/system/df 返回的 summary） */
interface DfSummary {
  layersSize?: number;
  buildCacheCount?: number;
  buildCacheSize?: number;
  imagesCount?: number;
  imagesSize?: number;
  containersCount?: number;
  containersSizeRw?: number;
  volumesCount?: number;
  volumesSize?: number;
  totalReclaimable?: number;
  // 各类型精确可回收空间（后端新增）
  imagesReclaimable?: number;
  containersReclaimable?: number;
  volumesReclaimable?: number;
  buildCacheReclaimable?: number;
}

/** df 接口返回结构 */
interface DfResponse {
  df?: any;
  summary?: DfSummary;
}

/** prune 各类别清理结果 */
interface PruneItemResult {
  objects: string[];
  space: number;
}

/** 宿主机磁盘分区信息（与后端监控器字段一致） */
interface DiskPartition {
  mount: string;
  total: number;
  used: number;
  free: number;
  percent: number;
}

/** 清理类别定义：key 与后端 body 字段对应 */
interface CleanCategory {
  key: 'images' | 'containers' | 'volumes' | 'networks' | 'buildCache';
  name: string;
  desc: string;
}

/** 清理类别列表 */
const CLEAN_CATEGORIES: CleanCategory[] = [
  { key: 'images', name: t('未使用的镜像'), desc: t('清理所有未被引用的镜像（悬挂/未使用），右侧为精确可回收量') },
  { key: 'containers', name: t('已停止的容器'), desc: t('清理所有已停止、未被使用的容器，右侧为可回收量') },
  { key: 'volumes', name: t('未使用的数据卷'), desc: t('清理所有未被任何容器引用的数据卷，右侧为可回收量') },
  { key: 'networks', name: t('未使用的网络'), desc: t('清理所有未被任何容器引用的网络') },
  { key: 'buildCache', name: 'Build Cache', desc: t('清理全部构建缓存（含非悬空缓存），右侧为可回收量') },
];

/** 清理类别对应的待回收空间（优先展示后端精确可回收量，缺失时回退整类占用） */
function categorySpace(category: CleanCategory, summary?: DfSummary): number {
  switch (category.key) {
    case 'images':
      return (summary?.imagesReclaimable ?? summary?.imagesSize) || 0;
    case 'containers':
      return (summary?.containersReclaimable ?? summary?.containersSizeRw) || 0;
    case 'volumes':
      return (summary?.volumesReclaimable ?? summary?.volumesSize) || 0;
    case 'networks':
      return 0;
    case 'buildCache':
      return (summary?.buildCacheReclaimable ?? summary?.buildCacheSize) || 0;
    default:
      return 0;
  }
}

/**
 * 将字节数格式化为人类可读大小
 * @param bytes 字节数
 */
function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 镜像清理粒度：dangling=仅悬空镜像，all=所有未使用镜像 */
type ImagePruneMode = 'dangling' | 'all';

/**
 * 系统存储管理页组件
 */
export default function StoragePage() {
  const { showToast } = useToast();
  // 是否可清理：一键清理为破坏性操作，仅管理员可用；普通用户可只读查看统计。
  // 采用服务端权威角色判定（useCanManage），防止基于被篡改的 localStorage 误放行
  const { canManage, checking } = useCanManage();
  const [summary, setSummary] = useState<DfSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // 已勾选的清理类别
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 一键清理确认框是否打开
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruning, setPruning] = useState(false);
  // 宿主机磁盘分区使用情况（来自实时监控）
  const [disks, setDisks] = useState<DiskPartition[]>([]);
  // 镜像清理：待确认的清理粒度（null 表示确认框关闭）
  const [imgPruneMode, setImgPruneMode] = useState<ImagePruneMode | null>(null);
  // 镜像清理进行中
  const [imgPruning, setImgPruning] = useState(false);
  // 上次镜像清理释放的空间（展示在卡片底部）
  const [imgFreed, setImgFreed] = useState('');

  /**
   * 拉取 df 磁盘统计
   */
  const loadDf = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await get<DfResponse>('/api/system/df');
      setSummary(data?.summary || null);
    } catch (e: any) {
      showToast(e?.message || t('加载磁盘统计失败'), 'error');
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  /**
   * 拉取宿主机磁盘分区使用率（/api/monitor/now）
   */
  const loadDisks = useCallback(async () => {
    try {
      const data = await get<{ disks?: DiskPartition[] }>('/api/monitor/now');
      setDisks(data?.disks || []);
    } catch {
      // 分区信息非关键，失败静默保持空
    }
  }, []);

  useEffect(() => {
    loadDf();
    loadDisks();
  }, [loadDf, loadDisks]);

  /**
   * 切换某个清理类别的勾选状态
   * @param key 类别 key
   */
  function toggleCategory(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  /**
   * 一键清理：调用后端 prune，成功后刷新统计并提示各回收空间
   */
  async function handlePrune() {
    if (!canManage || checking) {
      showToast(checking ? t('正在确认权限，请稍候') : t('仅管理员可执行清理'), 'error');
      setPruneOpen(false);
      return;
    }
    if (selected.size === 0) {
      showToast(t('请至少勾选一项清理类别'), 'error');
      return;
    }
    setPruning(true);
    try {
      const body = {
        images: selected.has('images'),
        containers: selected.has('containers'),
        volumes: selected.has('volumes'),
        networks: selected.has('networks'),
        buildCache: selected.has('buildCache'),
      };
      const data = await post<{ results: Record<string, PruneItemResult>; totalSpace: number }>(
        '/api/system/prune',
        body
      );
      // 汇总有实际回收空间的类别提示
      const freed: string[] = [];
      Object.entries(data?.results || {}).forEach(([key, item]) => {
        if (item && item.space > 0) {
          const cat = CLEAN_CATEGORIES.find((c) => c.key === key);
          freed.push(t('{{name}} {{space}}{{v2}}', { name: t(cat?.name || key), space: formatBytes(item.space), v2: item.objects.length ? t('（{{n}} 项）', { n: item.objects.length }) : '' }));
        }
      });
      showToast(
        freed.length
          ? t('清理完成，共释放 {{v1}}：{{v2}}', { v1: formatBytes(data?.totalSpace), v2: freed.join('；') })
          : t('清理完成，共释放 {{v1}}', { v1: formatBytes(data?.totalSpace) })
      );
      setPruneOpen(false);
      setSelected(new Set());
      // 清理后刷新统计
      loadDf();
    } catch (e: any) {
      showToast(e?.message || t('清理失败'), 'error');
    } finally {
      setPruning(false);
    }
  }

  /**
   * 镜像清理：按粒度调用 /api/images/prune，成功后刷新统计并展示回收空间
   */
  async function handleImagePrune() {
    if (!canManage || checking) {
      showToast(checking ? t('正在确认权限，请稍候') : t('仅管理员可执行清理'), 'error');
      setImgPruneMode(null);
      return;
    }
    if (!imgPruneMode) return;
    setImgPruning(true);
    try {
      // all=true 清理全部未使用镜像；all=false 仅清理悬空镜像
      const all = imgPruneMode === 'all';
      const res = await post<{ ok: boolean; deleted: string[]; spaceReclaimed: number }>(
        '/api/images/prune',
        { all }
      );
      const freed = res?.spaceReclaimed != null ? formatBytes(res.spaceReclaimed) : '';
      setImgFreed(freed);
      showToast(
        freed
          ? t('清理完成，释放 {{freed}}{{v2}}', { freed, v2: res?.deleted?.length ? t('（{{n}} 项）', { n: res.deleted.length }) : '' })
          : t('清理完成，未找到可清理的镜像')
      );
      setImgPruneMode(null);
      // 清理后刷新统计
      loadDf();
    } catch (e: any) {
      showToast(e?.message || t('清理失败'), 'error');
    } finally {
      setImgPruning(false);
    }
  }

  return (
    <div className="storage-page">
      {/* 顶部统计卡片 */}
      <Card title={t('磁盘使用统计')} extra={<Button variant="secondary" size="sm" onClick={loadDf} disabled={loading}>{t('刷新')}</Button>}>
        {loading ? (
          <div className="storage-tip">{t('加载中…')}</div>
        ) : loadError || !summary ? (
          <Empty
            title={t('无法获取磁盘统计')}
            description="Docker 引擎可能未连接，或暂不支持 system df"
            action={<Button size="sm" onClick={loadDf}>{t('重试')}</Button>}
          />
        ) : (
          <div className="storage-stats">
            <div className="storage-stat">
              <div className="storage-stat__label">{t('镜像')}</div>
              <div className="storage-stat__value">{summary.imagesCount ?? '-'}</div>
              <div className="storage-stat__sub">占用 {formatBytes(summary.imagesSize)}</div>
            </div>
            <div className="storage-stat">
              <div className="storage-stat__label">{t('容器')}</div>
              <div className="storage-stat__value">{summary.containersCount ?? '-'}</div>
              <div className="storage-stat__sub">可写层 {formatBytes(summary.containersSizeRw)}</div>
            </div>
            <div className="storage-stat">
              <div className="storage-stat__label">{t('数据卷')}</div>
              <div className="storage-stat__value">{summary.volumesCount ?? '-'}</div>
              <div className="storage-stat__sub">占用 {formatBytes(summary.volumesSize)}</div>
            </div>
            <div className="storage-stat">
              <div className="storage-stat__label">Build Cache</div>
              <div className="storage-stat__value">{summary.buildCacheCount ?? '-'}</div>
              <div className="storage-stat__sub">占用 {formatBytes(summary.buildCacheSize)}</div>
            </div>
            <div className="storage-stat">
              <div className="storage-stat__label">{t('总层大小')}</div>
              <div className="storage-stat__value">{formatBytes(summary.layersSize)}</div>
              <div className="storage-stat__sub">{t('镜像层合计')}</div>
            </div>
            <div className="storage-stat">
              <div className="storage-stat__label">{t('可回收')}</div>
              <div className="storage-stat__value">{formatBytes(summary.totalReclaimable)}</div>
              <div className="storage-stat__sub">{t('估算可清理空间')}</div>
            </div>
          </div>
        )}
      </Card>

      {/* 磁盘分区使用率（来自实时监控） */}
      <Card title={t('磁盘分区使用率')}>
        {disks.length === 0 ? (
          <div className="storage-tip">{t('暂无分区数据')}</div>
        ) : (
          <div className="storage-disks">
            {disks.map((d) => (
              <div key={d.mount} className="storage-disk">
                <div className="storage-disk__head">
                  <span className="storage-disk__name">{d.mount || t('系统盘')}</span>
                  <span className={`storage-disk__pct ${d.percent > 90 ? 'storage-disk__pct--high' : ''}`}>
                    {d.percent?.toFixed(1)}%
                  </span>
                </div>
                <div className="storage-disk__bar">
                  <div
                    className={`storage-disk__fill ${d.percent > 90 ? 'storage-disk__fill--high' : ''}`}
                    style={{ width: `${Math.min(100, d.percent || 0)}%` }}
                  />
                </div>
                <div className="storage-disk__sub">
                  <span>已用 {formatBytes(d.used)}</span>
                  <span>可用 {formatBytes(d.free)}</span>
                  <span>总 {formatBytes(d.total)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 镜像清理（按粒度选择） */}
      <Card title={t('镜像清理')}>
        <div className="storage-clean">
          <div className="storage-clean__item">
            <div className="storage-clean__info">
              <div className="storage-clean__name">{t('清理无标签镜像（dangling）')}</div>
              <div className="storage-clean__desc">{t('仅清理无标签且未被引用的悬空镜像，风险较低')}</div>
            </div>
            <Button
              variant="secondary"
              disabled={!canManage || imgPruning}
              onClick={() => setImgPruneMode('dangling')}
            >
              {t('清理')}
            </Button>
          </div>
          <div className="storage-clean__item">
            <div className="storage-clean__info">
              <div className="storage-clean__name">{t('清理所有未使用镜像')}</div>
              <div className="storage-clean__desc">{t('清理所有未被容器使用的镜像（含非悬空镜像），释放更多空间')}</div>
            </div>
            <Button
              variant="danger"
              disabled={!canManage || imgPruning}
              onClick={() => setImgPruneMode('all')}
            >
              {t('清理')}
            </Button>
          </div>
          {imgFreed && (
            <div className="storage-clean__hint">上次镜像清理释放空间：{imgFreed}</div>
          )}
        </div>
      </Card>

      {/* 清理区块 */}
      <Card title={t('清理')}>
        {loadError || !summary ? (
          <Empty title={t('暂无可清理项')} description="请先完成磁盘统计加载" />
        ) : (
          <div className="storage-clean">
            {CLEAN_CATEGORIES.map((cat) => {
              const checked = selected.has(cat.key);
              const space = categorySpace(cat, summary);
              return (
                <label key={cat.key} className="storage-clean__item">
                  <input
                    type="checkbox"
                    className="storage-clean__check"
                    checked={checked}
                    onChange={() => toggleCategory(cat.key)}
                  />
                  <div className="storage-clean__info">
                    <div className="storage-clean__name">{cat.name}</div>
                    <div className="storage-clean__desc">{cat.desc}</div>
                  </div>
                  <div className="storage-clean__count">
                    {cat.key === 'buildCache' ? t('{{v1}} 项', { v1: summary.buildCacheCount ?? 0 }) : ''}
                  </div>
                  <div className="storage-clean__space">
                    {space > 0 ? t('约 {{v1}}', { v1: formatBytes(space) }) : ''}
                  </div>
                </label>
              );
            })}

            <div className="storage-clean__actions">
              <div className="storage-clean__hint">
                {!canManage
                  ? t('仅管理员可执行一键清理')
                  : selected.size > 0
                    ? t('已选 {{v1}} 项', { v1: selected.size })
                    : t('勾选需要清理的类别后点击一键清理')}
              </div>
              <Button
                variant="danger"
                disabled={selected.size === 0 || !canManage}
                onClick={() => setPruneOpen(true)}
              >
                {t('一键清理')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* 一键清理二次确认 */}
      <ConfirmDialog
        open={pruneOpen}
        title={t('清理所选资源')}
        message="确定要清理所选类别吗？此操作会移除对应的镜像、容器、卷、网络或构建缓存，且不可恢复。"
        confirmText={t('清理')}
        danger
        loading={pruning}
        onConfirm={handlePrune}
        onCancel={() => setPruneOpen(false)}
      />

      {/* 镜像清理二次确认（按粒度动态标题与提示） */}
      <ConfirmDialog
        open={!!imgPruneMode}
        title={imgPruneMode === 'all' ? t('清理所有未使用镜像') : t('清理无标签镜像')}
        message={
          imgPruneMode === 'all'
            ? t('确定要清理所有未被容器使用的镜像吗？将删除全部未使用镜像（含非悬空镜像），此操作不可恢复。')
            : t('确定要清理所有悬空镜像（无标签且未被引用）吗？此操作不可恢复。')
        }
        confirmText={t('清理')}
        danger
        loading={imgPruning}
        onConfirm={handleImagePrune}
        onCancel={() => setImgPruneMode(null)}
      />
    </div>
  );
}
