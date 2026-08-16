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
import { Field, Input, Select, TextArea } from '../components/Form';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, del } from '../api/client';
import { isAdmin } from '../api/auth';
import { ComposeProject, ComposeService, ComposeTemplate } from '../types';
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
    description: 'WordPress + MySQL 博客站点',
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
    name: 'Nginx 静态站',
    description: 'Nginx 静态网站托管',
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
    description: 'Redis 缓存服务（含密码）',
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
    description: 'PostgreSQL 数据库服务',
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
    name: 'Node.js 应用',
    description: 'Node.js 应用 + 构建后运行',
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

/**
 * Compose 项目管理页组件
 */
export default function ComposePage() {
  const { showToast } = useToast();
  const canManage = isAdmin();
  const canDelete = isAdmin();
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
  // 上传的 compose 文件名（用于界面展示）
  const [createFileName, setCreateFileName] = useState('');
  // 新建弹窗当前选择的模板 id（'' 表示空白）
  const [createTemplate, setCreateTemplate] = useState('');
  const [creating, setCreating] = useState(false);

  // 编辑项目弹窗状态
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // 用户保存的 Compose 模板（来自 /api/compose-templates，用于"从模板新建"下拉）
  const [userTemplates, setUserTemplates] = useState<ComposeTemplate[]>([]);
  // 保存为模板弹窗状态
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveModalName, setSaveModalName] = useState('');
  const [saveModalDesc, setSaveModalDesc] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  // 停止（down）确认弹窗状态：记录目标项目与是否删除数据卷
  const [stopTarget, setStopTarget] = useState<ComposeProject | null>(null);
  const [stopVolumes, setStopVolumes] = useState(false);
  const [stopping, setStopping] = useState(false);

  // 查看配置弹窗状态
  const [configOpen, setConfigOpen] = useState(false);
  const [configTitle, setConfigTitle] = useState('');
  const [configContent, setConfigContent] = useState('');

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
        showToast('仅管理员可操作 Compose 项目', 'error');
        return;
      }
      const name = project.name;
      setOpName(name);
      try {
        await post(projectUrl(name) + '/' + action, body);
        showToast(successMsg);
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || successMsg.replace('成功', '失败'), 'error');
      } finally {
        setOpName(null);
      }
    },
    [canManage, showToast]
  );

  /** 解析并设置项目操作中的名称（项目名可能含特殊字符，需编码） */
  const projectUrl = (name: string): string => '/api/compose/' + encodeURIComponent(name);

  /**
   * 拉取单个项目的服务运行状态（compose ps）
   * @param name 项目名
   */
  const loadStatus = useCallback(
    async (name: string) => {
      try {
        const data = await get<ComposeService[]>(projectUrl(name));
        setStatusMap((prev) => ({ ...prev, [name]: data || [] }));
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
      setLoadError(e?.message || '拉取项目列表失败');
      showToast(e?.message || '拉取项目列表失败', 'error');
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
        showToast('读取文件失败', 'error');
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
      showToast('内容为空，暂无法保存为模板', 'error');
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
      showToast('仅管理员可保存模板', 'error');
      setSaveModalOpen(false);
      return;
    }
    const name = saveModalName.trim();
    if (!name) {
      showToast('请输入模板名称', 'error');
      return;
    }
    if (!editContent.trim()) {
      showToast('内容为空，暂无法保存为模板', 'error');
      return;
    }
    setSavingTemplate(true);
    try {
      await post('/api/compose-templates', {
        name,
        description: saveModalDesc.trim(),
        content: editContent,
      });
      showToast('模板保存成功');
      setSaveModalOpen(false);
      setSaveModalName('');
      setSaveModalDesc('');
      // 重新拉取模板列表，使新模板立即出现在"从模板新建"下拉
      fetchUserTemplates();
    } catch (e: any) {
      showToast(e?.message || '模板保存失败', 'error');
    } finally {
      setSavingTemplate(false);
    }
  }, [canManage, saveModalName, saveModalDesc, editContent, showToast, fetchUserTemplates]);

  /** 新建 Compose 项目 */
  const handleCreate = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可新建 Compose 项目', 'error');
      setCreateOpen(false);
      return;
    }
    const name = createName.trim();
    if (!name) {
      showToast('请输入项目名称', 'error');
      return;
    }
    if (!createContent.trim()) {
      showToast('请输入 docker-compose.yml 内容', 'error');
      return;
    }
    setCreating(true);
    try {
      await post('/api/compose', { name, content: createContent });
      showToast('项目创建成功');
      setCreateOpen(false);
      setCreateName('');
      setCreateContent('');
      setCreateFileName('');
      setCreateTemplate('');
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '项目创建失败', 'error');
    } finally {
      setCreating(false);
    }
  }, [canManage, createName, createContent, showToast]);

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
        setConfigContent(content || '（无配置文件）');
        setConfigOpen(true);
      } catch (e: any) {
        showToast(e?.message || '获取配置失败', 'error');
      }
    },
    [showToast]
  );

  /** 删除项目（根据 deleteVolumes 决定是否同时删除数据卷） */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canDelete) {
      showToast('仅管理员可删除 Compose 项目', 'error');
      setDeleteTarget(null);
      setDeleteVolumes(false);
      return;
    }
    setDeleting(true);
    try {
      await del(projectUrl(deleteTarget.name), { volumes: deleteVolumes });
      showToast('项目删除成功');
      setDeleteTarget(null);
      setDeleteVolumes(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '项目删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canDelete, deleteTarget, deleteVolumes, showToast]);

  /** 打开编辑弹窗并加载指定项目的 compose 文件内容 */
  const openEdit = useCallback(
    async (project: ComposeProject) => {
      if (!canManage) {
        showToast('仅管理员可编辑 Compose 项目', 'error');
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
        showToast(e?.message || '获取 compose 文件失败', 'error');
      } finally {
        setEditLoading(false);
      }
    },
    [canManage, showToast]
  );

  /** 保存编辑后的 compose 文件（复用 POST /api/compose 同名覆盖端点） */
  const handleSaveEdit = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可编辑 Compose 项目', 'error');
      setEditOpen(false);
      return;
    }
    const name = editName.trim();
    if (!name) {
      showToast('项目名称无效', 'error');
      return;
    }
    if (!editContent.trim()) {
      showToast('请输入 docker-compose.yml 内容', 'error');
      return;
    }
    setSavingEdit(true);
    try {
      await post('/api/compose', { name, content: editContent });
      showToast('项目修改已保存');
      setEditOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    } finally {
      setSavingEdit(false);
    }
  }, [canManage, editName, editContent, showToast]);

  /** 关闭编辑弹窗 */
  const closeEdit = useCallback(() => {
    setEditOpen(false);
    setEditName('');
    setEditContent('');
  }, []);

  /** 执行停止（down）操作，带删卷选择 */
  const handleStopConfirm = useCallback(async () => {
    if (!stopTarget) return;
    if (!canManage) {
      showToast('仅管理员可停止 Compose 项目', 'error');
      setStopTarget(null);
      return;
    }
    setStopping(true);
    try {
      await post(projectUrl(stopTarget.name) + '/down', { volumes: stopVolumes });
      showToast(stopVolumes ? '项目已停止，数据卷已删除' : '项目已停止');
      setStopTarget(null);
      setStopVolumes(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '停止项目失败', 'error');
      setStopping(false);
      return;
    }
    setStopping(false);
  }, [canManage, stopTarget, stopVolumes, showToast]);

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
        showToast(e?.message || '获取日志失败', 'error');
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
      showToast(e?.message || '刷新日志失败', 'error');
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
        title="Compose 项目"
        extra={
          <div className="toolbar">
            <Button variant="secondary" onClick={() => setRefreshKey((k) => k + 1)}>
              刷新
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
              新建项目
            </Button>
          </div>
        }
      >
        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="拉取项目列表失败"
            description={loadError || '请检查 Docker 引擎连接后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={fetchProjects}>
                重试
              </Button>
            }
          />
        ) : projects.length === 0 ? (
          <Empty title="暂无 Compose 项目" description="点击右上角「新建项目」创建" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>项目名</th>
                <th>状态</th>
                <th>Compose 文件</th>
                <th>路径</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((proj) => (
                <tr key={proj.name}>
                  <td className="col-name">
                    <div className="name-main" title={proj.name}>
                      {proj.name}
                    </div>
                    {proj.hasCompose ? (
                      <div className="name-sub badge badge--running">已配置</div>
                    ) : (
                      <div className="name-sub badge badge--muted">未配置</div>
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
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={opName === proj.name}
                        disabled={!canManage}
                        onClick={() => runAction(proj, 'up', '项目启动成功')}
                      >
                        启动
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canManage}
                        onClick={() => {
                          setStopVolumes(false);
                          setStopTarget(proj);
                        }}
                      >
                        停止
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={opName === proj.name}
                        disabled={!canManage}
                        onClick={() => runAction(proj, 'restart', '项目重启成功')}
                      >
                        重启
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={opName === proj.name}
                        disabled={!canManage}
                        onClick={() => runAction(proj, 'pull', '镜像拉取成功')}
                      >
                        拉取镜像
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={opName === proj.name}
                        disabled={!canManage}
                        onClick={() => runAction(proj, 'build', '镜像构建成功')}
                      >
                        构建镜像
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(proj)} disabled={!canManage}>
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleViewConfig(proj)}
                      >
                        配置
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openLog(proj.name)}
                      >
                        日志
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => setDeleteTarget(proj)}
                        disabled={!canDelete}
                      >
                        删除
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
        title="新建 Compose 项目"
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
              取消
            </Button>
            <Button onClick={handleCreate} loading={creating} disabled={!canManage}>
              创建
            </Button>
          </>
        }
      >
        <Field label="项目名称" required>
          <Input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="例如：myapp"
            autoFocus
          />
        </Field>
        <Field label="docker-compose.yml" required hint="可选内置模板，或选择文件上传、直接粘贴完整内容">
          <div className="compose-tpl">
            <Select
              value={createTemplate}
              onChange={(e) => handleTemplateChange(e.target.value)}
              className="compose-tpl__select"
            >
              <option value="">空白</option>
              {COMPOSE_TEMPLATES.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
              {userTemplates.length > 0 && (
                <optgroup label="我的模板">
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
          {createFileName && (
            <div className="compose-upload__name" title={createFileName}>
              已选择文件：{createFileName}
            </div>
          )}
          <TextArea
            value={createContent}
            onChange={(e) => setCreateContent(e.target.value)}
            placeholder={'version: "3"\nservices:\n  web:\n    image: nginx:latest'}
            rows={10}
            className="compose-editor"
          />
        </Field>
      </Modal>

      {/* 编辑项目弹窗 */}
      <Modal
        open={editOpen}
        title={`编辑 ${editName} - docker-compose.yml`}
        onClose={closeEdit}
        width={720}
        footer={
          <>
            {!editLoading && (
              <Button
                variant="secondary"
                onClick={openSaveTemplate}
                disabled={savingEdit || !canManage}
              >
                保存为模板
              </Button>
            )}
            <Button variant="secondary" onClick={closeEdit} disabled={savingEdit}>
              取消
            </Button>
            <Button onClick={handleSaveEdit} loading={savingEdit} disabled={!canManage}>
              保存
            </Button>
          </>
        }
      >
        {editLoading ? (
          <div className="log-empty">正在加载 compose 文件…</div>
        ) : (
          <Field label="docker-compose.yml" required>
            <TextArea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={18}
              className="compose-editor"
            />
          </Field>
        )}
      </Modal>

      {/* 保存为模板弹窗 */}
      <Modal
        open={saveModalOpen}
        title="保存为模板"
        onClose={() => setSaveModalOpen(false)}
        width={420}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setSaveModalOpen(false)}
              disabled={savingTemplate}
            >
              取消
            </Button>
            <Button onClick={handleSaveTemplate} loading={savingTemplate} disabled={!canManage}>
              保存
            </Button>
          </>
        }
      >
        <Field label="模板名称" required>
          <Input
            value={saveModalName}
            onChange={(e) => setSaveModalName(e.target.value)}
            placeholder="例如：WordPress"
            autoFocus
          />
        </Field>
        <Field label="描述">
          <Input
            value={saveModalDesc}
            onChange={(e) => setSaveModalDesc(e.target.value)}
            placeholder="可选，记录模板用途"
          />
        </Field>
      </Modal>

      {/* 查看配置弹窗 */}
      <Modal
        open={configOpen}
        title={`${configTitle} - 配置`}
        onClose={() => setConfigOpen(false)}
        width={720}
        footer={
          <Button variant="secondary" onClick={() => setConfigOpen(false)}>
            关闭
          </Button>
        }
      >
        <pre className="config-viewer">{configContent}</pre>
      </Modal>

      {/* 日志弹窗 */}
      <Modal
        open={logOpen}
        title={`${logName} - 日志`}
        onClose={closeLog}
        width={760}
        footer={
          <>
            <Button variant="secondary" onClick={refreshLog} loading={logLoading}>
              刷新
            </Button>
            <Button variant="secondary" onClick={closeLog}>
              关闭
            </Button>
          </>
        }
      >
        {logLoading && !logContent ? (
          <div className="log-empty">正在拉取日志…</div>
        ) : (
          <pre className="log-viewer">{logContent || '（暂无日志）'}</pre>
        )}
      </Modal>

      {/* 停止（down）确认弹窗：可选择是否同时删除数据卷 */}
      <Modal
        open={!!stopTarget}
        title="停止项目"
        onClose={() => setStopTarget(null)}
        width={420}
        footer={
          <>
            <Button variant="secondary" onClick={() => setStopTarget(null)} disabled={stopping}>
              取消
            </Button>
            <Button onClick={handleStopConfirm} loading={stopping} disabled={!canManage}>
              停止
            </Button>
          </>
        }
      >
        <div className="compose-confirm">
          <p>确定要停止 Compose 项目 "{stopTarget?.name}" 吗？</p>
          <label className="compose-confirm__check">
            <input
              type="checkbox"
              checked={stopVolumes}
              onChange={(e) => setStopVolumes(e.target.checked)}
            />
            <span>同时删除该项目的数据卷（volumes）</span>
          </label>
        </div>
      </Modal>

      {/* 删除项目确认框：可选择是否同时删除数据卷 */}
      <Modal
        open={!!deleteTarget}
        title="删除项目"
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
              取消
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={deleting} disabled={!canDelete}>
              删除
            </Button>
          </>
        }
      >
        <div className="compose-confirm">
          <p>确定要删除 Compose 项目 "{deleteTarget?.name}" 吗？此操作不可恢复。</p>
          <label className="compose-confirm__check">
            <input
              type="checkbox"
              checked={deleteVolumes}
              onChange={(e) => setDeleteVolumes(e.target.checked)}
            />
            <span>同时删除该项目的数据卷（volumes）</span>
          </label>
        </div>
      </Modal>
    </div>
  );
}
