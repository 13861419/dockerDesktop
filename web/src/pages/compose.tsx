/**
 * Docker Compose 项目管理页
 *
 * 展示主机上的 Compose 项目列表，支持新建项目、启动 / 停止 / 重启服务、
 * 查看配置与删除项目等操作。
 */
import React, { useCallback, useEffect, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import Empty from '../components/Empty';
import { Field, Input, Select } from '../components/Form';
import YamlEditor from '../components/YamlEditor';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import StateActions from '../components/StateActions';
import { useCanManage } from '../hooks/useCanManage';
import { ComposeProject, ComposeService, ComposeTemplate, ComposeStructure } from '../types';
import { translateNow as t } from '../i18n';
import './compose.less';

/**
 * 内置 docker-compose.yml 模板（自有定义，其结构与用户 Compose 模板一致）
 */
const COMPOSE_TEMPLATES: {
  /** 模板唯一标识 */
  id: string;
  /** 模板名称（下拉中展示） */
  name: string;
  /** 模板说明（下拉预览行展示） */
  description: string;
  /** 完整的 docker-compose.yml 文本 */
  content: string;
}[] = [
  {
    id: 'wordpress',
    name: 'WordPress',
    description: t('WordPress + MySQL 博客站点'),
    content: `version: "3"
services:
  wordpress:
    image: wordpress:latest
    restart: always
    ports:
      - "8080:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wordpress_data:/var/www/html
    depends_on:
      - db
  db:
    image: mysql:8.0
    restart: always
    environment:
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: wordpress
      MYSQL_ROOT_PASSWORD: rootpass
    volumes:
      - db_data:/var/lib/mysql
volumes:
  wordpress_data:
  db_data:`,
  },
  {
    id: 'nginx',
    name: t('Nginx 静态站'),
    description: t('Nginx 静态网站托管'),
    content: `version: "3"
services:
  web:
    image: nginx:alpine
    restart: always
    ports:
      - "8080:80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro`,
  },
  {
    id: 'redis',
    name: 'Redis',
    description: t('Redis 缓存服务（含密码）'),
    content: `version: "3"
services:
  redis:
    image: redis:7-alpine
    restart: always
    ports:
      - "6379:6379"
    command: redis-server --requirepass redispass
    volumes:
      - redis_data:/data
volumes:
  redis_data:`,
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: t('PostgreSQL 数据库服务'),
    content: `version: "3"
services:
  postgres:
    image: postgres:16-alpine
    restart: always
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: appdb
    volumes:
      - pg_data:/var/lib/postgresql/data
volumes:
  pg_data:`,
  },
  {
    id: 'node',
    name: t('Node.js 应用'),
    description: t('Node.js 应用 + 构建后运行'),
    content: `version: "3"
services:
  app:
    build: .
    restart: always
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
    volumes:
      - ./:/app
    command: npm start`,
  },
];

/**
 * 根据下拉 value 查找对应的 Compose 模板（内置或用户自建）
 * 用户模板的 value 以 'tpl:' 前缀标识模板 id，用于区分内置模板名与用户模板
 * @param value 下拉 value（'' 表示空白）
 * @param userTemplates 用户自建模板列表
 * @returns 命中的模板，未命中则返回 undefined
 */
function findTemplateByValue(value: string, userTemplates: ComposeTemplate[]) {
  if (!value) return undefined;
  if (value.startsWith('tpl:')) {
    return userTemplates.find((t) => 'tpl:' + t.id === value);
  }
  return COMPOSE_TEMPLATES.find((t) => t.id === value);
}

/** 字节快捷格式化（资源看板用） */
function formatBytesShort(n: number): string {
  if (!n || n <= 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < 4) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${i > 0 ? ' ' : ''}${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}

/**
 * Compose 项目管理页组件
 */
export default function ComposePage() {
  const { showToast } = useToast();
  const { hasPerm } = useCanManage();
  const canManage = hasPerm('compose.write');
  const canDelete = hasPerm('compose.write');
  const [projects, setProjects] = useState<ComposeProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');

  // 各项目的服务运行状态（name → compose ps 结果）
  const [statusMap, setStatusMap] = useState<Record<string, ComposeService[]>>({});

  // 日志弹窗状态
  const [logOpen, setLogOpen] = useState(false);
  const [logName, setLogName] = useState('');
  const [logContent, setLogContent] = useState('');
  const [logLoading, setLogLoading] = useState(false);

  // 新建项目弹窗状态
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createContent, setCreateContent] = useState('');
  // YAML 校验错误（保存被拒绝时回显到编辑器）
  const [createYamlErr, setCreateYamlErr] = useState<{ message: string; line: number | null }>({ message: '', line: null });
  // 上传的 compose 文件名（用于界面展示）
  const [createFileName, setCreateFileName] = useState('');
  // 新建弹窗当前选择的模板 id（'' 表示空白）
  const [createTemplate, setCreateTemplate] = useState('');
  const [creating, setCreating] = useState(false);

  // 编辑项目弹窗状态
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  // 编辑 YAML 校验错误（保存被拒绝时回显到编辑器）
  const [editYamlErr, setEditYamlErr] = useState<{ message: string; line: number | null }>({ message: '', line: null });
  const [editLoading, setEditLoading] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  // 编辑弹窗全屏（1.52.0）
  const [editFull, setEditFull] = useState(false);
  // compose 文件编辑历史（1.52.0）
  const [histOpen, setHistOpen] = useState(false);
  const [histLoading, setHistLoading] = useState(false);
  const [histItems, setHistItems] = useState<Array<{ id: number; username: string; createdAt: number }>>([]);
  const [histLoadingId, setHistLoadingId] = useState<number | null>(null);

  // 用户保存的 Compose 模板（来自 /api/compose-templates，用于"从模板新建"下拉）
  const [userTemplates, setUserTemplates] = useState<ComposeTemplate[]>([]);
  // 保存为模板弹窗状态
  const [saveModalOpen, setSaveModalOpen] = useState(false);

// 项目资源看板（1.34.0）
interface ProjectStatService {
  name: string;
  containers: number;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  ioR: number;
  ioW: number;
}
const [statsOpen, setStatsOpen] = useState(false);
const [statsName, setStatsName] = useState('');
const [statsData, setStatsData] = useState<ProjectStatService[] | null>(null);
const [statsLoading, setStatsLoading] = useState(false);
const [rollingSvc, setRollingSvc] = useState('');
const [rollingAllRunning, setRollingAllRunning] = useState(false);
  const [driftOpen, setDriftOpen] = useState(false);
  const [driftEngine, setDriftEngine] = useState('');
const [driftRunning, setDriftRunning] = useState(false);
const [driftResult, setDriftResult] = useState<{ engine: string; driftCount: number; services: Array<{ service: string; status: string; diffs: string[]; local: any; remote: any; containers: number }> } | null>(null);
const [distEngines, setDistEngines] = useState('');
const [distOpen, setDistOpen] = useState(false);
const [distDeploy, setDistDeploy] = useState(false);
const [distRunning, setDistRunning] = useState(false);
const [engineHints, setEngineHints] = useState<string[]>([]);
  const [saveModalName, setSaveModalName] = useState('');
  const [saveModalDesc, setSaveModalDesc] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  // 停止（down）确认弹窗状态：记录目标项目与是否删除数据卷
  const [stopTarget, setStopTarget] = useState<ComposeProject | null>(null);
  const [stopVolumes, setStopVolumes] = useState(false);
  const [stopping, setStopping] = useState(false);

  // docker run 导入弹窗状态
  const [runImportOpen, setRunImportOpen] = useState(false);
  const [runImportCmd, setRunImportCmd] = useState('');
  const [runImportYaml, setRunImportYaml] = useState('');
  const [runImportWarnings, setRunImportWarnings] = useState<string[]>([]);
  const [runImportErr, setRunImportErr] = useState('');
  const [runImportLoading, setRunImportLoading] = useState(false);

  // 查看配置弹窗状态
  const [configOpen, setConfigOpen] = useState(false);
  const [configTitle, setConfigTitle] = useState('');
  const [configContent, setConfigContent] = useState('');

  // 结构视图弹窗状态
  const [structureOpen, setStructureOpen] = useState(false);
  const [structureData, setStructureData] = useState<ComposeStructure | null>(null);
  const [structureLoading, setStructureLoading] = useState(false);
  // 服务级操作加载状态（记录正在操作的 服务名/动作）
  const [serviceOpKey, setServiceOpKey] = useState<string | null>(null);

  // 操作中的项目与删除确认状态（删除时额外记录是否删除数据卷）
  const [opName, setOpName] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ComposeProject | null>(null);
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /**
   * 执行 Compose 操作（启动 / 停止 / 重启）
   * @param project 项目
   * @param action 动作标识
   * @param successMsg 成功提示
   * @param body 可选请求体
   */
  const runAction = useCallback(
    async (project: ComposeProject, action: string, successMsg: string, body?: object) => {
      if (!canManage) {
        showToast(t('仅管理员可操作 Compose 项目'), 'error');
        return;
      }
      const name = project.name;
      setOpName(name);
      try {
        await post(projectUrl(name) + '/' + action, body);
        showToast(successMsg);
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || successMsg.replace(t('成功'), t('失败')), 'error');
      } finally {
        setOpName(null);
      }
    },
    [canManage, showToast]
  );

  /** 解析并设置项目操作中的名称（项目名可能含特殊字符，需编码） */
  const projectUrl = (name: string): string => '/api/compose/' + encodeURIComponent(name);

  /** 打开项目资源看板（1.34.0） */
  const openStats = useCallback(async (name: string) => {
    setStatsName(name);
    setStatsOpen(true);
    setStatsLoading(true);
    setStatsData(null);
    try {
      const data = await get<{ services: ProjectStatService[] }>(projectUrl(name) + '/stats');
      setStatsData(data.services || []);
    } catch {
      setStatsData([]);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  /** 服务级滚动更新：pull 最新镜像 + 仅重建该服务；失败自动回滚（1.35.0） */
  const rollingUpdate = useCallback(
    async (name: string, service: string) => {
      setRollingSvc(service);
      try {
        const r = await post<{ ok: boolean; rolledBack?: boolean; healthOk?: boolean }>(
          projectUrl(name) + '/rolling-update',
          { service },
        );
        if (r.rolledBack) showToast(t('更新失败，已自动回滚到旧镜像'), 'error');
        else if (r.healthOk === false) showToast(t('更新完成，但健康检查未通过'), 'error');
        else showToast(t('服务 {{s}} 已更新并重建', { s: service }), 'success');
        const data = await get<{ services: ProjectStatService[] }>(projectUrl(name) + '/stats');
        setStatsData(data.services || []);
      } catch (e: any) {
        showToast(e?.message || t('滚动更新失败'), 'error');
      } finally {
        setRollingSvc('');
      }
    },
    [],
  );

  /** 全项目滚动更新编排（1.37.0）：按服务顺序逐个滚动更新，单服务失败不中断 */
  const rollingUpdateAll = useCallback(async () => {
    setRollingAllRunning(true);
    try {
      const r = await post<{
        ok: boolean;
        summary: string;
        results: Array<{ service: string; ok: boolean; healthOk: boolean; rolledBack: boolean; detail: string }>;
      }>(projectUrl(statsName) + '/rolling-update-all', {});
      for (const item of r.results || []) {
        if (item.ok) showToast(t('服务 {{s}} 已更新并重建', { s: item.service }), 'success');
        else if (item.rolledBack) showToast(t('服务 {{s}} 更新失败，已自动回滚到旧镜像', { s: item.service }), 'error');
        else showToast(t('服务 {{s}} 更新失败', { s: item.service }), 'error');
      }
      showToast(r.summary || (r.ok ? t('全部服务更新完成') : t('部分服务更新失败')), r.ok ? 'success' : 'error');
      const data = await get<{ services: ProjectStatService[] }>(projectUrl(statsName) + '/stats');
      setStatsData(data.services || []);
    } catch (e: any) {
      showToast(e?.message || t('滚动更新失败'), 'error');
    } finally {
      setRollingAllRunning(false);
    }
  }, [statsName]);

  /** 远端配置漂移检测（1.37.0）：本地 compose 配置与目标引擎实际容器比对 */
  const driftCheck = useCallback(async () => {
    setDriftRunning(true);
    setDriftResult(null);
    try {
      const r = await get<{ engine: string; driftCount: number; services: Array<{ service: string; status: string; diffs: string[]; local: any; remote: any; containers: number }> }>(
        projectUrl(statsName) + '/drift',
        driftEngine.trim() ? { endpoint: driftEngine.trim() } : undefined,
      );
      setDriftResult(r);
    } catch (e: any) {
      showToast(e?.message || t('漂移检测失败'), 'error');
    } finally {
      setDriftRunning(false);
    }
  }, [statsName, driftEngine]);

  /** 漂移自动修复（1.40.0）：勾选要修复的服务，按本地配置重建；1.42.0 支持删除本地缺失（remoteOnly） */
  const [fixSel, setFixSel] = useState<Record<string, boolean>>({});
  const [fixSelRemove, setFixSelRemove] = useState<Record<string, boolean>>({});
  const [fixRunning, setFixRunning] = useState(false);

  const fixDrift = useCallback(async () => {
    const services = Object.keys(fixSel).filter((k) => fixSel[k]);
    const removeServices = Object.keys(fixSelRemove).filter((k) => fixSelRemove[k]);
    if (services.length === 0 && removeServices.length === 0) {
      showToast(t('请勾选要修复的服务'), 'error');
      return;
    }
    setFixRunning(true);
    try {
      const r = await post<{ ok: boolean; results: Array<{ service: string; ok: boolean; detail: string }> }>(
        projectUrl(statsName) + '/fix-drift',
        {
          services,
          removeServices,
          ...(driftEngine.trim() ? { endpoint: driftEngine.trim() } : {}),
        },
      );
      const okCount = (r?.results || []).filter((x) => x.ok).length;
      showToast(t('修复完成：成功 {{v1}}，失败 {{v2}}', { v1: okCount, v2: services.length + removeServices.length - okCount }));
      setFixSel({});
      setFixSelRemove({});
      await driftCheck();
    } catch (e: any) {
      showToast(e?.message || t('修复失败'), 'error');
    } finally {
      setFixRunning(false);
    }
  }, [fixSel, fixSelRemove, statsName, driftEngine, driftCheck, showToast]);

  /** 跨引擎镜像分发：把项目镜像预拉取到远端引擎，可选继续代理部署（1.35.0） */
  const distribute = useCallback(async () => {
    const engines = distEngines
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (engines.length === 0) {
      showToast(t('请至少填写一个远端引擎地址'), 'error');
      return;
    }
    setDistRunning(true);
    try {
      const r = await post<{ ok: boolean; results: Array<{ engine: string; image: string; ok: boolean; detail: string }> }>(
        projectUrl(statsName) + '/distribute',
        { engines, deploy: distDeploy },
      );
      const fail = r.results.filter((x) => !x.ok).length;
      showToast(fail === 0 ? t('全部镜像分发成功') : t('{{n}} 项分发失败，详见操作日志', { n: fail }), fail === 0 ? 'success' : 'error');
      setDistOpen(false);
    } catch (e: any) {
      showToast(e?.message || t('分发失败'), 'error');
    } finally {
      setDistRunning(false);
    }
  }, [distEngines, distDeploy, statsName]);

  /** 打开分发弹窗时尝试预填远端引擎列表（多引擎场景） */
  const openDistribute = useCallback(async () => {
    setDistOpen(true);
    try {
      const data = await get<{ engines?: Array<{ endpoint: string }> }>('/api/engines');
      const list = (data.engines || []).map((e) => e.endpoint).filter((e) => e && (e.startsWith('tcp://') || e.startsWith('http')));
      setEngineHints(list);
    } catch {
      setEngineHints([]);
    }
  }, []);


  /**
   * 拉取单个项目的服务运行状态（compose ps）
   * @param name 项目名
   */
  const loadStatus = useCallback(
    async (name: string) => {
      try {
        const data = await get<{ services?: ComposeService[] }>(projectUrl(name));
        // 响应形如 { name, path, services }，仅保留服务数组（1.53.0 修复：此前误存整个响应对象）
        const services = Array.isArray(data?.services) ? data.services : [];
        setStatusMap((prev) => ({ ...prev, [name]: services }));
      } catch {
        // 拉取失败时不显示具体状态，置为空
        setStatusMap((prev) => ({ ...prev, [name]: [] }));
      }
    },
    []
  );

  /**
   * 拉取 Compose 项目列表
   */
  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<ComposeProject[]>('/api/compose');
      setProjects(data || []);
      setLoadError('');
      // 逐个拉取各项目的服务运行状态
      (data || []).forEach((p) => loadStatus(p.name));
    } catch (e: any) {
      setLoadError(e?.message || t('拉取项目列表失败'));
      showToast(e?.message || t('拉取项目列表失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, loadStatus]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects, refreshKey]);

  /**
   * 读取用户选择的 compose 文件，将内容填入新建弹窗的文本框，并记录文件名
   * @param file 选择的文件
   */
  const handleUploadFile = useCallback(
    (file: File | undefined | null) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        setCreateContent(text);
        setCreateFileName(file.name);
      };
      reader.onerror = () => {
        showToast(t('读取文件失败'), 'error');
      };
      reader.readAsText(file);
    },
    [showToast]
  );

  /**
   * 选择内置或用户模板：将所选模板的 content 填充到新建弹窗的文本框，并记录模板 value
   * 用户模板 value 以 'tpl:' 前缀标识（见 findTemplateByValue）
   * @param value 模板 value（'' 表示空白，不改变内容）
   */
  const handleTemplateChange = useCallback(
    (value: string) => {
      setCreateTemplate(value);
      if (!value) return;
      const tpl = findTemplateByValue(value, userTemplates);
      if (tpl) {
        // 选择模板后清除当前内容并填入模板内容
        setCreateContent(tpl.content);
        setCreateFileName('');
      }
    },
    [userTemplates]
  );

  /** 拉取用户保存的 Compose 模板列表，用于"从模板新建"下拉 */
  const fetchUserTemplates = useCallback(async () => {
    try {
      const data = await get<ComposeTemplate[]>('/api/compose-templates');
      setUserTemplates(data || []);
    } catch {
      // 拉取失败时保留空列表，不影响新建流程
      setUserTemplates([]);
    }
  }, []);

  /** 打开"保存为模板"弹窗：用当前项目名作默认模板名，内容取当前编辑内容 */
  const openSaveTemplate = useCallback(() => {
    if (!editContent.trim()) {
      showToast(t('内容为空，暂无法保存为模板'), 'error');
      return;
    }
    // 默认以项目名作为模板名，名称唯一由后端校验
    setSaveModalName(editName);
    setSaveModalDesc('');
    setSaveModalOpen(true);
  }, [editName, editContent, showToast]);

  /** 提交"保存为模板"：携带名称、描述与当前编辑内容写入模板库 */
  const handleSaveTemplate = useCallback(async () => {
    if (!canManage) {
      showToast(t('仅管理员可保存模板'), 'error');
      setSaveModalOpen(false);
      return;
    }
    const name = saveModalName.trim();
    if (!name) {
      showToast(t('请输入模板名称'), 'error');
      return;
    }
    if (!editContent.trim()) {
      showToast(t('内容为空，暂无法保存为模板'), 'error');
      return;
    }
    setSavingTemplate(true);
    try {
      await post('/api/compose-templates', {
        name,
        description: saveModalDesc.trim(),
        content: editContent,
      });
      showToast(t('模板保存成功'));
      setSaveModalOpen(false);
      setSaveModalName('');
      setSaveModalDesc('');
      // 重新拉取模板列表，使新模板立即出现在"从模板新建"下拉
      fetchUserTemplates();
    } catch (e: any) {
      showToast(e?.message || t('模板保存失败'), 'error');
    } finally {
      setSavingTemplate(false);
    }
  }, [canManage, saveModalName, saveModalDesc, editContent, showToast, fetchUserTemplates]);

  /** 新建 Compose 项目 */
  /** 从后端校验错误信息中解析出错行号（返回 null 表示无法定位） */
  function parseYamlLine(msg: string): number | null {
    const m = msg.match(/(?:line|第)\s*(\d+)/i) || msg.match(/:\s*(\d+)\n?/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  const handleCreate = useCallback(async () => {
    if (!canManage) {
      showToast(t('仅管理员可新建 Compose 项目'), 'error');
      setCreateOpen(false);
      return;
    }
    const name = createName.trim();
    if (!name) {
      showToast(t('请输入项目名称'), 'error');
      return;
    }
    if (!createContent.trim()) {
      showToast(t('请输入 docker-compose.yml 内容'), 'error');
      return;
    }
    setCreating(true);
    try {
      await post('/api/compose', { name, content: createContent });
      showToast(t('项目创建成功'));
      setCreateOpen(false);
      setCreateName('');
      setCreateContent('');
      setCreateFileName('');
      setCreateTemplate('');
      setCreateYamlErr({ message: '', line: null });
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      const msg = e?.message || t('项目创建失败');
      const line = parseYamlLine(msg);
      setCreateYamlErr({ message: msg, line });
      showToast(line !== null ? t('Compose YAML 语法有误，请修正后保存') : msg, 'error');
    } finally {
      setCreating(false);
    }
  }, [canManage, createName, createContent, showToast]);

  /** docker run 命令转换为 Compose（调后端解析，不落盘） */
  const handleRunConvert = useCallback(async () => {
    setRunImportLoading(true);
    setRunImportErr('');
    setRunImportYaml('');
    setRunImportWarnings([]);
    try {
      const res = await post<{ yaml: string; warnings: string[] }>('/api/compose/run2compose', { command: runImportCmd });
      setRunImportYaml(res.yaml);
      setRunImportWarnings(res.warnings || []);
    } catch (e: any) {
      setRunImportErr(e?.message || t('转换失败'));
    } finally {
      setRunImportLoading(false);
    }
  }, [runImportCmd, showToast]);

  /** 将转换结果填入新建弹窗的编辑器 */
  const handleRunInsert = useCallback(() => {
    setCreateContent(runImportYaml);
    setRunImportOpen(false);
    setRunImportCmd('');
    setRunImportYaml('');
    setRunImportWarnings([]);
    setRunImportErr('');
  }, [runImportYaml]);


  /** 查看项目配置文件 */
  const handleViewConfig = useCallback(
    async (project: ComposeProject) => {
      try {
        const res = await get<any>(projectUrl(project.name) + '/config');
        const content =
          typeof res === 'string'
            ? res
            : res?.content ||
              res?.config ||
              JSON.stringify(res, null, 2);
        setConfigTitle(project.name);
        setConfigContent(content || t('（无配置文件）'));
        setConfigOpen(true);
      } catch (e: any) {
        showToast(e?.message || t('获取配置失败'), 'error');
      }
    },
    [showToast]
  );

  /**
   * 打开结构视图弹窗并拉取 Compose 配置
   * @param project 目标项目
   */
  const openStructure = useCallback(
    async (project: ComposeProject) => {
      setStructureData(null);
      setStructureOpen(true);
      setStructureLoading(true);
      try {
        const data = await get<ComposeStructure>(projectUrl(project.name) + '/structure');
        setStructureData({
          name: project.name,
          services: data?.services || [],
          volumes: data?.volumes || [],
          networks: data?.networks || [],
        });
      } catch (e: any) {
        showToast(e?.message || t('获取 Compose 结构失败'), 'error');
        setStructureOpen(false);
      } finally {
        setStructureLoading(false);
      }
    },
    [showToast]
  );

  /** 关闭结构视图弹窗 */
  const closeStructure = useCallback(() => {
    setStructureOpen(false);
    setStructureData(null);
    setServiceOpKey(null);
  }, []);

  /**
   * 对单个 compose 服务执行 start / stop / restart 操作
   * @param service 服务名
   * @param action 动作标识
   * @param successMsg 成功提示
   */
  const runServiceAction = useCallback(
    async (service: string, action: string, successMsg: string) => {
      if (!structureData) return;
      if (!canManage) {
        showToast(t('仅管理员可操作 Compose 服务'), 'error');
        return;
      }
      const key = `${service}/${action}`;
      setServiceOpKey(key);
      try {
        await post(projectUrl(structureData.name) + '/services/' + encodeURIComponent(service) + '/' + action);
        showToast(successMsg);
        // 操作后刷新结构数据与项目状态
        const data = await get<ComposeStructure>(projectUrl(structureData.name) + '/structure').catch(() => structureData);
        if (data) {
          setStructureData(data);
        }
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || successMsg.replace(t('成功'), t('失败')), 'error');
      } finally {
        setServiceOpKey(null);
      }
    },
    [canManage, structureData, showToast]
  );

  /** 删除项目（根据 deleteVolumes 决定是否同时删除数据卷） */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canDelete) {
      showToast(t('仅管理员可删除 Compose 项目'), 'error');
      setDeleteTarget(null);
      setDeleteVolumes(false);
      return;
    }
    setDeleting(true);
    try {
      const r = await del<{ ok: boolean; external?: boolean }>(projectUrl(deleteTarget.name), { volumes: deleteVolumes });
      showToast(r?.external ? t('外部项目已下线容器，compose 文件已保留') : t('项目删除成功'));
      setDeleteTarget(null);
      setDeleteVolumes(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('项目删除失败'), 'error');
    } finally {
      setDeleting(false);
    }
  }, [canDelete, deleteTarget, deleteVolumes, showToast]);

  /** 打开编辑弹窗并加载指定项目的 compose 文件内容 */
  const openEdit = useCallback(
    async (project: ComposeProject) => {
      if (!canManage) {
        showToast(t('仅管理员可编辑 Compose 项目'), 'error');
        return;
      }
      setEditName(project.name);
      setEditOpen(true);
      setEditLoading(true);
      setEditContent('');
      try {
        const res = await get<any>(projectUrl(project.name) + '/file');
        const content = typeof res === 'string' ? res : res?.content || '';
        setEditContent(content);
      } catch (e: any) {
        setEditContent('');
        showToast(e?.message || t('获取 compose 文件失败'), 'error');
      } finally {
        setEditLoading(false);
      }
    },
    [canManage, showToast]
  );

  /** 保存编辑后的 compose 文件（复用 POST /api/compose 同名覆盖端点） */
  const handleSaveEdit = useCallback(async () => {
    if (!canManage) {
      showToast(t('仅管理员可编辑 Compose 项目'), 'error');
      setEditOpen(false);
      return;
    }
    const name = editName.trim();
    if (!name) {
      showToast(t('项目名称无效'), 'error');
      return;
    }
    if (!editContent.trim()) {
      showToast(t('请输入 docker-compose.yml 内容'), 'error');
      return;
    }
    setSavingEdit(true);
    try {
      await post('/api/compose', { name, content: editContent });
      showToast(t('项目修改已保存'));
      setEditOpen(false);
      setEditYamlErr({ message: '', line: null });
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      const msg = e?.message || t('保存失败');
      const line = parseYamlLine(msg);
      setEditYamlErr({ message: msg, line });
      showToast(line !== null ? t('Compose YAML 语法有误，请修正后保存') : msg, 'error');
    } finally {
      setSavingEdit(false);
    }
  }, [canManage, editName, editContent, showToast]);

  /** 关闭编辑弹窗 */
  const closeEdit = useCallback(() => {
    setEditOpen(false);
    setEditFull(false);
    setEditName('');
    setEditContent('');
    setEditYamlErr({ message: '', line: null });
  }, []);

  /** 打开 compose 文件编辑历史（1.52.0） */
  const openHistory = useCallback(async () => {
    if (!editName) return;
    setHistOpen(true);
    setHistLoading(true);
    try {
      const data = await get<{ items: Array<{ id: number; username: string; createdAt: number }> }>(
        projectUrl(editName) + '/history'
      );
      setHistItems(data?.items || []);
    } catch {
      setHistItems([]);
    } finally {
      setHistLoading(false);
    }
  }, [editName]);

  /** 载入某个历史版本到编辑器（保存后生效） */
  const loadHistoryVersion = useCallback(
    async (id: number) => {
      setHistLoadingId(id);
      try {
        const data = await get<{ content: string }>(projectUrl(editName) + '/history/' + id + '/content');
        setEditContent(data?.content || '');
        setHistOpen(false);
        showToast(t('已载入历史版本，保存后生效'), 'success');
      } catch (e: any) {
        showToast(e?.message || t('载入历史版本失败'), 'error');
      } finally {
        setHistLoadingId(null);
      }
    },
    [editName, showToast]
  );

  /** 执行停止（down）操作，带删卷选择 */
  const handleStopConfirm = useCallback(async () => {
    if (!stopTarget) return;
    setStopping(true);
    try {
      const resp = await post<{ ok: boolean; approvalPending?: boolean }>(projectUrl(stopTarget.name) + '/down', {
        volumes: stopVolumes,
      });
      if (resp?.approvalPending) {
        showToast(t('该操作已提交审批，等待管理员批准后执行'), 'info');
      } else {
        showToast(stopVolumes ? t('项目已停止，数据卷已删除') : t('项目已停止'));
      }
      setStopTarget(null);
      setStopVolumes(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('停止项目失败'), 'error');
      setStopping(false);
      return;
    }
    setStopping(false);
  }, [stopTarget, stopVolumes, showToast]);

  /**
   * 打开日志弹窗并拉取最近日志
   * @param name 项目名
   */
  const openLog = useCallback(
    async (name: string) => {
      setLogName(name);
      setLogOpen(true);
      setLogLoading(true);
      setLogContent('');
      try {
        const res = await post<unknown>(projectUrl(name) + '/logs', { tail: 200 });
        setLogContent(
          typeof res === 'string' ? res : (res && (res as any).logs) || JSON.stringify(res)
        );
      } catch (e: any) {
        setLogContent('');
        showToast(e?.message || t('获取日志失败'), 'error');
      } finally {
        setLogLoading(false);
      }
    },
    [showToast]
  );

  /**
   * 刷新当前项目日志
   */
  const refreshLog = useCallback(async () => {
    if (!logName) return;
    setLogLoading(true);
    try {
      const res = await post<unknown>(projectUrl(logName) + '/logs', { tail: 200 });
      setLogContent(
        typeof res === 'string' ? res : (res && (res as any).logs) || JSON.stringify(res)
      );
    } catch (e: any) {
      showToast(e?.message || t('刷新日志失败'), 'error');
    } finally {
      setLogLoading(false);
    }
  }, [logName, showToast]);

  /** 关闭日志弹窗 */
  const closeLog = useCallback(() => {
    setLogOpen(false);
    setLogName('');
    setLogContent('');
  }, []);

  return (
    <div className="page">
      <Card
        title={t('Compose 项目')}
        extra={
          <div className="toolbar">
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)}>
              {t('刷新')}
            </Button>
            <Button
              variant="primary"
              disabled={!canManage}
              onClick={() => {
                setCreateFileName('');
                setCreateTemplate('');
                setCreateOpen(true);
                // 打开新建弹窗时拉取用户模板列表，供"从模板新建"下拉使用
                fetchUserTemplates();
              }}
            >
              {t('新建项目')}
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title={t('拉取项目列表失败')}
            description={loadError || t('请检查 Docker 引擎连接后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={fetchProjects}>
                {t('重试')}
              </Button>
            }
          />
        ) : projects.length === 0 ? (
          <Empty title={t('暂无 Compose 项目')} description={t('点击右上角「新建项目」创建')} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('项目名')}</th>
                <th>{t('状态')}</th>
                <th>{t('Compose 文件')}</th>
                <th>{t('路径')}</th>
                <th className="col-actions">{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((proj) => (
                <tr key={proj.name}>
                  <td className="col-name">
                    <div className="name-main" title={proj.source === 'external' ? proj.path : proj.name}>
                      {proj.name}
                    </div>
                    {proj.source === 'external' ? (
                      <div className="name-sub badge badge--muted" title={proj.path}>
                        {t('外部')}
                        {typeof proj.running === 'number' ? ` · ${proj.running}/${proj.total ?? '-'}` : ''}
                      </div>
                    ) : proj.hasCompose ? (
                      <div className="name-sub badge badge--running">{t('已配置')}</div>
                    ) : (
                      <div className="name-sub badge badge--muted">{t('未配置')}</div>
                    )}
                  </td>
                  <td className="status-cell">
                    {statusMap[proj.name] && statusMap[proj.name].length > 0 ? (
                      <div className="status-list">
                        {statusMap[proj.name].map((svc) => (
                          <span
                            key={svc.ID || svc.Name || svc.Service}
                            className={`status-item badge ${
                              /running|up/i.test(svc.State || '')
                                ? 'badge--running'
                                : 'badge--muted'
                            }`}
                            title={`${svc.Name || svc.Service || ''} - ${svc.State || svc.Status || ''}`}
                          >
                            {svc.Name || svc.Service || '-'}
                            <em>{svc.State || svc.Status || '-'}</em>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="badge badge--muted">-</span>
                    )}
                  </td>
                  <td className="col-mono" title={proj.composeFile || '-'}>
                    {proj.composeFile || '-'}
                  </td>
                  <td className="col-mono" title={proj.path}>
                    {proj.path}
                  </td>
                  <td className="col-actions">
                    <div className="row-actions">
                      {/* 生命周期操作：状态下拉（启动/停止/重启），与容器页一致（1.52.0） */}
                      <StateActions
                        state={
                          (Array.isArray(statusMap[proj.name]) &&
                            (statusMap[proj.name] as ComposeService[]).some((svc) => /running|up/i.test(svc.State || '')))
                            ? 'running'
                            : 'exited'
                        }
                        onAction={(action) => {
                          if (action === 'up') runAction(proj, 'up', t('项目启动成功'));
                          else if (action === 'down') {
                            setStopVolumes(false);
                            setStopTarget(proj);
                          } else if (action === 'restart') runAction(proj, 'restart', t('项目重启成功'));
                        }}
                        customActions={[
                          { key: 'up', label: t('启动'), disabled: !canManage || opName === proj.name },
                          { key: 'down', label: t('停止') },
                          { key: 'restart', label: t('重启'), disabled: !canManage || opName === proj.name },
                        ]}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={opName === proj.name}
                        disabled={!canManage}
                        onClick={() => runAction(proj, 'pull', t('镜像拉取成功'))}
                      >
                        {t('拉取镜像')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={opName === proj.name}
                        disabled={!canManage}
                        onClick={() => runAction(proj, 'build', t('镜像构建成功'))}
                      >
                        {t('构建镜像')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(proj)} disabled={!canManage}>
                        {t('编辑')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleViewConfig(proj)}
                      >
                        {t('配置')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openStructure(proj)}
                      >
                        {t('结构')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void openStats(proj.name)}>
                        {t('看板')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openLog(proj.name)}
                      >
                        {t('日志')}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => setDeleteTarget(proj)}
                        disabled={!canDelete}
                      >
                        {t('删除')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 新建项目弹窗 */}
      <Modal
        open={createOpen}
        title={t('新建 Compose 项目')}
        onClose={() => setCreateOpen(false)}
        width={640}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setCreateOpen(false);
                setCreateFileName('');
              }}
              disabled={creating}
            >
              {t('取消')}
            </Button>
            <Button onClick={handleCreate} loading={creating} disabled={!canManage}>
              {t('创建')}
            </Button>
          </>
        }
      >
        <Field label={t('项目名称')} required>
          <Input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder={t('例如：myapp')}
            autoFocus
          />
        </Field>
        <Field label="docker-compose.yml" required hint={t('可选内置模板，或选择文件上传、直接粘贴完整内容')}>
          <div className="compose-tpl">
            <Select
              value={createTemplate}
              onChange={(e) => handleTemplateChange(e.target.value)}
              className="compose-tpl__select"
            >
              <option value="">{t('空白')}</option>
              {COMPOSE_TEMPLATES.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
              {userTemplates.length > 0 && (
                <optgroup label={t('我的模板')}>
                  {userTemplates.map((tpl) => (
                    <option key={tpl.id} value={'tpl:' + tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
            {createTemplate && (
              <div className="compose-tpl__preview">
                {findTemplateByValue(createTemplate, userTemplates)?.description}
              </div>
            )}
          </div>
          <input
            type="file"
            accept=".yml,.yaml"
            onChange={(e) => handleUploadFile(e.target.files?.[0])}
            className="compose-upload"
          />
          <div style={{ marginTop: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => setRunImportOpen(true)}>
              {t('从 docker run 导入')}
            </Button>
          </div>
          {createFileName && (
            <div className="compose-upload__name" title={createFileName}>
              {t('已选择文件：')}{createFileName}
            </div>
          )}
          <YamlEditor
            value={createContent}
            onChange={(v) => {
              setCreateContent(v);
              if (createYamlErr.message) setCreateYamlErr({ message: '', line: null });
            }}
            placeholder={'version: "3"\nservices:\n  web:\n    image: nginx:latest'}
            rows={10}
            errorLine={createYamlErr.line}
            errorMessage={createYamlErr.message || undefined}
          />
        </Field>
      </Modal>

      {/* docker run → Compose 导入弹窗 */}
      <Modal
        open={runImportOpen}
        title={t('从 docker run 导入')}
        onClose={() => setRunImportOpen(false)}
        width={640}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRunImportOpen(false)}>
              {t('取消')}
            </Button>
            <Button onClick={handleRunConvert} loading={runImportLoading} disabled={!runImportCmd.trim()}>
              {t('转换为 Compose')}
            </Button>
            {runImportYaml && (
              <Button variant="primary" onClick={handleRunInsert}>
                {t('填入编辑器')}
              </Button>
            )}
          </>
        }
      >
        <Field label="docker run 命令" required hint={t('粘贴完整的 docker run 命令，自动映射端口 / 卷 / 环境变量 / 重启策略等常用选项')}>
          <textarea
            className="input"
            style={{ minHeight: 88, fontFamily: 'monospace' }}
            value={runImportCmd}
            onChange={(e) => setRunImportCmd(e.target.value)}
            placeholder={'docker run -d --name web -p 8080:80 -v /data:/data -e FOO=bar --restart always nginx:latest'}
          />
        </Field>
        {runImportErr && <div style={{ color: 'var(--danger, #e5484d)', marginTop: 8 }}>{runImportErr}</div>}
        {runImportWarnings.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {runImportWarnings.map((w, i) => (
              <div key={i} style={{ color: 'var(--warning, #f5a623)', fontSize: 12 }}>
                {t('提示：')}{w}
              </div>
            ))}
          </div>
        )}
        {runImportYaml && (
          <Field label="Compose 预览">
            <YamlEditor value={runImportYaml} onChange={() => {}} readOnly rows={10} />
          </Field>
        )}
      </Modal>

      <Modal
        open={editOpen}
        title={t('编辑 {{editName}} - docker-compose.yml', { editName })}
        onClose={closeEdit}
        width={720}
        fullscreen={editFull}
        onToggleFullscreen={() => setEditFull((f) => !f)}
        footer={
          <>
            {!editLoading && (
              <Button variant="ghost" onClick={openHistory} disabled={savingEdit}>
                {t('历史版本')}
              </Button>
            )}
            {!editLoading && (
              <Button
                variant="secondary"
                onClick={openSaveTemplate}
                disabled={savingEdit || !canManage}
              >
                {t('保存为模板')}
              </Button>
            )}
            <Button variant="secondary" onClick={closeEdit} disabled={savingEdit}>
              {t('取消')}
            </Button>
            <Button onClick={handleSaveEdit} loading={savingEdit} disabled={!canManage}>
              {t('保存')}
            </Button>
          </>
        }
      >
        {editLoading ? (
          <div className="log-empty">{t('正在加载 compose 文件…')}</div>
        ) : (
          <Field label="docker-compose.yml" required>
            <YamlEditor
              value={editContent}
              onChange={(v) => {
                setEditContent(v);
                if (editYamlErr.message) setEditYamlErr({ message: '', line: null });
              }}
              rows={editFull ? 40 : 18}
              errorLine={editYamlErr.line}
              errorMessage={editYamlErr.message || undefined}
            />
          </Field>
        )}
      </Modal>

      {/* 历史版本弹窗（1.52.0） */}
      <Modal
        open={histOpen}
        title={t('历史版本 - {{editName}}', { editName })}
        onClose={() => setHistOpen(false)}
        width={520}
      >
        {histLoading ? (
          <SkeletonRows rows={4} />
        ) : histItems.length === 0 ? (
          <Empty title={t('暂无历史版本记录')} description={t('每次保存前的上一版内容会自动记录（保留最近 20 条），可随时载入回退')} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('保存时间')}</th>
                <th>{t('保存人')}</th>
                <th style={{ width: 90 }}>{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {histItems.map((h) => (
                <tr key={h.id}>
                  <td className="mono">{new Date(h.createdAt).toLocaleString()}</td>
                  <td>{h.username || '—'}</td>
                  <td>
                    <Button variant="ghost" size="sm" onClick={() => loadHistoryVersion(h.id)} loading={histLoadingId === h.id}>
                      {t('载入')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      {/* 保存为模板弹窗 */}
      <Modal
        open={saveModalOpen}
        title={t('保存为模板')}
        onClose={() => setSaveModalOpen(false)}
        width={420}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setSaveModalOpen(false)}
              disabled={savingTemplate}
            >
              {t('取消')}
            </Button>
            <Button onClick={handleSaveTemplate} loading={savingTemplate} disabled={!canManage}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <Field label={t('模板名称')} required>
          <Input
            value={saveModalName}
            onChange={(e) => setSaveModalName(e.target.value)}
            placeholder={t('例如：WordPress')}
            autoFocus
          />
        </Field>
        <Field label={t('描述')}>
          <Input
            value={saveModalDesc}
            onChange={(e) => setSaveModalDesc(e.target.value)}
            placeholder={t('可选，记录模板用途')}
          />
        </Field>
      </Modal>

      {/* 查看配置弹窗 */}
      <Modal
        open={configOpen}
        title={t('{{configTitle}} - 配置', { configTitle })}
        onClose={() => setConfigOpen(false)}
        width={720}
        footer={
          <Button variant="secondary" onClick={() => setConfigOpen(false)}>
            {t('关闭')}
          </Button>
        }
      >
        <pre className="config-viewer">{configContent}</pre>
      </Modal>

      {/* 结构视图弹窗 */}
      <Modal
        open={structureOpen}
        title={structureData ? t('{{v1}} - 结构', { v1: structureData.name }) : t('Compose 结构')}
        onClose={closeStructure}
        width={760}
        footer={
          <Button variant="secondary" onClick={closeStructure} disabled={structureLoading}>
            {t('关闭')}
          </Button>
        }
      >
        {structureLoading ? (
          <div className="log-empty">{t('正在解析 Compose 结构…')}</div>
        ) : structureData ? (
          <div className="structure">
            <div className="structure__meta">
              <span>
                {t('项目：')}<b>{structureData.name}</b>
              </span>
              <span>
                {t('服务：')}<b>{structureData.services.length}</b>
              </span>
              {structureData.volumes.length > 0 && (
                <span>
                  {t('卷：')}<b>{structureData.volumes.join(', ') || '-'}</b>
                </span>
              )}
              {structureData.networks.length > 0 && (
                <span>
                  {t('网络：')}<b>{structureData.networks.join(', ') || '-'}</b>
                </span>
              )}
            </div>
            {structureData.services.length === 0 ? (
              <Empty title={t('暂无服务')} description={t('该 Compose 项目未定义任何服务')} />
            ) : (
              <div className="structure__list">
                {structureData.services.map((svc) => {
                  const isOp = serviceOpKey && serviceOpKey.startsWith(svc.name + '/');
                  return (
                    <div className="structure-card" key={svc.name}>
                      <div className="structure-card__head">
                        <span className="structure-card__name">{svc.name}</span>
                        <span className="structure-card__image" title={svc.image || ''}>
                          {svc.image || t('（build 构建）')}
                        </span>
                        <div className="structure-card__actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={serviceOpKey === `${svc.name}/start`}
                            disabled={!canManage || !!isOp}
                            onClick={() => runServiceAction(svc.name, 'start', t('{{v1}} 启动成功', { v1: svc.name }))}
                          >
                            {t('启动')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={serviceOpKey === `${svc.name}/stop`}
                            disabled={!canManage || !!isOp}
                            onClick={() => runServiceAction(svc.name, 'stop', t('{{v1}} 停止成功', { v1: svc.name }))}
                          >
                            {t('停止')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={serviceOpKey === `${svc.name}/restart`}
                            disabled={!canManage || !!isOp}
                            onClick={() => runServiceAction(svc.name, 'restart', t('{{v1}} 重启成功', { v1: svc.name }))}
                          >
                            {t('重启')}
                          </Button>
                        </div>
                      </div>
                      <div className="structure-card__body">
                        {svc.ports.length > 0 && (
                          <div className="structure-line">
                            <span className="structure-label">{t('端口')}</span>
                            <span className="structure-value">
                              {svc.ports
                                .map((p) =>
                                  p.published
                                    ? `${p.published}:${p.target}/${p.protocol}`
                                    : `${p.target}/${p.protocol}`
                                )
                                .join('，')}
                            </span>
                          </div>
                        )}
                        {svc.depends_on.length > 0 && (
                          <div className="structure-line">
                            <span className="structure-label">{t('依赖')}</span>
                            <span className="structure-value">{svc.depends_on.join('，')}</span>
                          </div>
                        )}
                        {svc.volumes.length > 0 && (
                          <div className="structure-line">
                            <span className="structure-label">{t('卷')}</span>
                            <span className="structure-value">
                              {svc.volumes
                                .map((v) => `${v.source || ''} -> ${v.target}${v.readOnly ? t(' (只读)') : ''}`.replace(/^\s+->/, ''))
                                .join('，')}
                            </span>
                          </div>
                        )}
                        {svc.environment.length > 0 && (
                          <div className="structure-line">
                            <span className="structure-label">{t('环境')}</span>
                            <span className="structure-value">{svc.environment.join('，')}</span>
                          </div>
                        )}
                        {svc.ports.length === 0 &&
                          svc.depends_on.length === 0 &&
                          svc.volumes.length === 0 &&
                          svc.environment.length === 0 && (
                            <div className="structure-line">
                              <span className="structure-value">{t('（无额外配置）')}</span>
                            </div>
                          )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      {/* 日志弹窗 */}
      <Modal
        open={logOpen}
        title={t('{{logName}} - 日志', { logName })}
        onClose={closeLog}
        width={760}
        footer={
          <>
            <Button variant="secondary" onClick={refreshLog} loading={logLoading}>
              {t('刷新')}
            </Button>
            <Button variant="secondary" onClick={closeLog}>
              {t('关闭')}
            </Button>
          </>
        }
      >
        {logLoading && !logContent ? (
          <div className="log-empty">{t('正在拉取日志…')}</div>
        ) : (
          <pre className="log-viewer">{logContent || t('（暂无日志）')}</pre>
        )}
      </Modal>

      {/* 停止（down）确认弹窗：可选择是否同时删除数据卷 */}
      <Modal
        open={!!stopTarget}
        title={t('停止项目')}
        onClose={() => setStopTarget(null)}
        width={420}
        footer={
          <>
            <Button variant="secondary" onClick={() => setStopTarget(null)} disabled={stopping}>
              {t('取消')}
            </Button>
            <Button onClick={handleStopConfirm} loading={stopping} disabled={!canManage}>
              {t('停止')}
            </Button>
          </>
        }
      >
        <div className="compose-confirm">
          <p>{t('确定要停止 Compose 项目 "{{name}}" 吗？', { name: stopTarget?.name || '' })}</p>
          <label className="compose-confirm__check">
            <input
              type="checkbox"
              checked={stopVolumes}
              onChange={(e) => setStopVolumes(e.target.checked)}
            />
            <span>{t('同时删除该项目的数据卷（volumes）')}</span>
          </label>
        </div>
      </Modal>

      {/* 删除项目确认框：可选择是否同时删除数据卷 */}
      <Modal
        open={!!deleteTarget}
        title={t('删除项目')}
        onClose={() => setDeleteTarget(null)}
        width={420}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteVolumes(false);
              }}
              disabled={deleting}
            >
              {t('取消')}
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={deleting} disabled={!canDelete}>
              {t('删除')}
            </Button>
          </>
        }
      >
        <div className="compose-confirm">
          <p>{t('确定要删除 Compose 项目 "{{name}}" 吗？此操作不可恢复。', { name: deleteTarget?.name || '' })}</p>
          <label className="compose-confirm__check">
            <input
              type="checkbox"
              checked={deleteVolumes}
              onChange={(e) => setDeleteVolumes(e.target.checked)}
            />
            <span>{t('同时删除该项目的数据卷（volumes）')}</span>
          </label>
        </div>
      </Modal>

      {/* 项目资源看板（1.34.0）：按服务聚合 CPU / 内存 / 网络 / IO + 服务级滚动更新 */}
      <Modal open={statsOpen} title={t('项目资源看板 · {{name}}', { name: statsName })} onClose={() => setStatsOpen(false)} width={860}>
        {statsLoading ? (
          <SkeletonRows rows={4} />
        ) : !statsData || statsData.length === 0 ? (
          <Empty title={t('该项目暂无运行中的容器')} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('服务')}</th>
                <th>{t('容器数')}</th>
                <th>CPU</th>
                <th>{t('内存')}</th>
                <th>{t('网络 RX/TX')}</th>
                <th>{t('磁盘读/写')}</th>
                <th className="col-actions">{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {statsData.map((s) => (
                <tr key={s.name}>
                  <td className="col-name">{s.name}</td>
                  <td>{s.containers}</td>
                  <td>{s.cpuPercent.toFixed(2)}%</td>
                  <td>{formatBytesShort(s.memUsage)}{s.memLimit > 0 ? ` / ${formatBytesShort(s.memLimit)}` : ''}</td>
                  <td>{formatBytesShort(s.netRx)} / {formatBytesShort(s.netTx)}</td>
                  <td>{formatBytesShort(s.ioR)} / {formatBytesShort(s.ioW)}</td>
                  <td className="col-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={rollingSvc === s.name}
                      disabled={!canManage}
                      onClick={() => void rollingUpdate(statsName, s.name)}
                    >
                      {t('滚动更新')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button
            variant="secondary"
            size="sm"
            loading={rollingAllRunning}
            disabled={!canManage || !statsData || statsData.length === 0}
            onClick={() => void rollingUpdateAll()}
          >
            {t('全部滚动更新')}
          </Button>
          <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => { setDriftResult(null); setDriftOpen(true); }}>
            {t('漂移检测')}
          </Button>
          <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => setDistOpen(true)}>
            {t('分发镜像到其他引擎')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void openStats(statsName)}>
            {t('刷新')}
          </Button>
        </div>
      </Modal>

      {/* 跨引擎镜像分发（1.34.0） */}
      <Modal open={distOpen} title={t('分发镜像 · {{name}}', { name: statsName })} onClose={() => setDistOpen(false)} width={520}>
        <Field label={t('远端引擎地址（每行一个，如 tcp://192.168.1.10:2375）')}>
          <textarea
            className="input compose-distribute__engines"
            rows={4}
            value={distEngines}
            onChange={(e) => setDistEngines(e.target.value)}
            placeholder={engineHints.length > 0 ? engineHints.join('\n') : 'tcp://192.168.1.10:2375'}
          />
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '4px 0 8px', cursor: 'pointer' }}>
          <input type="checkbox" checked={distDeploy} onChange={(e) => setDistDeploy(e.target.checked)} />
          {t('分发后在远端启动（代理部署）')}
        </label>
        <p style={{ fontSize: 12, opacity: 0.65 }}>
          {t('将把该项目的全部服务镜像预拉取到所选引擎（作为远端代理部署的前置步骤），完成后远端启动即刻可用。')}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Button variant="secondary" onClick={() => setDistOpen(false)}>
            {t('取消')}
          </Button>
          <Button variant="primary" loading={distRunning} onClick={() => void distribute()}>
            {t('开始分发')}
          </Button>
        </div>
      </Modal>

      {/* 远端配置漂移检测（1.37.0） */}
      <Modal open={driftOpen} title={t('漂移检测 · {{name}}', { name: statsName })} onClose={() => setDriftOpen(false)} width={720}>
        <Field label={t('目标引擎地址（留空 = 本地引擎，如 tcp://192.168.1.10:2375）')}>
          <input
            className="input"
            value={driftEngine}
            onChange={(e) => setDriftEngine(e.target.value)}
            placeholder={engineHints.length > 0 ? engineHints[0] : 'tcp://192.168.1.10:2375'}
          />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Button variant="primary" loading={driftRunning} onClick={() => void driftCheck()}>
            {t('开始检测')}
          </Button>
        </div>
        {driftResult && driftResult.driftCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <Button variant="secondary" loading={fixRunning} onClick={() => void fixDrift()}>
              {t('一键修复（按本地配置重建）')}
            </Button>
          </div>
        )}        {driftResult && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: 13, margin: '4px 0 8px' }}>
              {driftResult.driftCount === 0
                ? t('全部服务与本地配置一致，未检测到漂移')
                : t('检测到 {{n}} 个服务存在差异', { n: driftResult.driftCount })}
            </p>
            {driftResult.services.length === 0 ? (
              <Empty title={t('目标引擎上未发现该项目的容器')} />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('修复')}</th>
                    <th>{t('服务')}</th>
                    <th>{t('状态')}</th>
                    <th>{t('差异项')}</th>
                  </tr>
                </thead>
                <tbody>
                  {driftResult.services.map((s) => (
                    <tr key={s.service}>
                      <td>
                        {s.status === 'drift' || s.status === 'localOnly' ? (
                          <input
                            type="checkbox"
                            checked={!!fixSel[s.service]}
                            onChange={(e) => setFixSel((prev) => ({ ...prev, [s.service]: e.target.checked }))}
                          />
                        ) : s.status === 'remoteOnly' ? (
                          <input
                            type="checkbox"
                            title={t('删除远端上该服务的容器')}
                            checked={!!fixSelRemove[s.service]}
                            onChange={(e) => setFixSelRemove((prev) => ({ ...prev, [s.service]: e.target.checked }))}
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="col-name">{s.service}</td>
                      <td>
                        {s.status === 'match'
                          ? t('一致')
                          : s.status === 'drift'
                            ? t('漂移')
                            : s.status === 'localOnly'
                              ? t('远端缺失')
                              : t('本地缺失')}
                      </td>
                      <td>{s.diffs.join(', ') || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
