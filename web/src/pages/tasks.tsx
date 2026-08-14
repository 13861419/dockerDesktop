/**
 * 计划任务页
 *
 * 以表格展示所有计划任务（prune / backup / pull / composeUp / composeDown），
 * 支持新建、编辑、启停、立即执行、删除，以及查看每次执行的历史记录。
 *
 * 注意：client.ts 只封装了 get / post / del，并未提供 put 方法；
 * 而后端更新任务接口为 PUT /api/tasks/:id，因此本页在此
 * 用原生 fetch 携带鉴权 token 封装一个局部的 put 调用，仅用于更新任务。
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
import { get, post, del, download } from '../api/client';
import { getToken, isAdmin } from '../api/auth';
import {
  CronTask,
  CronTaskListResponse,
  CronTaskLogPage,
  CronTaskLogItem,
  TaskType,
} from '../types';
import './tasks.less';

/** 任务类型中文映射与徽标色，key 与后端 type 字段一致 */
const TYPE_OPTIONS: Array<{ value: TaskType; label: string; badge: string }> = [
  { value: 'prune', label: '清理', badge: 'cyan' },
  { value: 'backup', label: '备份', badge: 'blue' },
  { value: 'pull', label: '拉取镜像', badge: 'purple' },
  { value: 'composeUp', label: '拉起 compose', badge: 'green' },
  { value: 'composeDown', label: '停止 compose', badge: 'orange' },
];

/** cron 表达式快捷预设：说明 + 表达式 */
const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: '每小时', cron: '0 * * * *' },
  { label: '每天凌晨 3 点', cron: '0 3 * * *' },
  { label: '每周日 2 点', cron: '0 2 * * 0' },
];

/** 新增任务弹窗默认的 cron 表达式 */
const DEFAULT_CRON = '0 3 * * *';

/** prune（清理）类型的可勾选项，key 与后端 config 字段一致 */
const PRUNE_ITEMS: Array<{ key: string; label: string }> = [
  { key: 'images', label: '未使用的镜像' },
  { key: 'containers', label: '已停止的容器' },
  { key: 'volumes', label: '未使用的数据卷' },
  { key: 'networks', label: '未使用的网络' },
  { key: 'buildCache', label: 'Build Cache' },
];

/** 备份目标选项（radio） */
const BACKUP_TARGETS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'database', label: '面板数据库', hint: '备份本面板自身的 SQLite 数据库' },
  { value: 'volumes', label: '命名卷', hint: '备份指定 Docker 命名卷' },
];

/** 将毫秒时间戳格式化为可读时间 */
function formatTime(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '-';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 简单的 5 段 cron 表达式客户端校验（分钟/小时/日/月/星期）
 * 只做段数与非空校验，真正的合法性由后端 cron-parser 判定。
 * @param cron 用户输入的 cron 表达式
 * @returns 是否满足 5 段格式
 */
function isValidCron(cron: string): boolean {
  const parts = (cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => p.length > 0);
}

/**
 * 局部封装的 PUT 请求：client.ts 未提供 put，
 * 此处用原生 fetch 携带鉴权 token 调用 PUT /api/tasks/:id。
 * @param url 接口路径（以 /api 开头）
 * @param body 要提交的 JSON 对象
 */
async function put(url: string, body?: any): Promise<any> {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接后端服务，请确认服务已启动');
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message = data?.error || data?.message || `请求失败 (${res.status})`;
    throw new Error(message);
  }
  return data;
}

/**
 * 计划任务页组件
 */
