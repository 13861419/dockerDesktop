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
import { get, post, put, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { AppStoreItem } from '../types';
// 复用的状态徽标样式（已安装应用需展示运行/停止状态）
import '../components/StatusBadge.less';
import { translateNow as t } from '../i18n';
import './appstore.less';

/** 视图过滤类型：全部 或 仅已安装 */
type ViewFilter = 'all' | 'installed';

/** 应用商店页标题说明 */
const APP_LABEL = t('应用商店');

/**
 * 应用商店页面组件
 */
export default function AppStorePage() {
  const { showToast } = useToast();
  const canManage = isAdmin();
  const [apps, setApps] = useState<AppStoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
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
  // 自定义应用新增/编辑弹窗是否打开（target 为 null 表示新增，有值表示编辑）
  const [customModalOpen, setCustomModalOpen] = useState(false);
  // 待编辑的自定义应用（null 表示新增模式）
  const [customTarget, setCustomTarget] = useState<AppStoreItem | null>(null);
  // 自定义应用表单各字段
  const [customName, setCustomName] = useState('');
  const [customDescription, setCustomDescription] = useState('');
  const [customCategory, setCustomCategory] = useState('');
  const [customImage, setCustomImage] = useState('');
  const [customIcon, setCustomIcon] = useState('');
  // 自定义应用表单的标签（以逗号/空格分隔的字符串）
  const [customTags, setCustomTags] = useState('');
  // 自定义应用表单的端口映射列表
  const [customPorts, setCustomPorts] = useState<
    Array<{ container: string; host: string; protocol: string }>
  >([]);
  // 自定义应用表单的环境变量列表
  const [customEnv, setCustomEnv] = useState<
    Array<{ key: string; value: string; desc: string }>
  >([]);
  // 自定义应用表单的挂载卷列表
  const [customVolumes, setCustomVolumes] = useState<
    Array<{ source: string; target: string; readonly: boolean }>
  >([]);
  // 自定义应用保存是否进行中
  const [customSaving, setCustomSaving] = useState(false);
  // 待删除的自定义应用（用于二次确认）
  const [deleteTarget, setDeleteTarget] = useState<AppStoreItem | null>(null);
  // 删除是否进行中
  const [deleting, setDeleting] = useState(false);

  /**
   * 拉取应用商店列表
   */
  const fetchAppStore = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<{ apps: AppStoreItem[] }>('/api/appstore');
      setApps(data?.apps || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || t('拉取应用商店失败'));
      showToast(e?.message || t('拉取应用商店失败'), 'error');
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
      if (!canManage) {
        showToast(t('仅管理员可安装应用'), 'error');
        setInstallTarget(null);
        return;
      }
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
        showToast(t('{{v1}} 安装成功', { v1: app.name }));
        setInstallTarget(null);
        setInstallSource('');
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        // 409 应用已安装，也提示并刷新保持一致
        showToast(e?.message || t('{{v1}} 安装失败', { v1: app.name }), 'error');
        setRefreshKey((k) => k + 1);
      } finally {
        setInstallingId(null);
      }
    },
    [canManage, showToast, installEnv, installPorts, installVolumes, installSource]
  );

  /**
   * 卸载应用（经确认框调用）
   */
  const handleUninstall = useCallback(async () => {
    if (!uninstallTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可卸载应用'), 'error');
      setUninstallTarget(null);
      return;
    }
    const target = uninstallTarget;
    setUninstalling(true);
    try {
      await post(`/api/appstore/${target.id}/uninstall`);
      showToast(t('{{v1}} 卸载成功', { v1: target.name }));
      setUninstallTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('{{v1}} 卸载失败', { v1: target.name }), 'error');
    } finally {
      setUninstalling(false);
    }
  }, [canManage, uninstallTarget, showToast]);

  /**
   * 打开参数修改弹窗：初始化 Compose 套件的环境变量与端口映射编辑值
   * （卷由模板固定，不参与参数修改）。
   * @param app 目标应用（须为 Compose 套件，已安装）
   */
  const openParams = useCallback((app: AppStoreItem) => {
    if (!canManage) {
      showToast(t('仅管理员可修改应用参数'), 'error');
      return;
    }
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
  }, [canManage, showToast]);

  /**
   * 保存参数修改：调用 update-params 接口重新渲染并重建 Compose 套件
   */
  const handleUpdateParams = useCallback(async () => {
    if (!paramsTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可修改应用参数'), 'error');
      setParamsTarget(null);
      return;
    }
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
      showToast(t('{{v1}} 参数已更新', { v1: paramsTarget.name }));
      setParamsTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('{{v1}} 参数更新失败', { v1: paramsTarget.name }), 'error');
    } finally {
      setUpdatingParams(false);
    }
  }, [canManage, paramsTarget, paramsEnv, paramsPorts, showToast]);

  /**
   * 升级已安装的 Compose 套件（调用上游接口拉取新镜像并重建）
   * @param app 目标应用
   */
  const handleUpgrade = useCallback(
    async (app: AppStoreItem) => {
      if (!canManage) {
        showToast(t('仅管理员可升级应用'), 'error');
        return;
      }
      setActionId(app.id);
      try {
        const res = await post<{ version?: string; pullOut?: string; upOut?: string }>(
          `/api/appstore/${app.id}/upgrade`
        );
        // 优先展示返回的版本号，否则展示拉取/重建的输出摘要
        const detail = res?.version || res?.pullOut || res?.upOut;
        showToast(t('{{v1}} 升级成功{{v2}}', { v1: app.name, v2: detail ? '：' + detail : '' }));
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || t('{{v1}} 升级失败', { v1: app.name }), 'error');
      } finally {
        setActionId(null);
      }
    },
    [canManage, showToast]
  );

  /**
   * 对已安装应用执行启动/停止/重启操作
   * @param app 目标应用
   * @param action 操作类型：start | stop | restart
   */
  const handleControl = useCallback(
    async (app: AppStoreItem, action: 'start' | 'stop' | 'restart') => {
      if (!canManage) {
        showToast(t('仅管理员可操作应用'), 'error');
        return;
      }
      setActionId(app.id);
      const actionText = action === 'start' ? t('启动') : action === 'stop' ? t('停止') : t('重启');
      try {
        await post(`/api/appstore/${app.id}/${action}`);
        showToast(t('{{v1}} 已{{actionText}}', { v1: app.name, actionText }));
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || t('{{v1}} {{actionText}}失败', { v1: app.name, actionText }), 'error');
        setRefreshKey((k) => k + 1);
      } finally {
        setActionId(null);
      }
    },
    [showToast]
  );

  /**
   * 判断应用是否为用户自定义应用（id 以 custom- 前缀）
   * @param app 应用项
   * @returns 是否为自定义应用
   */
  const isCustomApp = (app: AppStoreItem): boolean =>
    !!app.isCustom || app.id.startsWith('custom-');

  /**
   * 打开自定义应用新增弹窗：清空所有表单字段并初始化为空值
   */
  const openCustomAdd = useCallback(() => {
    setCustomTarget(null);
    setCustomName('');
    setCustomDescription('');
    setCustomCategory('');
    setCustomImage('');
    setCustomIcon('📦');
    setCustomTags('');
    setCustomPorts([]);
    setCustomEnv([]);
    setCustomVolumes([]);
    setCustomModalOpen(true);
  }, []);

  /**
   * 打开自定义应用编辑弹窗：用当前应用的值预填表单字段
   * @param app 待编辑的自定义应用
   */
  const openCustomEdit = useCallback(
    (app: AppStoreItem) => {
      setCustomTarget(app);
      setCustomName(app.name);
      setCustomDescription(app.description || '');
      setCustomCategory(app.category || '');
      setCustomImage(app.image || '');
      setCustomIcon(app.icon || '📦');
      // 标签以逗号/空格分隔展示为一串
      setCustomTags((app.tags || []).join(' '));
      // 端口映射（container/host 数字转字符串，protocol 默认 tcp）
      const ports = (app.ports || []).map((p) => ({
        container: String(p.container),
        host: p.host !== undefined ? String(p.host) : '',
        protocol: 'tcp',
      }));
      setCustomPorts(ports);
      // 环境变量
      const envs = (app.env || []).map((e) => ({
        key: e.key,
        value: e.value ?? '',
        desc: e.desc ?? '',
      }));
      setCustomEnv(envs);
      // 挂载卷
      const vols = (app.volumes || []).map((v) => ({
        source: v.host ?? '',
        target: v.container,
        readonly: false,
      }));
      setCustomVolumes(vols);
      setCustomModalOpen(true);
    },
    []
  );

  /**
   * 保存自定义应用（新增走 POST，编辑走 PUT），成功后刷新列表
   */
  const handleCustomSave = useCallback(async () => {
    if (!canManage) {
      showToast(t('仅管理员可管理自定义应用'), 'error');
      return;
    }
    if (!customName.trim()) {
      showToast(t('请填写应用名称'), 'error');
      return;
    }
    if (!customImage.trim()) {
      showToast(t('请填写镜像名称'), 'error');
      return;
    }
    setCustomSaving(true);
    // 组装提交数据：端口过滤空 container；挂载过滤空 source/target；环境变量过滤空 key
    const ports = customPorts
      .filter((p) => p.container.trim() !== '')
      .map((p) => ({
        container: p.container.trim(),
        host: p.host.trim() || undefined,
        protocol: p.protocol || 'tcp',
      }));
    const env = customEnv
      .filter((e) => e.key.trim() !== '')
      .map((e) => ({
        key: e.key.trim(),
        value: e.value,
        desc: e.desc || undefined,
      }));
    const volumes = customVolumes
      .filter((v) => v.source.trim() !== '' && v.target.trim() !== '')
      .map((v) => ({
        source: v.source.trim(),
        target: v.target.trim(),
        readonly: v.readonly,
      }));
    // 标签：按逗号/空格/顿号拆分，过滤空项
    const tags = customTags
      .split(/[\s,，、]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const body = {
      name: customName.trim(),
      description: customDescription,
      category: customCategory || undefined,
      image: customImage.trim(),
      icon: customIcon || '📦',
      ports,
      env,
      volumes,
      tags,
    };
    try {
      if (customTarget) {
        // 编辑：PUT 更新现有自定义应用
        await put(`/api/appstore/custom/${customTarget.id}`, body);
        showToast(t('{{v1}} 更新成功', { v1: customTarget.name }));
      } else {
        // 新增：POST 创建自定义应用
        await post('/api/appstore/custom', body);
        showToast(t('自定义应用创建成功'));
      }
      setCustomModalOpen(false);
      setCustomTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('保存自定义应用失败'), 'error');
    } finally {
      setCustomSaving(false);
    }
  }, [canManage, showToast, customTarget, customName, customDescription, customCategory, customImage, customIcon, customTags, customPorts, customEnv, customVolumes]);

  /**
   * 删除自定义应用（经确认框调用）
   */
  const handleCustomDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可删除自定义应用'), 'error');
      setDeleteTarget(null);
      return;
    }
    const target = deleteTarget;
    setDeleting(true);
    try {
      await del(`/api/appstore/custom/${target.id}`);
      showToast(t('自定义应用 "{{v1}}" 已删除', { v1: target.name }));
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('删除自定义应用失败'), 'error');
    } finally {
      setDeleting(false);
    }
  }, [canManage, deleteTarget, showToast]);

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
              {app.running ? t('运行中') : t('已停止')}
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
            <span className="appstore-card__tag appstore-card__tag--suite">{t('套件')}</span>
            <span className="appstore-card__tag">{t('{{n}} 个服务', { n: app.services.length })}</span>
          </div>
        )}

        {portInfo && (
          <div className="appstore-card__ports">
            <span className="appstore-card__ports-label">{t('端口')}</span>
            <span className="appstore-card__ports-value">{portInfo}</span>
          </div>
        )}

        <div className="appstore-card__actions">
          <Button variant="ghost" size="sm" onClick={() => setDetailTarget(app)}>
            {t('详情')}
          </Button>
          {isCustomApp(app) && canManage && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={customSaving || !!deleting}
                onClick={() => openCustomEdit(app)}
              >
                {t('编辑')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={customSaving || !!deleting}
                onClick={() => setDeleteTarget(app)}
              >
                {t('删除')}
              </Button>
            </>
          )}
          {app.installed ? (
            compose ? (
              // Compose 已安装：提供 启停/重启/参数/升级/卸载
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!!actionId || !canManage}
                  loading={actionId === app.id}
                  onClick={() => handleControl(app, app.running ? 'stop' : 'start')}
                >
                  {app.running ? t('停止') : t('启动')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!actionId || !canManage}
                  onClick={() => handleControl(app, 'restart')}
                >
                  {t('重启')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!!actionId || updatingParams || !canManage}
                  loading={updatingParams}
                  onClick={() => openParams(app)}
                >
                  {t('参数')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!!actionId || !canManage}
                  loading={actionId === app.id}
                  onClick={() => handleUpgrade(app)}
                >
                  {t('升级')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setUninstallTarget(app)}
                  disabled={installing || !canManage}
                >
                  {t('卸载')}
                </Button>
              </>
            ) : (
              // 单容器已安装：保持原有启停/重启/卸载逻辑
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!!actionId || !canManage}
                  loading={actionId === app.id}
                  onClick={() =>
                    handleControl(app, app.running ? 'stop' : 'start')
                  }
                >
                  {app.running ? t('停止') : t('启动')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!actionId || !canManage}
                  onClick={() => handleControl(app, 'restart')}
                >
                  {t('重启')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setUninstallTarget(app)}
                  disabled={installing || !canManage}
                >
                  {t('卸载')}
                </Button>
              </>
            )
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={installing}
              disabled={!canManage || (!!installingId && !installing)}
              onClick={() => openInstall(app)}
            >
              {installing ? t('安装中') : t('安装')}
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
              placeholder={t('搜索应用名称或描述')}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <select
              className="input appstore-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="all">{t('全部分类')}</option>
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
                {t('全部应用')}
              </button>
              <button
                className={`appstore-tabs__item ${view === 'installed' ? 'is-active' : ''}`}
                onClick={() => setView('installed')}
              >
                {t('已安装 (')}{installedCount})
              </button>
            </div>
            {canManage && (
              <Button variant="primary" size="sm" onClick={openCustomAdd}>
                {t('新增自定义应用')}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
              {t('刷新')}
            </Button>
          </div>
        }
      >
        <div className="appstore-tip">
          {t('从内置目录一键安装常用应用，安装后将以容器方式运行于 Docker 引擎中。')}
        </div>

        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title={t('拉取应用商店失败')}
            description={loadError || t('请检查 Docker 引擎连接后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={fetchAppStore}>
                {t('重试')}
              </Button>
            }
          />
        ) : filteredApps.length === 0 ? (
          <Empty
            title={view === 'installed' ? t('暂无已安装应用') : t('未找到匹配应用')}
            description={view === 'installed' ? t('前往"全部应用"安装所需应用') : t('尝试更换搜索关键字')}
          />
        ) : (
          <div className="appstore-grid">{filteredApps.map(renderAppCard)}</div>
        )}
      </Card>

      {/* 应用详情弹窗 */}
      <Modal
        open={!!detailTarget}
        title={detailTarget ? `${detailTarget.icon} ${detailTarget.name}` : t('应用详情')}
        onClose={() => setDetailTarget(null)}
        width={520}
      >
        {detailTarget && <AppStoreDetail app={detailTarget} />}
      </Modal>

      {/* 安装前环境变量配置弹窗 */}
      <Modal
        open={!!installTarget}
        title={installTarget ? t('安装 {{v1}}', { v1: installTarget.name }) : t('应用配置')}
        onClose={() => !installing && setInstallTarget(null)}
        width={540}
        footer={
          <div className="appstore-install__footer">
            <Button variant="ghost" size="md" onClick={() => setInstallTarget(null)} disabled={installing}>
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={installing}
              disabled={!installTarget || !canManage}
              onClick={() => installTarget && handleInstall(installTarget)}
            >
              {t('确认安装')}
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
              label={t('镜像源')}
              hint={t('留空则依次尝试所有启用的镜像源，单个不可用会自动切换（多源容灾）')}
            >
              <Select value={installSource} onChange={(e) => setInstallSource(e.target.value)}>
                <option value="">{t('使用默认镜像源')}</option>
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

      {/* 自定义应用新增/编辑弹窗 */}
      <Modal
        open={customModalOpen}
        title={customTarget ? t('编辑自定义应用 {{v1}}', { v1: customTarget.name }) : t('新增自定义应用')}
        onClose={() => !customSaving && setCustomModalOpen(false)}
        width={600}
        footer={
          <div className="appstore-install__footer">
            <Button variant="ghost" size="md" onClick={() => setCustomModalOpen(false)} disabled={customSaving}>
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={customSaving}
              disabled={!canManage}
              onClick={handleCustomSave}
            >
              {customTarget ? t('保存修改') : t('创建应用')}
            </Button>
          </div>
        }
      >
        <CustomAppForm
          name={customName}
          setName={setCustomName}
          description={customDescription}
          setDescription={setCustomDescription}
          category={customCategory}
          setCategory={setCustomCategory}
          image={customImage}
          setImage={setCustomImage}
          icon={customIcon}
          setIcon={setCustomIcon}
          tags={customTags}
          setTags={setCustomTags}
          customPorts={customPorts}
          setCustomPorts={setCustomPorts}
          customEnv={customEnv}
          setCustomEnv={setCustomEnv}
          customVolumes={customVolumes}
          setCustomVolumes={setCustomVolumes}
        />
      </Modal>

      {/* 卸载确认框 */}
      <ConfirmDialog
        open={!!uninstallTarget}
        title={t('卸载应用')}
        message={
          uninstallTarget && isCompose(uninstallTarget)
            ? t('确定要卸载套件 "{{v1}}" 吗？将停止并删除其全部容器，且会删除该项目关联的数据卷（compose down -v）与项目目录。', { v1: uninstallTarget.name })
            : t('确定要卸载应用 "{{v1}}" 吗？将停止并删除其对应的容器。', { v1: uninstallTarget?.name || '' })
        }
        confirmText={t('卸载')}
        danger
        loading={uninstalling}
        onConfirm={handleUninstall}
        onCancel={() => setUninstallTarget(null)}
      />

      {/* 自定义应用删除确认框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('删除自定义应用')}
        message={t('确定要删除自定义应用 "{{v1}}" 吗？删除后该应用定义将不可恢复。', { v1: deleteTarget?.name || '' })}
        confirmText={t('删除')}
        danger
        loading={deleting}
        onConfirm={handleCustomDelete}
        onCancel={() => setDeleteTarget(null)}
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
        <div className="appstore-detail__suite">{t('多容器套件')}</div>
      )}
      <div className="appstore-detail__row">
        <span className="appstore-detail__label">{t('镜像')}</span>
        <span className="appstore-detail__value appstore-detail__value--mono">{app.image}</span>
      </div>
      {app.version && (
        <div className="appstore-detail__row">
          <span className="appstore-detail__label">{t('版本')}</span>
          <span className="appstore-detail__value">{app.version}</span>
        </div>
      )}
      {app.running !== undefined ? (
        // 已安装：展示实时运行/停止状态
        <div className="appstore-detail__row">
          <span className="appstore-detail__label">{t('状态')}</span>
          <span className="appstore-detail__value">{app.running ? t('运行中') : t('已停止')}</span>
        </div>
      ) : (
        compose && (
          <div className="appstore-detail__row">
            <span className="appstore-detail__label">{t('状态')}</span>
            <span className="appstore-detail__value">{t('套件')}</span>
          </div>
        )
      )}
      {app.port && (
        <div className="appstore-detail__row">
          <span className="appstore-detail__label">{t('端口')}</span>
          <span className="appstore-detail__value appstore-detail__value--mono">{app.port}</span>
        </div>
      )}

      {compose && app.services && app.services.length > 0 && (
        <>
          <div className="appstore-detail__section">{t('服务列表')}</div>
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
          <div className="appstore-detail__section">{t('端口映射')}</div>
          <div className="appstore-detail__list">
            {app.ports.map((p, i) => (
              <div className="appstore-detail__line" key={i}>
                <span className="appstore-detail__list-key">{t('容器 {{name}}', { name: p.container })}</span>
                <span className="appstore-detail__list-val">
                  {t('宿主机')} {(p.host ?? p.container)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {app.env && app.env.length > 0 && (
        <>
          <div className="appstore-detail__section">{t('环境变量')}</div>
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
          <div className="appstore-detail__section">{t('挂载卷')}</div>
          <div className="appstore-detail__list">
            {app.volumes.map((v, i) => (
              <div className="appstore-detail__line" key={i}>
                <span className="appstore-detail__list-key">{v.container}</span>
                <span className="appstore-detail__list-val">{v.host ?? t('自动命名卷')}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!hasDetail && app.running === undefined && (
        <div className="appstore-detail__empty">{t('该应用无额外配置。')}</div>
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
          ? t('多容器套件，卷已由模板配置，安装时将使用以下环境变量与端口映射。')
          : t('安装后将使用以下环境变量、端口映射与挂载卷创建容器，可在此调整默认配置。')}
      </div>
      {envList.length === 0 ? (
        <div className="appstore-install__none">{t('该应用无需配置环境变量，将使用默认配置安装。')}</div>
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

      <div className="appstore-install__sec">{t('端口映射')}</div>
      {installPorts.length === 0 ? (
        <div className="appstore-install__none">{t('该应用无需映射端口，或可手动添加。')}</div>
      ) : (
        <div className="appstore-install__rows">
          {installPorts.map((p, index) => (
            <div className="appstore-install__row" key={index}>
              <Field label={t('容器端口')} className="appstore-install__cell">
                <Input
                  value={p.container}
                  placeholder="8080"
                  onChange={(ev) => updatePort(index, 'container', ev.target.value)}
                />
              </Field>
              <Field label={t('宿主机端口')} className="appstore-install__cell">
                <Input
                  value={p.host}
                  placeholder={t('可空')}
                  onChange={(ev) => updatePort(index, 'host', ev.target.value)}
                />
              </Field>
              <Field label={t('协议')} className="appstore-install__cell appstore-install__cell--proto">
                <Select
                  value={p.protocol}
                  onChange={(ev) => updatePort(index, 'protocol', ev.target.value)}
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </Select>
              </Field>
              <Button variant="ghost" size="sm" onClick={() => removePort(index)}>
                {t('删除')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="appstore-install__add">
        <Button variant="secondary" size="sm" onClick={addPort}>
          {t('+ 添加端口')}
        </Button>
      </div>

      {!compose && (
        <>
          <div className="appstore-install__sec">{t('挂载卷')}</div>
          {installVolumes.length === 0 ? (
            <div className="appstore-install__none">{t('该应用无需挂载卷，或可手动添加。')}</div>
          ) : (
            <div className="appstore-install__rows">
              {installVolumes.map((v, index) => (
                <div className="appstore-install__row" key={index}>
                  <Field label={t('来源')} className="appstore-install__cell">
                    <Input
                      value={v.source}
                      placeholder={t('宿主机路径或卷名')}
                      onChange={(ev) => updateVolume(index, 'source', ev.target.value)}
                    />
                  </Field>
                  <Field label={t('容器路径')} className="appstore-install__cell">
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
                    {t('只读')}
                  </label>
                  <Button variant="ghost" size="sm" onClick={() => removeVolume(index)}>
                    {t('删除')}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="appstore-install__add">
            <Button variant="secondary" size="sm" onClick={addVolume}>
              {t('+ 添加挂载')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 自定义应用新增/编辑表单：基础字段（名称/镜像/分类/图标/描述/标签）
 * 以及可增删编辑的环境变量、端口映射、挂载卷列表。
 * 端口/卷/env 的行编辑逻辑复用 appstore-install__ 样式。
 * @param param0 表单字段与控制回调
 */
function CustomAppForm({
  name,
  setName,
  description,
  setDescription,
  category,
  setCategory,
  image,
  setImage,
  icon,
  setIcon,
  tags,
  setTags,
  customPorts,
  setCustomPorts,
  customEnv,
  setCustomEnv,
  customVolumes,
  setCustomVolumes,
}: {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  image: string;
  setImage: (v: string) => void;
  icon: string;
  setIcon: (v: string) => void;
  tags: string;
  setTags: (v: string) => void;
  customPorts: Array<{ container: string; host: string; protocol: string }>;
  setCustomPorts: React.Dispatch<
    React.SetStateAction<Array<{ container: string; host: string; protocol: string }>>
  >;
  customEnv: Array<{ key: string; value: string; desc: string }>;
  setCustomEnv: React.Dispatch<
    React.SetStateAction<Array<{ key: string; value: string; desc: string }>>
  >;
  customVolumes: Array<{ source: string; target: string; readonly: boolean }>;
  setCustomVolumes: React.Dispatch<
    React.SetStateAction<Array<{ source: string; target: string; readonly: boolean }>>
  >;
}) {
  /**
   * 更新单条环境变量行
   * @param index 行索引
   * @param field 字段名
   * @param value 字段新值
   */
  const updateEnvRow = (index: number, field: 'key' | 'value' | 'desc', value: string) => {
    setCustomEnv((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
  };

  /**
   * 删除单条环境变量行
   * @param index 行索引
   */
  const removeEnvRow = (index: number) => {
    setCustomEnv((prev) => prev.filter((_, i) => i !== index));
  };

  /**
   * 增加一条空环境变量行
   */
  const addEnvRow = () => {
    setCustomEnv((prev) => [...prev, { key: '', value: '', desc: '' }]);
  };

  /**
   * 更新单条端口映射行
   * @param index 行索引
   * @param field 字段名
   * @param value 字段新值
   */
  const updatePortRow = (
    index: number,
    field: 'container' | 'host' | 'protocol',
    value: string
  ) => {
    setCustomPorts((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  };

  /**
   * 删除单条端口映射行
   * @param index 行索引
   */
  const removePortRow = (index: number) => {
    setCustomPorts((prev) => prev.filter((_, i) => i !== index));
  };

  /**
   * 增加一条空端口映射行
   */
  const addPortRow = () => {
    setCustomPorts((prev) => [...prev, { container: '', host: '', protocol: 'tcp' }]);
  };

  /**
   * 更新单条挂载卷行
   * @param index 行索引
   * @param field 字段名
   * @param value 字段新值
   */
  const updateVolumeRow = (
    index: number,
    field: 'source' | 'target' | 'readonly',
    value: string | boolean
  ) => {
    setCustomVolumes((prev) => prev.map((v, i) => (i === index ? { ...v, [field]: value } : v)));
  };

  /**
   * 删除单条挂载卷行
   * @param index 行索引
   */
  const removeVolumeRow = (index: number) => {
    setCustomVolumes((prev) => prev.filter((_, i) => i !== index));
  };

  /**
   * 增加一条空挂载卷行
   */
  const addVolumeRow = () => {
    setCustomVolumes((prev) => [...prev, { source: '', target: '', readonly: false }]);
  };

  return (
    <div className="appstore-install">
      <div className="appstore-install__tip">
        {t('定义一个镜像应用，保存后将出现在应用商店网格中，可像内置应用一样安装/卸载。')}
      </div>

      <div className="appstore-install__fields">
        <Field label={t('应用名称')} required>
          <Input
            value={name}
            placeholder={t('如：MyApp')}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t('镜像名称')} required hint={t('如：nginx:latest')}>
          <Input
            value={image}
            placeholder={t('镜像名:标签')}
            onChange={(e) => setImage(e.target.value)}
          />
        </Field>
        <Field label={t('分类')}>
          <Input
            value={category}
            placeholder={t('如：数据库 / 开发工具（留空为“自定义”）')}
            onChange={(e) => setCategory(e.target.value)}
          />
        </Field>
        <Field label={t('图标')} hint={t('使用一个 emoji 作为图标')}>
          <Input value={icon} placeholder="📦" onChange={(e) => setIcon(e.target.value)} />
        </Field>
        <Field label={t('描述')}>
          <Input
            value={description}
            placeholder={t('简要描述该应用')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label={t('标签')} hint={t('多个标签用空格或逗号分隔')}>
          <Input
            value={tags}
            placeholder="web proxy http"
            onChange={(e) => setTags(e.target.value)}
          />
        </Field>
      </div>

      <div className="appstore-install__sec">{t('环境变量')}</div>
      {customEnv.length === 0 ? (
        <div className="appstore-install__none">{t('暂无环境变量，可手动添加。')}</div>
      ) : (
        <div className="appstore-install__rows">
          {customEnv.map((e, index) => (
            <div className="appstore-install__row" key={index}>
              <Field label={t('键')} className="appstore-install__cell">
                <Input
                  value={e.key}
                  placeholder="KEY"
                  onChange={(ev) => updateEnvRow(index, 'key', ev.target.value)}
                />
              </Field>
              <Field label={t('值')} className="appstore-install__cell">
                <Input
                  value={e.value}
                  placeholder={t('默认值')}
                  onChange={(ev) => updateEnvRow(index, 'value', ev.target.value)}
                />
              </Field>
              <Field label={t('说明')} className="appstore-install__cell">
                <Input
                  value={e.desc}
                  placeholder={t('可空')}
                  onChange={(ev) => updateEnvRow(index, 'desc', ev.target.value)}
                />
              </Field>
              <Button variant="ghost" size="sm" onClick={() => removeEnvRow(index)}>
                {t('删除')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="appstore-install__add">
        <Button variant="secondary" size="sm" onClick={addEnvRow}>
          {t('+ 添加环境变量')}
        </Button>
      </div>

      <div className="appstore-install__sec">{t('端口映射')}</div>
      {customPorts.length === 0 ? (
        <div className="appstore-install__none">{t('暂无端口映射，可手动添加。')}</div>
      ) : (
        <div className="appstore-install__rows">
          {customPorts.map((p, index) => (
            <div className="appstore-install__row" key={index}>
              <Field label={t('容器端口')} className="appstore-install__cell">
                <Input
                  value={p.container}
                  placeholder="8080"
                  onChange={(ev) => updatePortRow(index, 'container', ev.target.value)}
                />
              </Field>
              <Field label={t('宿主机端口')} className="appstore-install__cell">
                <Input
                  value={p.host}
                  placeholder={t('可空')}
                  onChange={(ev) => updatePortRow(index, 'host', ev.target.value)}
                />
              </Field>
              <Field label={t('协议')} className="appstore-install__cell appstore-install__cell--proto">
                <Select
                  value={p.protocol}
                  onChange={(ev) => updatePortRow(index, 'protocol', ev.target.value)}
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </Select>
              </Field>
              <Button variant="ghost" size="sm" onClick={() => removePortRow(index)}>
                {t('删除')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="appstore-install__add">
        <Button variant="secondary" size="sm" onClick={addPortRow}>
          {t('+ 添加端口')}
        </Button>
      </div>

      <div className="appstore-install__sec">{t('挂载卷')}</div>
      {customVolumes.length === 0 ? (
        <div className="appstore-install__none">{t('暂无挂载卷，可手动添加。')}</div>
      ) : (
        <div className="appstore-install__rows">
          {customVolumes.map((v, index) => (
            <div className="appstore-install__row" key={index}>
              <Field label={t('来源')} className="appstore-install__cell">
                <Input
                  value={v.source}
                  placeholder={t('宿主机路径或卷名')}
                  onChange={(ev) => updateVolumeRow(index, 'source', ev.target.value)}
                />
              </Field>
              <Field label={t('容器路径')} className="appstore-install__cell">
                <Input
                  value={v.target}
                  placeholder="/data"
                  onChange={(ev) => updateVolumeRow(index, 'target', ev.target.value)}
                />
              </Field>
              <label className="appstore-install__check">
                <input
                  type="checkbox"
                  checked={v.readonly}
                  onChange={(ev) => updateVolumeRow(index, 'readonly', ev.target.checked)}
                />
                {t('只读')}
              </label>
              <Button variant="ghost" size="sm" onClick={() => removeVolumeRow(index)}>
                {t('删除')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="appstore-install__add">
        <Button variant="secondary" size="sm" onClick={addVolumeRow}>
          {t('+ 添加挂载')}
        </Button>
      </div>
    </div>
  );
}
