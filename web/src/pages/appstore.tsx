/**
 * 应用商店页
 *
 * 展示内置应用目录，支持搜索、按安装状态过滤、查看应用详情、
 * 安装与卸载应用（安装即通过后端创建并启动对应容器）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import { Field, Input, Select } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post } from '../api/client';
import { AppStoreItem } from '../types';
// 复用的状态徽标样式（已安装应用需展示运行/停止状态）
import '../components/StatusBadge.less';
import './appstore.less';

/** 视图过滤类型：全部 或 仅已安装 */
type ViewFilter = 'all' | 'installed';

/** 应用商店页标题说明 */
const APP_LABEL = '应用商店';

/**
 * 应用商店页面组件
 */
export default function AppStorePage() {
  const { showToast } = useToast();
  const [apps, setApps] = useState<AppStoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  // 当前视图过滤（全部 / 已安装）
  const [view, setView] = useState<ViewFilter>('all');
  // 当前分类筛选（'all' 表示不过滤）
  const [category, setCategory] = useState<string>('all');
  // 搜索关键字（按名称/描述过滤）
  const [keyword, setKeyword] = useState('');
  // 正在执行启停/重启操作的应用 id（用于按钮 loading 控制）
  const [actionId, setActionId] = useState<string | null>(null);
  // 正在执行安装的应用 id，用于按钮 loading 控制
  const [installingId, setInstallingId] = useState<string | null>(null);
  // 待安装配置的应用（用于打开安装前环境变量编辑弹窗）
  const [installTarget, setInstallTarget] = useState<AppStoreItem | null>(null);
  // 安装时编辑中的环境变量覆盖值
  const [installEnv, setInstallEnv] = useState<Record<string, string>>({});
  // 安装时编辑中的端口映射列表
  const [installPorts, setInstallPorts] = useState<
    Array<{ container: string; host: string; protocol: string }>
  >([]);
  // 安装时编辑中的挂载卷列表
  const [installVolumes, setInstallVolumes] = useState<
    Array<{ source: string; target: string; readonly: boolean }>
  >([]);
  // 安装时使用的镜像源（''=官方 Docker Hub，由后端自动用默认源）
  const [installSource, setInstallSource] = useState('');
  // 可选的镜像源列表（来自 /api/hub/sources）
  const [sources, setSources] = useState<
    Array<{ id: string; host: string; name?: string; enabled?: boolean }>
  >([]);
  // 待卸载应用（用于二次确认）
  const [uninstallTarget, setUninstallTarget] = useState<AppStoreItem | null>(null);
  // 卸载是否进行中
  const [uninstalling, setUninstalling] = useState(false);
  // 查看详情应用（用于详情弹窗）
  const [detailTarget, setDetailTarget] = useState<AppStoreItem | null>(null);
  // 参数修改目标应用（Compose 套件，用于参数修改弹窗）
  const [paramsTarget, setParamsTarget] = useState<AppStoreItem | null>(null);
  // 参数修改的环境变量编辑值
  const [paramsEnv, setParamsEnv] = useState<Record<string, string>>({});
  // 参数修改的端口映射编辑值
  const [paramsPorts, setParamsPorts] = useState<
    Array<{ container: string; host: string; protocol: string }>
  >([]);
  // 参数修改是否进行中
  const [updatingParams, setUpdatingParams] = useState(false);

  /**
   * 拉取应用商店列表
   */
  const fetchAppStore = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<{ apps: AppStoreItem[] }>('/api/appstore');
      setApps(data?.apps || []);
    } catch (e: any) {
      showToast(e?.message || '拉取应用商店失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchAppStore();
  }, [fetchAppStore, refreshKey]);

  // 加载可选的镜像源列表（用于安装时选择加速源）
  const loadSources = useCallback(async () => {
    try {
      const data = await get<{
        sources: Array<{ id: string; host: string; name?: string; enabled?: boolean }>;
      }>('/api/hub/sources');
      setSources(data?.sources || []);
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  /** 根据视图、分类与关键字过滤后的应用列表 */
  const filteredApps = useMemo(() => {
    let list = apps;
    if (view === 'installed') {
      list = list.filter((app) => app.installed);
    }
    if (category !== 'all') {
      list = list.filter((app) => app.category === category);
    }
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter(
        (app) =>
          app.name.toLowerCase().includes(kw) ||
          app.description.toLowerCase().includes(kw)
      );
    }
    return list;
  }, [apps, view, category, keyword]);

  /** 从应用数据中去重提取的分类列表（用于分类下拉） */
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const app of apps) {
      if (app.category) set.add(app.category);
    }
    return Array.from(set);
  }, [apps]);

  /** 已安装应用数量（用于标签展示） */
  const installedCount = useMemo(() => apps.filter((a) => a.installed).length, [apps]);

  /** 当前是否正在安装目标应用（用于编辑弹窗按钮 loading） */
  const installing = !!installTarget && installingId === installTarget.id;

  /**
   * 判断应用是否为 Compose 多容器套件
   * @param app 应用项
   * @returns 是否为 compose 套件（旧数据无 mode 时视为单容器 false）
   */
  const isCompose = (app: AppStoreItem): boolean => app.mode === 'compose';

  /**
   * 打开安装配置弹窗：初始化环境变量、端口映射与挂载卷的编辑值
   * 对 Compose 套件，卷由模板固定，仅初始化 env/ports，不初始化 volumes。
   * @param app 目标应用
   */
  const openInstall = useCallback((app: AppStoreItem) => {
    // 初始化各环境变量的编辑值
    const init: Record<string, string> = {};
    for (const e of app.env || []) {
      init[e.key] = e.value ?? '';
    }
    // 初始化端口映射（container/host 数字转字符串，protocol 默认 tcp）
    const ports = (app.ports || []).map((p) => ({
      container: String(p.container),
      host: p.host !== undefined ? String(p.host) : '',
      protocol: 'tcp',
    }));
    // 初始化挂载卷（target=container，source=host 或空，默认非只读）；
    // Compose 套件卷由模板固定，置空数组，不提供卷编辑
    const volumes = isCompose(app)
      ? []
      : (app.volumes || []).map((v) => ({
          source: v.host ?? '',
          target: v.container,
          readonly: false,
        }));
    setInstallEnv(init);
    setInstallPorts(ports);
    setInstallVolumes(volumes);
    setInstallTarget(app);
  }, []);

  /**
   * 安装应用（携带用户覆盖的环境变量、端口映射与挂载卷，以及可选的镜像源）
   * Compose 套件不传 volumes（卷由模板固定）；单容器保持原样。
   * @param app 目标应用
   */
  const handleInstall = useCallback(
    async (app: AppStoreItem) => {
      setInstallingId(app.id);
      // compose 套件卷由模板配置，不参与安装提交
      const compose = isCompose(app);
      // 过滤空 container 的端口行，protocol 默认 tcp
      const ports = installPorts
        .filter((p) => p.container.trim() !== '')
        .map((p) => ({
          host: p.host.trim(),
          container: p.container.trim(),
          protocol: p.protocol || 'tcp',
        }))
        // host 为空时转为 undefined，不提交
        .map((p) => ({ ...p, host: p.host || undefined }));
      // 过滤空 source/target 的挂载卷行（仅单容器使用）
      const volumes = compose
        ? []
        : installVolumes
            .filter((v) => v.source.trim() !== '' && v.target.trim() !== '')
            .map((v) => ({
              source: v.source.trim(),
              target: v.target.trim(),
              readonly: v.readonly,
            }));
      try {
        await post(`/api/appstore/${app.id}/install`, {
          env: installEnv,
          ports,
          volumes,
          source: installSource || undefined,
        });
        showToast(`${app.name} 安装成功`);
        setInstallTarget(null);
        setInstallSource('');
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        // 409 应用已安装，也提示并刷新保持一致
        showToast(e?.message || `${app.name} 安装失败`, 'error');
        setRefreshKey((k) => k + 1);
      } finally {
        setInstallingId(null);
      }
    },
    [showToast, installEnv, installPorts, installVolumes, installSource]
  );

  /**
   * 卸载应用（经确认框调用）
   */
  const handleUninstall = useCallback(async () => {
    if (!uninstallTarget) return;
    const target = uninstallTarget;
    setUninstalling(true);
    try {
      await post(`/api/appstore/${target.id}/uninstall`);
      showToast(`${target.name} 卸载成功`);
      setUninstallTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || `${target.name} 卸载失败`, 'error');
    } finally {
      setUninstalling(false);
    }
  }, [uninstallTarget, showToast]);

  /**
   * 打开参数修改弹窗：初始化 Compose 套件的环境变量与端口映射编辑值
   * （卷由模板固定，不参与参数修改）。
   * @param app 目标应用（须为 Compose 套件，已安装）
   */
  const openParams = useCallback((app: AppStoreItem) => {
    const init: Record<string, string> = {};
    for (const e of app.env || []) {
      init[e.key] = e.value ?? '';
    }
    const ports = (app.ports || []).map((p) => ({
      container: String(p.container),
      host: p.host !== undefined ? String(p.host) : '',
      protocol: 'tcp',
    }));
    setParamsEnv(init);
    setParamsPorts(ports);
    setParamsTarget(app);
  }, []);

  /**
   * 保存参数修改：调用 update-params 接口重新渲染并重建 Compose 套件
   */
  const handleUpdateParams = useCallback(async () => {
    if (!paramsTarget) return;
    setUpdatingParams(true);
    // 过滤空 container 的端口行；host 为空时转 undefined 不提交
    const ports = paramsPorts
      .filter((p) => p.container.trim() !== '')
      .map((p) => ({
        host: p.host.trim(),
        container: p.container.trim(),
        protocol: p.protocol || 'tcp',
      }))
      .map((p) => ({ ...p, host: p.host || undefined }));
    try {
      await post(`/api/appstore/${paramsTarget.id}/update-params`, {
        env: paramsEnv,
        ports,
      });
      showToast(`${paramsTarget.name} 参数已更新`);
      setParamsTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || `${paramsTarget.name} 参数更新失败`, 'error');
    } finally {
      setUpdatingParams(false);
    }
  }, [paramsTarget, paramsEnv, paramsPorts, showToast]);

  /**
   * 升级已安装的 Compose 套件（调用上游接口拉取新镜像并重建）
   * @param app 目标应用
   */
  const handleUpgrade = useCallback(
    async (app: AppStoreItem) => {
      setActionId(app.id);
      try {
        const res = await post<{ version?: string; pullOut?: string; upOut?: string }>(
          `/api/appstore/${app.id}/upgrade`
        );
        // 优先展示返回的版本号，否则展示拉取/重建的输出摘要
        const detail = res?.version || res?.pullOut || res?.upOut;
        showToast(`${app.name} 升级成功${detail ? `：${detail}` : ''}`);
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || `${app.name} 升级失败`, 'error');
      } finally {
        setActionId(null);
      }
    },
    [showToast]
  );

  /**
   * 对已安装应用执行启动/停止/重启操作
   * @param app 目标应用
   * @param action 操作类型：start | stop | restart
   */
  const handleControl = useCallback(
    async (app: AppStoreItem, action: 'start' | 'stop' | 'restart') => {
      setActionId(app.id);
      const actionText = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
      try {
        await post(`/api/appstore/${app.id}/${action}`);
        showToast(`${app.name} 已${actionText}`);
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || `${app.name} ${actionText}失败`, 'error');
        setRefreshKey((k) => k + 1);
      } finally {
        setActionId(null);
      }
    },
    [showToast]
  );

  /** 渲染应用端口信息 */
  const renderPortInfo = (app: AppStoreItem) => {
    if (app.port) return app.port;
    if (app.ports && app.ports.length > 0) {
      // 未安装时展示声明端口
      return app.ports.map((p) => `${p.host ?? p.container}:${p.container}`).join(', ');
    }
    return null;
  };

  /**
   * 渲染单个应用卡片
   * @param app 应用项
   */
  const renderAppCard = (app: AppStoreItem) => {
    const installing = installingId === app.id;
    const portInfo = renderPortInfo(app);
    // 是否为 Compose 多容器套件
    const compose = isCompose(app);
    return (
      <div className="appstore-card" key={app.id}>
        <div className="appstore-card__head">
          <div className="appstore-card__icon" aria-hidden="true">
            {app.icon}
          </div>
          <div className="appstore-card__meta">
            <div className="appstore-card__name">
              {app.name}
              {app.installed && app.version && (
                <span className="appstore-card__version">{app.version}</span>
              )}
            </div>
            <div className="appstore-card__category">{app.category}</div>
          </div>
          {app.installed && (
            <span className={`appstore-card__status status-badge ${app.running ? 'status--running' : 'status--stopped'}`}>
              <span className="status-badge__dot" />
              {app.running ? '运行中' : '已停止'}
            </span>
          )}
        </div>

        <div className="appstore-card__desc" title={app.description}>
          {app.description}
        </div>

        {app.tags && app.tags.length > 0 && (
          <div className="appstore-card__tags">
            {app.tags.map((tag) => (
              <span className="appstore-card__tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        )}

        {compose && app.services && app.services.length > 0 && (
          <div className="appstore-card__tags">
            <span className="appstore-card__tag appstore-card__tag--suite">套件</span>
            <span className="appstore-card__tag">{app.services.length} 个服务</span>
          </div>
        )}

        {portInfo && (
          <div className="appstore-card__ports">
            <span className="appstore-card__ports-label">端口</span>
            <span className="appstore-card__ports-value">{portInfo}</span>
          </div>
        )}

        <div className="appstore-card__actions">
          <Button variant="ghost" size="sm" onClick={() => setDetailTarget(app)}>
            详情
          </Button>
          {app.installed ? (
            compose ? (
              // Compose 已安装：提供 启停/重启/参数/升级/卸载
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!!actionId}
                  loading={actionId === app.id}
                  onClick={() => handleControl(app, app.running ? 'stop' : 'start')}
                >
                  {app.running ? '停止' : '启动'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!actionId}
                  onClick={() => handleControl(app, 'restart')}
                >
                  重启
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!!actionId || updatingParams}
                  loading={updatingParams}
                  onClick={() => openParams(app)}
                >
                  参数
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!!actionId}
                  loading={actionId === app.id}
                  onClick={() => handleUpgrade(app)}
                >
                  升级
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setUninstallTarget(app)}
                  disabled={installing}
                >
                  卸载
                </Button>
              </>
            ) : (
              // 单容器已安装：保持原有启停/重启/卸载逻辑
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!!actionId}
                  loading={actionId === app.id}
                  onClick={() =>
                    handleControl(app, app.running ? 'stop' : 'start')
                  }
                >
                  {app.running ? '停止' : '启动'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!actionId}
                  onClick={() => handleControl(app, 'restart')}
                >
                  重启
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setUninstallTarget(app)}
                  disabled={installing}
                >
                  卸载
                </Button>
              </>
            )
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={installing}
              disabled={!!installingId && !installing}
              onClick={() => openInstall(app)}
            >
              {installing ? '安装中' : '安装'}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <Card
        title={APP_LABEL}
        extra={
          <div className="appstore-toolbar">
            <input
              className="input appstore-search"
              placeholder="搜索应用名称或描述"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <select
              className="input appstore-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="all">全部分类</option>
              {categories.map((c) => (
                <option value={c} key={c}>
                  {c}
                </option>
              ))}
            </select>
            <div className="appstore-tabs">
              <button
                className={`appstore-tabs__item ${view === 'all' ? 'is-active' : ''}`}
                onClick={() => setView('all')}
              >
                全部应用
              </button>
              <button
                className={`appstore-tabs__item ${view === 'installed' ? 'is-active' : ''}`}
                onClick={() => setView('installed')}
              >
                已安装 ({installedCount})
              </button>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
              刷新
            </Button>
          </div>
        }
      >
        <div className="appstore-tip">
          从内置目录一键安装常用应用，安装后将以容器方式运行于 Docker 引擎中。
        </div>

        {loading ? (
          <SkeletonRows rows={6} />
        ) : filteredApps.length === 0 ? (
          <Empty
            title={view === 'installed' ? '暂无已安装应用' : '未找到匹配应用'}
            description={view === 'installed' ? '前往"全部应用"安装所需应用' : '尝试更换搜索关键字'}
          />
        ) : (
          <div className="appstore-grid">{filteredApps.map(renderAppCard)}</div>
        )}
      </Card>

      {/* 应用详情弹窗 */}
      <Modal
        open={!!detailTarget}
        title={detailTarget ? `${detailTarget.icon} ${detailTarget.name}` : '应用详情'}
        onClose={() => setDetailTarget(null)}
        width={520}
      >
        {detailTarget && <AppStoreDetail app={detailTarget} />}
      </Modal>

      {/* 安装前环境变量配置弹窗 */}
      <Modal
        open={!!installTarget}
        title={installTarget ? `安装 ${installTarget.name}` : '应用配置'}
        onClose={() => !installing && setInstallTarget(null)}
        width={540}
        footer={
          <div className="appstore-install__footer">
            <Button variant="ghost" size="md" onClick={() => setInstallTarget(null)} disabled={installing}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={installing}
              disabled={!installTarget}
              onClick={() => installTarget && handleInstall(installTarget)}
            >
              确认安装
            </Button>
          </div>
        }
      >
        {installTarget && (
          <InstallConfigPanel
            app={installTarget}
            installEnv={installEnv}
            setInstallEnv={setInstallEnv}
            installPorts={installPorts}
            setInstallPorts={setInstallPorts}
            installVolumes={installVolumes}
            setInstallVolumes={setInstallVolumes}
          />
        )}
        {installTarget && (
          <div className="appstore-install__source">
            <Field
              label="镜像源"
              hint="留空则依次尝试所有启用的镜像源，单个不可用会自动切换（多源容灾）"
            >
              <Select value={installSource} onChange={(e) => setInstallSource(e.target.value)}>
                <option value="">使用默认镜像源</option>
                {sources
                  .filter((s) => s.enabled !== false)
                  .map((s) => (
                    <option key={s.id} value={s.host}>
                      {s.name ? `${s.name} (${s.host})` : s.host}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      {/* 卸载确认框 */}
      <ConfirmDialog
        open={!!uninstallTarget}
        title="卸载应用"
        message={
          uninstallTarget && isCompose(uninstallTarget)
            ? `确定要卸载套件 "${uninstallTarget.name}" 吗？将停止并删除其全部容器，且会删除该项目关联的数据卷（compose down -v）与项目目录。`
            : `确定要卸载应用 "${uninstallTarget?.name || ''}" 吗？将停止并删除其对应的容器。`
        }
        confirmText="卸载"
        danger
        loading={uninstalling}
        onConfirm={handleUninstall}
        onCancel={() => setUninstallTarget(null)}
      />
    </div>
  );
}

/**
 * 应用详情区块：展示环境变量、挂载卷与端口明细
 * @param param0 app 应用项
 */
function AppStoreDetail({ app }: { app: AppStoreItem }) {
  // 是否为 Compose 多容器套件（旧数据无 mode 视为单容器）
  const compose = app.mode === 'compose';
  const hasDetail = !!(
    app.env?.length ||
    app.volumes?.length ||
    app.ports?.length ||
    app.services?.length
  );
  return (
    <div className="appstore-detail">
      <div className="appstore-detail__desc">{app.description}</div>
      {compose && (
        <div className="appstore-detail__suite">多容器套件</div>
      )}
      <div className="appstore-detail__row">
        <span className="appstore-detail__label">镜像</span>
        <span className="appstore-detail__value appstore-detail__value--mono">{app.image}</span>
      </div>
      {app.version && (
        <div className="appstore-detail__row">
          <span className="appstore-detail__label">版本</span>
          <span className="appstore-detail__value">{app.version}</span>
        </div>
      )}
      {app.running !== undefined ? (
        // 已安装：展示实时运行/停止状态
        <div className="appstore-detail__row">
          <span className="appstore-detail__label">状态</span>
          <span className="appstore-detail__value">{app.running ? '运行中' : '已停止'}</span>
        </div>
      ) : (
        compose && (
          <div className="appstore-detail__row">
            <span className="appstore-detail__label">状态</span>
            <span className="appstore-detail__value">套件</span>
          </div>
        )
      )}
      {app.port && (
        <div className="appstore-detail__row">
          <span className="appstore-detail__label">端口</span>
          <span className="appstore-detail__value appstore-detail__value--mono">{app.port}</span>
        </div>
      )}

      {compose && app.services && app.services.length > 0 && (
        <>
          <div className="appstore-detail__section">服务列表</div>
          <div className="appstore-detail__list">
            {app.services.map((s, i) => (
              <div className="appstore-detail__line" key={i}>
                <span className="appstore-detail__list-key">{i + 1}.</span>
                <span className="appstore-detail__list-val">{s}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {app.ports && app.ports.length > 0 && (
        <>
          <div className="appstore-detail__section">端口映射</div>
          <div className="appstore-detail__list">
            {app.ports.map((p, i) => (
              <div className="appstore-detail__line" key={i}>
                <span className="appstore-detail__list-key">容器 {p.container}</span>
                <span className="appstore-detail__list-val">
                  宿主机 {(p.host ?? p.container)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {app.env && app.env.length > 0 && (
        <>
          <div className="appstore-detail__section">环境变量</div>
          <div className="appstore-detail__list">
            {app.env.map((e, i) => (
              <div className="appstore-detail__line" key={i}>
                <span className="appstore-detail__list-key">{e.key}</span>
                <span className="appstore-detail__list-val">
                  {e.value ?? ''}
                  {e.desc ? `（${e.desc}）` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {app.volumes && app.volumes.length > 0 && (
        <>
          <div className="appstore-detail__section">挂载卷</div>
          <div className="appstore-detail__list">
            {app.volumes.map((v, i) => (
              <div className="appstore-detail__line" key={i}>
                <span className="appstore-detail__list-key">{v.container}</span>
                <span className="appstore-detail__list-val">{v.host ?? '自动命名卷'}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!hasDetail && app.running === undefined && (
        <div className="appstore-detail__empty">该应用无额外配置。</div>
      )}
    </div>
  );
}

/**
 * 安装前配置面板：允许用户编辑/覆盖各环境变量的值，
 * 并可增删改端口映射与挂载卷配置。
 * @param param0 组件属性
 */
function InstallConfigPanel({
  app,
  installEnv,
  setInstallEnv,
  installPorts,
  setInstallPorts,
  installVolumes,
  setInstallVolumes,
}: {
  app: AppStoreItem;
  installEnv: Record<string, string>;
  setInstallEnv: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  installPorts: Array<{ container: string; host: string; protocol: string }>;
  setInstallPorts: React.Dispatch<
    React.SetStateAction<Array<{ container: string; host: string; protocol: string }>>
  >;
  installVolumes: Array<{ source: string; target: string; readonly: boolean }>;
  setInstallVolumes: React.Dispatch<
    React.SetStateAction<Array<{ source: string; target: string; readonly: boolean }>>
  >;
}) {
  const envList = app.env || [];
  // 是否为 Compose 多容器套件：套件卷由模板固定，不提供卷编辑
  const compose = app.mode === 'compose';

  /**
   * 更新单个环境变量的值
   * @param key 变量键
   * @param value 变量值
   */
  const updateEnv = (key: string, value: string) => {
    setInstallEnv((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * 更新单条端口映射行
   * @param index 行索引
   * @param field 字段名
   * @param value 字段新值
   */
  const updatePort = (
    index: number,
    field: 'container' | 'host' | 'protocol',
    value: string
  ) => {
    setInstallPorts((prev) =>
      prev.map((p, i) => (i === index ? { ...p, [field]: value } : p))
    );
  };

  /**
   * 删除单条端口映射行
   * @param index 行索引
   */
  const removePort = (index: number) => {
    setInstallPorts((prev) => prev.filter((_, i) => i !== index));
  };

  /**
   * 增加一条空端口映射行
   */
  const addPort = () => {
    setInstallPorts((prev) => [
      ...prev,
      { container: '', host: '', protocol: 'tcp' },
    ]);
  };

  /**
   * 更新单条挂载卷行
   * @param index 行索引
   * @param field 字段名
   * @param value 字段新值
   */
  const updateVolume = (
    index: number,
    field: 'source' | 'target' | 'readonly',
    value: string | boolean
  ) => {
    setInstallVolumes((prev) =>
      prev.map((v, i) => (i === index ? { ...v, [field]: value } : v))
    );
  };

  /**
   * 删除单条挂载卷行
   * @param index 行索引
   */
  const removeVolume = (index: number) => {
    setInstallVolumes((prev) => prev.filter((_, i) => i !== index));
  };

  /**
   * 增加一条空挂载卷行
   */
  const addVolume = () => {
    setInstallVolumes((prev) => [
      ...prev,
      { source: '', target: '', readonly: false },
    ]);
  };

  return (
    <div className="appstore-install">
      <div className="appstore-install__tip">
        {compose
          ? '多容器套件，卷已由模板配置，安装时将使用以下环境变量与端口映射。'
          : '安装后将使用以下环境变量、端口映射与挂载卷创建容器，可在此调整默认配置。'}
      </div>
      {envList.length === 0 ? (
        <div className="appstore-install__none">该应用无需配置环境变量，将使用默认配置安装。</div>
      ) : (
        <div className="appstore-install__fields">
          {envList.map((e) => (
            <Field
              key={e.key}
              label={e.key}
              required={!!e.value && !e.desc}
              hint={e.desc}
            >
              <Input
                value={installEnv[e.key] ?? ''}
                placeholder={e.value ?? ''}
                onChange={(ev) => updateEnv(e.key, ev.target.value)}
              />
            </Field>
          ))}
        </div>
      )}

      <div className="appstore-install__sec">端口映射</div>
      {installPorts.length === 0 ? (
        <div className="appstore-install__none">该应用无需映射端口，或可手动添加。</div>
      ) : (
        <div className="appstore-install__rows">
          {installPorts.map((p, index) => (
            <div className="appstore-install__row" key={index}>
              <Field label="容器端口" className="appstore-install__cell">
                <Input
                  value={p.container}
                  placeholder="8080"
                  onChange={(ev) => updatePort(index, 'container', ev.target.value)}
                />
              </Field>
              <Field label="宿主机端口" className="appstore-install__cell">
                <Input
                  value={p.host}
                  placeholder="可空"
                  onChange={(ev) => updatePort(index, 'host', ev.target.value)}
                />
              </Field>
              <Field label="协议" className="appstore-install__cell appstore-install__cell--proto">
                <Select
                  value={p.protocol}
                  onChange={(ev) => updatePort(index, 'protocol', ev.target.value)}
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </Select>
              </Field>
              <Button variant="ghost" size="sm" onClick={() => removePort(index)}>
                删除
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="appstore-install__add">
        <Button variant="secondary" size="sm" onClick={addPort}>
          + 添加端口
        </Button>
      </div>

      {!compose && (
        <>
          <div className="appstore-install__sec">挂载卷</div>
          {installVolumes.length === 0 ? (
            <div className="appstore-install__none">该应用无需挂载卷，或可手动添加。</div>
          ) : (
            <div className="appstore-install__rows">
              {installVolumes.map((v, index) => (
                <div className="appstore-install__row" key={index}>
                  <Field label="来源" className="appstore-install__cell">
                    <Input
                      value={v.source}
                      placeholder="宿主机路径或卷名"
                      onChange={(ev) => updateVolume(index, 'source', ev.target.value)}
                    />
                  </Field>
                  <Field label="容器路径" className="appstore-install__cell">
                    <Input
                      value={v.target}
                      placeholder="/data"
                      onChange={(ev) => updateVolume(index, 'target', ev.target.value)}
                    />
                  </Field>
                  <label className="appstore-install__check">
                    <input
                      type="checkbox"
                      checked={v.readonly}
                      onChange={(ev) => updateVolume(index, 'readonly', ev.target.checked)}
                    />
                    只读
                  </label>
                  <Button variant="ghost" size="sm" onClick={() => removeVolume(index)}>
                    删除
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="appstore-install__add">
            <Button variant="secondary" size="sm" onClick={addVolume}>
              + 添加挂载
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