export default function TasksPage() {
  const { showToast } = useToast();
  const canDelete = isAdmin();
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  // 新增/编辑弹窗：null=关闭，task=编辑（新建时 null+open 打开）
  const [editing, setEditing] = useState<CronTask | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // 待删除任务（用于二次确认）
  const [deleteTarget, setDeleteTarget] = useState<CronTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 正在执行「立即执行」的任务 id
  const [runId, setRunId] = useState<string | null>(null);
  // 执行历史弹窗所属任务
  const [logsTarget, setLogsTarget] = useState<CronTask | null>(null);

  // 新建弹窗的编辑值
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<TaskType>('prune');
  const [formCron, setFormCron] = useState(DEFAULT_CRON);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formConfig, setFormConfig] = useState<Record<string, any>>({});

  // 执行历史分页状态
  const [logsItems, setLogsItems] = useState<CronTaskLogItem[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize] = useState(10);
  const [logsTotalPages, setLogsTotalPages] = useState(1);
  const [logsLoading, setLogsLoading] = useState(false);

  /**
   * 拉取任务列表（同时取得 Compose 项目名）
   */
  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<CronTaskListResponse>('/api/tasks');
      setTasks(data?.tasks || []);
      setProjects(data?.projects || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || '拉取计划任务失败');
      showToast(e?.message || '拉取计划任务失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks, refreshKey]);

  /**
   * 打开「新建任务」弹窗：重置表单为默认值
   */
  const openCreate = useCallback(() => {
    setEditing(null);
    setFormName('');
    setFormType('prune');
    setFormCron(DEFAULT_CRON);
    setFormEnabled(true);
    // prune 默认全选
    setFormConfig({
      images: true,
      containers: true,
      volumes: true,
      networks: true,
      buildCache: true,
    });
    setFormOpen(true);
  }, []);

  /**
   * 打开「编辑任务」弹窗：用目标任务回填表单
   * @param task 要编辑的任务
   */
  const openEdit = useCallback((task: CronTask) => {
    setEditing(task);
    setFormName(task.name);
    setFormType(task.type);
    setFormCron(task.cron);
    setFormEnabled(task.enabled);
    // 深拷贝 config，避免直接修改原任务对象
    setFormConfig(JSON.parse(JSON.stringify(task.config || {})));
    setFormOpen(true);
  }, []);

  /**
   * 提交新建/编辑：新建用 post，编辑用本地 put
   */
  const handleSave = useCallback(async () => {
    if (!formName.trim()) {
      showToast('请填写任务名称', 'error');
      return;
    }
    if (!isValidCron(formCron)) {
      showToast('cron 表达式格式不正确（应为空格分隔的 5 段）', 'error');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        // 更新任务（后端 PUT），仅更新允许修改的字段
        await put(`/api/tasks/${editing.id}`, {
          name: formName.trim(),
          cron: formCron.trim(),
          enabled: formEnabled,
          config: formConfig,
        });
        showToast('任务已更新', 'success');
      } else {
        // 新建任务
        await post('/api/tasks', {
          name: formName.trim(),
          type: formType,
          cron: formCron.trim(),
          enabled: formEnabled,
          config: formConfig,
        });
        showToast('任务已创建', 'success');
      }
      setFormOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || (editing ? '更新任务失败' : '创建任务失败'), 'error');
    } finally {
      setSaving(false);
    }
  }, [editing, formName, formType, formCron, formEnabled, formConfig, showToast]);

  /**
   * 切换任务的启用/停用状态
   * @param task 目标任务
   */
  const handleToggle = useCallback(
    async (task: CronTask) => {
      const next = !task.enabled;
      try {
        await post(`/api/tasks/${task.id}/enable`, { enabled: next });
        showToast(next ? '任务已启用' : '任务已停用');
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || '更新启用状态失败', 'error');
      }
    },
    [showToast]
  );

  /**
   * 立即执行任务，成功后提示返回的 detail
   * @param task 目标任务
   */
  const handleRun = useCallback(
    async (task: CronTask) => {
      setRunId(task.id);
      try {
        const data = await post<{ ok: boolean; detail?: string }>(`/api/tasks/${task.id}/run`);
        if (data?.ok) {
          showToast(data?.detail || '任务执行成功');
        } else {
          showToast(data?.detail || '任务执行失败', 'error');
        }
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || '立即执行失败', 'error');
      } finally {
        setRunId(null);
      }
    },
    [showToast]
  );

  /**
   * 删除任务（经确认框调用）
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canDelete) {
      showToast('仅管理员可删除任务', 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/tasks/${deleteTarget.id}`);
      showToast('任务已删除', 'success');
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '删除任务失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canDelete, deleteTarget, showToast]);

  /**
   * 拉取某任务的分页执行历史
   * @param task 目标任务
   * @param page 页码
   */
  const loadLogs = useCallback(
    async (task: CronTask, page: number) => {
      setLogsLoading(true);
      try {
        const data = await get<CronTaskLogPage>('/api/tasks/logs', {
          taskId: task.id,
          page,
          pageSize: logsPageSize,
        });
        setLogsItems(data?.items || []);
        setLogsTotal(data?.total || 0);
        setLogsPage(data?.page || page);
        setLogsTotalPages(data?.totalPages || 1);
      } catch (e: any) {
        showToast(e?.message || '加载执行历史失败', 'error');
      } finally {
        setLogsLoading(false);
      }
    },
    [logsPageSize, showToast]
  );

  /**
   * 打开执行历史弹窗并加载第一页
   * @param task 目标任务
   */
  const openLogs = useCallback(
    (task: CronTask) => {
      setLogsTarget(task);
      loadLogs(task, 1);
    },
    [loadLogs]
  );

  /**
   * 导出当前任务的执行历史为 CSV（后端接口已带 UTF-8 BOM，避免 Excel 中文乱码）
   * @param task 目标任务
   */
  const handleExportLogs = useCallback(
    async (task: CronTask) => {
      try {
        await download(`/api/tasks/logs/export?taskId=${encodeURIComponent(task.id)}`, 'cron-task-logs.csv');
      } catch (e: any) {
        showToast(e?.message || '导出执行历史失败', 'error');
      }
    },
    [showToast]
  );

  /** 类型选项 → 中文标签 */
  const typeLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of TYPE_OPTIONS) m[t.value] = t.label;
    return m;
  }, []);

  /** 类型选项 → 徽标色 */
  const typeBadge = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of TYPE_OPTIONS) m[t.value] = t.badge;
    return m;
  }, []);

  /** 日志弹窗安全页码 */
  const logsSafePage = Math.min(logsPage, logsTotalPages);
  const logsPageStart = logsTotal === 0 ? 0 : (logsSafePage - 1) * logsPageSize + 1;
  const logsPageEnd = Math.min(logsSafePage * logsPageSize, logsTotal);

  return (
    <div className="tasks-page">
      <h1 className="tasks-page__title">计划任务</h1>

      <Card>
        <div className="tasks__toolbar">
          <div className="tasks__toolbar-left">
            <span className="tasks__total">共 {tasks.length} 个任务</span>
          </div>
          <div className="tasks__toolbar-right">
            <Button variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
              刷新
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate}>
              + 新建任务
            </Button>
          </div>
        </div>

        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="拉取计划任务失败"
            description={loadError || '请稍后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={fetchTasks}>
                重试
              </Button>
            }
          />
        ) : tasks.length === 0 ? (
          <Empty
            title="暂无计划任务"
            description="点击「新建任务」创建定时任务，可自动清理、备份或拉取镜像"
          />
        ) : (
          <table className="tasks__table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>cron 表达式</th>
                <th>启用</th>
                <th>下次执行</th>
                <th>上次执行</th>
                <th>上次结果</th>
                <th className="tasks__cell-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td className="tasks__cell-name" title={task.name}>
                    {task.name}
                  </td>
                  <td>
                    <span
                      className={`tasks__type-badge tasks__type-badge--${typeBadge[task.type] || 'grey'}`}
                    >
                      {typeLabel[task.type] || task.type}
                    </span>
                  </td>
                  <td className="tasks__cell-mono">{task.cron}</td>
                  <td>
                    <label className="tasks__switch">
                      <input
                        type="checkbox"
                        checked={task.enabled}
                        onChange={() => handleToggle(task)}
                      />
                      <span className="tasks__switch-slider" />
                    </label>
                  </td>
                  <td className="tasks__cell-time">{formatTime(task.nextRunAt)}</td>
                  <td className="tasks__cell-time">{formatTime(task.lastRunAt)}</td>
                  <td>
                    {task.lastRunAt && task.lastStatus !== null ? (
                      task.lastStatus === 0 ? (
                        <span className="tasks__result tasks__result--ok">成功</span>
                      ) : (
                        <span className="tasks__result tasks__result--fail">失败</span>
                      )
                    ) : (
                      <span className="tasks__result tasks__result--none">未执行</span>
                    )}
                  </td>
                  <td className="tasks__cell-actions">
                    <Button variant="ghost" size="sm" onClick={() => openLogs(task)}>
                      日志
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={runId === task.id}
                      disabled={!!runId}
                      onClick={() => handleRun(task)}
                    >
                      立即执行
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => openEdit(task)}>
                      编辑
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setDeleteTarget(task)} disabled={!canDelete}>
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 新建/编辑任务弹窗 */}
      <Modal
        open={formOpen}
        title={editing ? `编辑任务「${editing.name}」` : '新建任务'}
        onClose={() => !saving && setFormOpen(false)}
        width={560}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setFormOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={saving} onClick={handleSave}>
              {editing ? '保存修改' : '创建任务'}
            </Button>
          </>
        }
      >
        <div className="tasks__form">
          <Field label="任务名称" required>
            <Input
              value={formName}
              placeholder="如：每周清理未使用镜像"
              onChange={(e) => setFormName(e.target.value)}
            />
          </Field>

          <Field label="任务类型">
            <Select value={formType} onChange={(e) => setFormType(e.target.value as TaskType)} disabled={!!editing}>
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            {editing && (
              <div className="tasks__cron-hint">编辑模式下任务类型不可修改</div>
            )}
          </Field>

          <Field
            label="cron 表达式"
            required
            hint="5 段式：分 时 日 月 星期，如 0 3 * * * 表示每天凌晨 3 点"
          >
            <div className="tasks__cron-row">
              <div className="tasks__cron-col">
                <Input
                  value={formCron}
                  className="tasks__cell-mono"
                  placeholder="0 3 * * *"
                  onChange={(e) => setFormCron(e.target.value)}
                />
                {formCron.trim() !== '' && !isValidCron(formCron) && (
                  <div className="tasks__cron-error">cron 表达式需为空格分隔的 5 段</div>
                )}
              </div>
            </div>
            <div className="tasks__cron-presets">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  className="tasks__cron-preset"
                  onClick={() => setFormCron(p.cron)}
                >
                  {p.label} ({p.cron})
                </button>
              ))}
            </div>
          </Field>

          <ConfigEditor
            type={formType}
            config={formConfig}
            setConfig={setFormConfig}
            projects={projects}
          />

          <Field label="启用">
            <label className="tasks__switch">
              <input
                type="checkbox"
                checked={formEnabled}
                onChange={(e) => setFormEnabled(e.target.checked)}
              />
              <span className="tasks__switch-slider" />
            </label>
          </Field>
        </div>
      </Modal>

      {/* 执行历史弹窗 */}
      <Modal
        open={!!logsTarget}
        title={logsTarget ? `执行历史：${logsTarget.name}` : '执行历史'}
        onClose={() => setLogsTarget(null)}
        width={720}
      >
        {logsLoading ? (
          <SkeletonRows rows={6} />
        ) : logsItems.length === 0 ? (
          <Empty title="暂无执行历史" description="任务尚未执行过，或历史已被清空" />
        ) : (
          <>
            <div className="tasks__logs-scroll">
              <table className="tasks__table">
                <thead>
                  <tr>
                    <th>执行时间</th>
                    <th>结果</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {logsItems.map((item) => (
                    <tr key={item.id}>
                      <td className="tasks__cell-time">{formatTime(item.runAt)}</td>
                      <td>
                        {item.status === 0 ? (
                          <span className="tasks__result tasks__result--ok">成功</span>
                        ) : (
                          <span className="tasks__result tasks__result--fail">失败</span>
                        )}
                      </td>
                      <td className="tasks__logs-detail" title={item.detail || ''}>
                        {item.detail || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="tasks__logs-pagination">
              <span className="tasks__logs-info">
                共 {logsTotal} 条，当前第 {logsPageStart}-{logsPageEnd} 条
              </span>
              <div className="tasks__logs-controls">
                {logsTarget && (
                  <button
                    className="tasks__page-btn tasks__export-btn"
                    onClick={() => handleExportLogs(logsTarget)}
                  >
                    导出 CSV
                  </button>
                )}
                <button
                  className="tasks__page-btn"
                  disabled={logsSafePage <= 1}
                  onClick={() => logsTarget && loadLogs(logsTarget, logsSafePage - 1)}
                >
                  上一页
                </button>
                {Array.from({ length: logsTotalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    className={`tasks__page-btn ${p === logsSafePage ? 'tasks__page-btn--active' : ''}`}
                    onClick={() => logsTarget && loadLogs(logsTarget, p)}
                  >
                    {p}
                  </button>
                ))}
                <button
                  className="tasks__page-btn"
                  disabled={logsSafePage >= logsTotalPages}
                  onClick={() => logsTarget && loadLogs(logsTarget, logsSafePage + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* 删除确认框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除计划任务"
        message={`确定要删除任务 "${deleteTarget?.name || ''}" 吗？删除后其全部执行历史也会一并清除。`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/**
 * 按任务类型动态渲染其 config 参数编辑区
 * @param param0 type 任务类型、config 当前配置值、setConfig 更新配置、projects Compose 项目列表
 */
function ConfigEditor({
  type,
  config,
  setConfig,
  projects,
}: {
  type: TaskType;
  config: Record<string, any>;
  setConfig: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  projects: string[];
}) {
  /**
   * 更新配置的单个字段
   * @param key 字段名
   * @param value 字段新值
   */
  const setKey = (key: string, value: any) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  // prune：四个/五个清理勾选项，默认全选
  if (type === 'prune') {
    return (
      <Field label="清理范围">
        <div className="tasks__checks">
          {PRUNE_ITEMS.map((item) => (
            <label key={item.key} className="tasks__check">
              <input
                type="checkbox"
                checked={config[item.key] === undefined ? true : !!config[item.key]}
                onChange={(e) => setKey(item.key, e.target.checked)}
              />
              {item.label}
            </label>
          ))}
        </div>
      </Field>
    );
  }

  // backup：选择备份目标，volumes 时填卷名，keepCount 保留个数
  if (type === 'backup') {
    const target = config.target === 'volumes' ? 'volumes' : 'database';
    return (
      <>
        <Field label="备份目标">
          <div className="tasks__radios">
            {BACKUP_TARGETS.map((t) => (
              <label key={t.value} className="tasks__radio">
                <input
                  type="radio"
                  checked={target === t.value}
                  onChange={() => setKey('target', t.value)}
                />
                {t.label}
              </label>
            ))}
            <div className="tasks__radio-hint">
              {target === 'volumes'
                ? '备份指定 Docker 命名卷并将其打包为 tar.gz 文件'
                : '备份本面板自身的 SQLite 数据库副本'}
            </div>
          </div>
        </Field>

        {target === 'volumes' && (
          <Field
            label="卷名"
            hint="多个卷名用英文逗号分隔，如 mydata,logs"
            required
          >
            <Input
              value={Array.isArray(config.volumes) ? config.volumes.join(',') : ''}
              placeholder="mydata,logs"
              onChange={(e) =>
                setKey(
                  'volumes',
                  e.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean)
                )
              }
            />
          </Field>
        )}

        <Field label="保留备份数" hint="超过该数量时自动删除最旧的备份，0 或留空表示不清理">
          <Input
            type="number"
            min={0}
            value={config.keepCount ?? ''}
            placeholder="如 7"
            onChange={(e) => setKey('keepCount', e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </Field>
      </>
    );
  }

  // pull：拉取镜像
  if (type === 'pull') {
    return (
      <Field label="镜像名称" required hint="如 nginx:latest">
        <Input
          value={config.image || ''}
          placeholder="nginx:latest"
          onChange={(e) => setKey('image', e.target.value)}
        />
      </Field>
    );
  }

  // composeUp / composeDown：选择 Compose 项目
  return (
    <Field label="Compose 项目" required hint="从已登记的 Compose 项目中选择">
      <Select value={config.project || ''} onChange={(e) => setKey('project', e.target.value)}>
        <option value="">请选择项目</option>
        {projects.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </Select>
    </Field>
  );
}
