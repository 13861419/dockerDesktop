/**
 * 系统健康体检页
 *
 * 拉取 /api/health-check 数据，顶部展示总体健康评分与等级徽标，
 * 中部展示容器 / 镜像 / 卷 / 网络 / 可回收空间汇总，
 * 下方逐条罗列体检结果（含级别图标、标题、描述与详情）。
 * 提供"重新体检"刷新与按类型的"去清理"跳转链接。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api/client';
import { HealthCheck, HealthItem, HealthLevel } from '../types';
import Card from '../components/Card';
import Button from '../components/Button';
import { PageLoading } from '../components/Loading';
import { useToast } from '../components/Toast';
import { translateNow as t } from '../i18n';
import './health.less';

/** 各级别对应的展示文案 */
const LEVEL_LABEL: Record<HealthLevel, string> = {
  healthy: t('健康'),
  warning: t('警告'),
  danger: t('危险'),
};

/** 各级别对应的 CSS 修饰类（配色由 less 定义） */
const LEVEL_CLASS: Record<HealthLevel, string> = {
  healthy: 'hl--healthy',
  warning: 'hl--warning',
  danger: 'hl--danger',
};

/** 体检条目可跳转的清理目标路径（key -> 路由），供"去清理"按钮使用 */
const CLEAN_TARGETS: Record<string, string> = {
  danglingImages: '/images',
  unusedImages: '/images',
  orphanVolumes: '/volumes',
  unusedNetworks: '/networks',
  disk: '/storage',
  cpu: '/storage',
  memory: '/storage',
};

/** 各级别对应的提示图标（SVG） */
function levelIcon(level: HealthLevel) {
  const props = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (level === 'danger') {
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5M12 16.5h.01" />
      </svg>
    );
  }
  if (level === 'warning') {
    return (
      <svg {...props}>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * 将字节数格式化为人类可读大小
 * @param bytes 字节数
 * @returns 格式化后的字符串（如 "1.2 GB"）
 */
function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 健康体检页组件
 */
export default function HealthPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<HealthCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  /**
   * 拉取健康体检数据
   * @param silent 是否静默刷新（不显示整页 loading，仅按钮转圈）
   */
  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const res = await get<HealthCheck>('/api/health-check');
        setData(res);
      } catch (e: any) {
        const msg = e?.message || t('体检加载失败');
        setError(msg);
        showToast(msg, 'error');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [showToast],
  );

  // 挂载时执行一次体检
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <PageLoading />;

  if (error || !data) {
    return (
      <div className="health-page">
        <h1 className="health-page__title">{t('健康体检')}</h1>
        <Card>
          <div className="health-page__error">
            <p>{error || t('暂无体检数据')}</p>
            <Button onClick={() => load()}>{t('重试')}</Button>
          </div>
        </Card>
      </div>
    );
  }

  // 汇总数据条
  const stats = [
    { label: '容器', value: data.summary.containers },
    { label: '镜像', value: data.summary.images },
    { label: '数据卷', value: data.summary.volumes },
    { label: '网络', value: data.summary.networks },
    { label: '可回收', value: formatBytes(data.summary.reclaimable) },
  ];

  /**
   * 跳转到清理目标页面；无对应目标时给出提示
   * @param item 体检条目
   */
  function handleClean(item: HealthItem) {
    const target = CLEAN_TARGETS[item.key];
    if (target) {
      navigate(target);
    } else {
      showToast(t('该项目无需跳转清理'), 'info');
    }
  }

  return (
    <div className="health-page">
      <div className="health-page__head">
        <h1 className="health-page__title">{t('健康体检')}</h1>
        <Button variant="secondary" onClick={() => load(true)} loading={refreshing}>
          {t('重新体检')}
        </Button>
      </div>

      {/* 顶部：健康等级徽标 + 总分 */}
      <div className="health-hero">
        <div className={`health-hero__badge ${LEVEL_CLASS[data.level]}`}>
          <span className="health-hero__icon">{levelIcon(data.level)}</span>
          <span className="health-hero__level">{LEVEL_LABEL[data.level]}</span>
        </div>
        <div className="health-hero__score">
          <div className="health-hero__score-num">{data.score}</div>
          <div className="health-hero__score-label">{t('健康评分 / 100')}</div>
        </div>
      </div>

      {/* 汇总数据条 */}
      <div className="health__stats">
        {stats.map((s) => (
          <div key={s.label} className="health__stat">
            <div className="health__stat-value">{s.value}</div>
            <div className="health__stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {/* 体检条目列表 */}
      <Card title={t('体检项目')}>
        <div className="health__items">
          {data.items.map((item) => (
            <div key={item.key} className={`health__item ${LEVEL_CLASS[item.level]}`}>
              <div className="health__item-icon">{levelIcon(item.level)}</div>
              <div className="health__item-body">
                <div className="health__item-title">{item.title}</div>
                <div className="health__item-message">{item.message}</div>
                {item.detail && <div className="health__item-detail">{item.detail}</div>}
              </div>
              <div className="health__item-side">
                <span className={`health__item-tag ${LEVEL_CLASS[item.level]}`}>
                  {LEVEL_LABEL[item.level]}
                </span>
                {item.level !== 'healthy' && (
                  <button className="health__item-clean" onClick={() => handleClean(item)}>
                    {t('去清理')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
