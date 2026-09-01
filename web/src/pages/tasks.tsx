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
import { Field, Input, Select, TextArea } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post, put, del, download } from '../api/client';
import { isAdmin } from '../api/auth';
import {
  CronTask,
  CronTaskListResponse,
  CronTaskLogPage,
  CronTaskLogItem,
  CronPreviewResponse,
  TaskType,
  ContainerListItem,
} from '../types';
import { translateNow as t } from '../i18n';
import './tasks.less';

/** 任务类型中文映射与徽标色，key 与后端 type 字段一致 */
const TYPE_OPTIONS: Array<{ value: TaskType; label: string; badge: string }> = [
  { value: 'prune', label: '清理', badge: 'cyan' },
  { value: 'backup', label: '备份', badge: 'blue' },
  { value: 'pull', label: '拉取镜像', badge: 'purple' },
  { value: 'composeUp', label: '拉起 compose', badge: 'green' },
  { value: 'composeDown', label: '停止 compose', badge: 'orange' },
  { value: 'restart', label: '重启容器', badge: 'red' },
  { value: 'command', label: '自定义命令', badge: 'teal' },
  { value: 'healthcheck', label: '容器健康检查', badge: 'slate' },
  { value: 'git-pull-build', label: 'Git 自动部署', badge: 'indigo' },
  { value: 'baselineScan', label: '安全基线扫描', badge: 'red' },
  { value: 'imageGc', label: '镜像清理', badge: 'orange' },
  { value: 'sqliteBackup', label: '数据库备份', badge: 'blue' },
  { value: 'vulnScan', label: '漏洞定时扫描', badge: 'violet' },
];

/** cron 表达式快捷预设：说明 + 表达式 */
const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: '每分钟', cron: '* * * * *' },
  { label: '每小时', cron: '0 * * * *' },
  { label: '每天', cron: '0 0 * * *' },
  { label: '每周一', cron: '0 0 * * 1' },
  { label: '每月 1 号', cron: '0 0 1 * *' },
];

/** 新增任务弹窗默认的 cron 表达式 */
const DEFAULT_CRON = '0 3 * * *';

/**
 * cron 可视化的 5 个维度定义（顺序与段位一一对应）
 * 每个维度包含取值范围、中文名、说明。
 */
const CRON_DIMENSIONS = [
  { key: 'minute', label: '分钟', min: 0, max: 59, hint: '0-59' },
  { key: 'hour', label: '小时', min: 0, max: 23, hint: '0-23' },
  { key: 'day', label: '日期', min: 1, max: 31, hint: '1-31' },
  { key: 'month', label: '月份', min: 1, max: 12, hint: '1-12' },
  { key: 'week', label: '星期', min: 0, max: 7, hint: '0-7（0/7 为周日）' },
] as const;

/** 单个维度可用的三态编辑模式 */
type CronMode = 'any' | 'every' | 'specified';

/**
 * 各维度当前编辑状态：模式 + 周期步长 + 勾选的值集合
 */
interface CronDimensionState {
  mode: CronMode;
  /** 周期模式的步长 N */
  step: number;
  /** 指定模式勾选的值集合 */
  values: number[];
}

/** 完整 cron 的维度状态集合，下标与 CRON_DIMENSIONS 一一对应 */
type CronStates = [CronDimensionState, CronDimensionState, CronDimensionState, CronDimensionState, CronDimensionState];

/**
 * 把 5 个维度的状态拼装成完整 cron 字符串（空格分隔）
 * @param states 各维度状态
 * @returns 拼装后的 cron 表达式
 */
function buildCronFromStates(states: CronStates): string {
  return states
    .map((s) => {
      if (s.mode === 'any') return '*';
      if (s.mode === 'every') return `*/${Math.max(1, Math.floor(s.step) || 1)}`;
      // 指定模式：按值升序拼接，无勾选则回退为 *
      const vals = [...s.values].sort((a, b) => a - b);
      return vals.length > 0 ? vals.join(',') : '*';
    })
    .join(' ');
}

/**
 * 从当前 cron 表达式解析各维度编辑状态（纯前端解析）
 * 解析规则：段为 * → 任意；*斜杠N → 周期 N；数字或逗号数字 → 指定勾选；
 * 其它无法解析的值 → 该维度回退为「任意」。
 * @param cron 完整 cron 表达式
 * @returns 解析出的各维度状态
 */
function parseCronToStates(cron: string): CronStates {
  const parts = (cron || '').trim().split(/\s+/);
  return CRON_DIMENSIONS.map((dim, i): CronDimensionState => {
    const seg = parts[i];
    // 默认无该段或为空 → 任意
    if (!seg || seg === '*') {
      return { mode: 'any', step: 1, values: [] };
    }
    // 周期模式：*/N
    const everyMatch = /^\*\/(\d+)$/.exec(seg);
    if (everyMatch) {
      return { mode: 'every', step: Number(everyMatch[1]) || 1, values: [] };
    }
    // 指定模式：单值或逗号分隔数字列表（去重、裁剪到取值范围内）
    if (/^[\d,]+$/.test(seg)) {
      const vals = [
        ...new Set(
          seg
            .split(',')
            .map((n) => Number(n.trim()))
            .filter((n) => Number.isFinite(n))
            .filter((n) => n >= dim.min && n <= dim.max)
        ),
      ].sort((a, b) => a - b);
      return { mode: 'specified', step: 1, values: vals };
    }
    // 其它无法解析（如范围、步进、别名）→ 回退任意，保留文本框原文
    return { mode: 'any', step: 1, values: [] };
  }) as CronStates;
}

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
 * 提取容器显示名称（去前导斜杠），用于容器多选列表展示
 * @param c 容器列表项
 * @returns 显示名称，回退到容器 Id
 */
function containerDisplayName(c: ContainerListItem): string {
  return (c.Names && c.Names[0]?.replace(/^\//, '')) || c.Id;
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
 * 计划任务页组件
 */
export default function TasksPage() {
  const { showToast } = useToast();
  const canManage = isAdmin();
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  // 容器列表（供 restart/healthcheck 类型的容器多选使用）
  const [containers, setContainers] = useState<ContainerListItem[]>([]);
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
  // cron 可视化编辑器：默认收起（展开/收起由 state 控制）
  const [cronEditorOpen, setCronEditorOpen] = useState(false);
  // 各维度编辑状态（供可视化面板控件回填与双向同步）
  const [cronStates, setCronStates] = useState<CronStates>(() => parseCronToStates(DEFAULT_CRON));
  // 下次执行时间预览结果文本（'' 表示尚未请求）
  const [cronPreviewText, setCronPreviewText] = useState('');
  // 预览请求进行中标记
  const [cronPreviewing, setCronPreviewing] = useState(false);
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
      setLoadError(e?.message || t('拉取计划任务失败'));
      showToast(e?.message || t('拉取计划任务失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks, refreshKey]);

  /**
   * 拉取全部容器列表，供 restart/healthcheck 任务的容器多选使用
   */
  useEffect(() => {
    get<ContainerListItem[]>('/api/containers', { all: true })
      .then((data) => setContainers(data || []))
      .catch((e: any) => {
        // 容器列表拉取失败不阻塞任务页主体功能，仅静默降级为空列表
        showToast(e?.message || t('获取容器列表失败'), 'error');
      });
  }, [showToast]);

  /**
   * 打开「新建任务」弹窗：重置表单为默认值
   */
  const openCreate = useCallback(() => {
    if (!canManage) {
      showToast(t('仅管理员可新建任务'), 'error');
      return;
    }
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
  }, [canManage, showToast]);

  /**
   * 打开「编辑任务」弹窗：用目标任务回填表单
   * @param task 要编辑的任务
   */
  const openEdit = useCallback((task: CronTask) => {
    if (!canManage) {
      showToast(t('仅管理员可编辑任务'), 'error');
      return;
    }
    setEditing(task);
    setFormName(task.name);
    setFormType(task.type);
    setFormCron(task.cron);
    setFormEnabled(task.enabled);
    // 深拷贝 config，避免直接修改原任务对象
    setFormConfig(JSON.parse(JSON.stringify(task.config || {})));
    setFormOpen(true);
  }, [canManage, showToast]);

  /**
   * 切换可视化编辑器的展开/收起
   * 展开时把当前 formCron 解析回填到各维度控件（parseCronToStates）
   */
  const toggleCronEditor = useCallback(() => {
    setCronEditorOpen((open) => {
      const next = !open;
      if (next) {
        // 展开前解析当前输入框表达式，回填控件
        setCronStates(parseCronToStates(formCron));
      }
      return next;
    });
  }, [formCron]);

  /**
   * 应用可视化面板的改动：更新维度状态并实时拼装同步到 formCron
   * @param states 新的维度状态集合
   */
  const applyCronStates = useCallback(
    (states: CronStates) => {
      setCronStates(states);
      // 把所有维度的状态拼成完整 cron 并同步到输入框
      const cron = buildCronFromStates(states);
      setFormCron(cron);
      setCronPreviewText('');
    },
    []
  );

  /**
   * 更新某个维度的编辑状态（切换模式 / 修改周期步长等）
   * @param index 维度下标（0-4）
   * @param patch 要合并到该维度的新字段
   */
  const updateDimension = useCallback(
    (index: number, patch: Partial<CronDimensionState>) => {
      setCronStates((prev) => {
        const next = prev.slice() as CronStates;
        next[index] = { ...next[index], ...patch };
        // 实时拼装并同步到输入框
        setFormCron(buildCronFromStates(next));
        setCronPreviewText('');
        return next;
      });
    },
    []
  );

  /**
   * 勾选/取消勾选指定模式下的某个值
   * @param index 维度下标（0-4）
   * @param value 要切换的值
   * @param checked 是否选中
   */
  const toggleCronValue = useCallback(
    (index: number, value: number, checked: boolean) => {
      setCronStates((prev) => {
        const next = prev.slice() as CronStates;
        const cur = next[index].values.slice();
        const idx = cur.indexOf(value);
        if (checked && idx < 0) cur.push(value);
        if (!checked && idx >= 0) cur.splice(idx, 1);
        next[index] = { ...next[index], values: cur, mode: 'specified' };
        // 实时拼装并同步到输入框
        setFormCron(buildCronFromStates(next));
        setCronPreviewText('');
        return next;
      });
    },
    []
  );

  /**
   * 请求后端计算下次执行时间并展示
   * 失败或返回 null 时展示提示文本；请求失败静默忽略
   */
  const handleCronPreview = useCallback(async () => {
    if (!isValidCron(formCron)) {
      setCronPreviewText(t('无法计算/非法表达式'));
      return;
    }
    setCronPreviewing(true);
    try {
      const data = await get<CronPreviewResponse>('/api/tasks/cron-preview', {
        cron: formCron.trim(),
      });
      if (data?.nextRun) {
        setCronPreviewText(t('下次执行：{{v1}}', { v1: formatTime(data.nextRun) }));
      } else {
        setCronPreviewText(t('无法计算/非法表达式'));
      }
    } catch {
      // 预览失败静默忽略，清空提示避免误导
      setCronPreviewText('');
    } finally {
      setCronPreviewing(false);
    }
  }, [formCron]);

  /**
   * 重置为默认表达式并重新解析到可视化控件
   */
  const handleCronResetDefault = useCallback(() => {
    setFormCron(DEFAULT_CRON);
    setCronStates(parseCronToStates(DEFAULT_CRON));
    setCronPreviewText('');
  }, []);

  /**
   * 从表单 config 中拆出 gitCred 凭证并剔除 config 明文敏感字段
   * @param cfg 表单配置（含 credType/credToken/credKey/credPassphrase 临时字段）
   * @returns gitCred 顶层凭证对象 + 剔除敏感字段后的干净 config
   */
  const buildGitCred = (cfg: Record<string, any>) => {
    const type = cfg.credType === 'ssh' ? 'ssh' : 'token';
    const out: any = { type };
    if (type === 'ssh') {
      if (cfg.credKey) out.privateKey = cfg.credKey;
      if (cfg.credPassphrase) out.passphrase = cfg.credPassphrase;
    } else if (cfg.credToken) {
      out.token = cfg.credToken;
    }
    const { credType, credToken, credKey, credPassphrase, ...cleanConfig } = cfg;
    return { gitCred: out, cleanConfig };
  };

  /**
   * 提交新建/编辑：新建用 post，编辑用本地 put
   */
  const handleSave = useCallback(async () => {
    if (!canManage) {
      showToast(editing ? t('仅管理员可编辑任务') : t('仅管理员可新建任务'), 'error');
      setFormOpen(false);
      return;
    }
    if (!formName.trim()) {
      showToast(t('请填写任务名称'), 'error');
      return;
    }
    if (!isValidCron(formCron)) {
      showToast(t('cron 表达式格式不正确（应为空格分隔的 5 段）'), 'error');
      return;
    }
    setSaving(true);
    try {
      // 从表单 config 拆出 gitCred 凭证与剔除敏感字段后的干净 config
      const { gitCred: saveGitCred, cleanConfig } = buildGitCred(formConfig);
      // 仅当用户填写了凭证时才附带 gitCred：编辑时凭证留空不传（保留原凭证），
      // 新建时无凭证不传（本来就没有），有凭证才传，避免把 null 传给后端导致意外清空。
      const hasCred = !!(saveGitCred.token || saveGitCred.privateKey);
      const payload: any = {
        name: formName.trim(),
        cron: formCron.trim(),
        enabled: formEnabled,
        config: cleanConfig,
      };
      if (hasCred) {
        payload.gitCred = saveGitCred;
      }
      if (editing) {
        // 更新任务（后端 PUT），仅更新允许修改的字段
        await put(`/api/tasks/${editing.id}`, payload);
        showToast(t('任务已更新'), 'success');
      } else {
        // 新建任务
        await post('/api/tasks', { ...payload, type: formType });
        showToast(t('任务已创建'), 'success');
      }
      setFormOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || (editing ? t('更新任务失败') : t('创建任务失败')), 'error');
    } finally {
      setSaving(false);
    }
  }, [canManage, editing, formName, formType, formCron, formEnabled, formConfig, buildGitCred, showToast]);

  /**
   * 切换任务的启用/停用状态
   * @param task 目标任务
   */
  const handleToggle = useCallback(
    async (task: CronTask) => {
      if (!canManage) {
        showToast(t('仅管理员可启停任务'), 'error');
        return;
      }
      const next = !task.enabled;
      try {
        await post(`/api/tasks/${task.id}/enable`, { enabled: next });
        showToast(next ? t('任务已启用') : t('任务已停用'));
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || t('更新启用状态失败'), 'error');
      }
    },
    [canManage, showToast]
  );

  /**
   * 立即执行任务，成功后提示返回的 detail
   * @param task 目标任务
   */
  const handleRun = useCallback(
    async (task: CronTask) => {
      if (!canManage) {
        showToast(t('仅管理员可立即执行任务'), 'error');
        return;
      }
      setRunId(task.id);
      try {
        const data = await post<{ ok: boolean; detail?: string }>(`/api/tasks/${task.id}/run`);
        if (data?.ok) {
          showToast(data?.detail || t('任务执行成功'));
        } else {
          showToast(data?.detail || t('任务执行失败'), 'error');
        }
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || t('立即执行失败'), 'error');
      } finally {
        setRunId(null);
      }
    },
    [canManage, showToast]
  );

  /**
   * 删除任务（经确认框调用）
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canManage) {
      showToast(t('仅管理员可删除任务'), 'error');
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/tasks/${deleteTarget.id}`);
      showToast(t('任务已删除'), 'success');
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('删除任务失败'), 'error');
    } finally {
      setDeleting(false);
    }
  }, [canManage, deleteTarget, showToast]);

  /**
   * 开启某任务的 Webhook：生成 URL 并复制到剪贴板
   * @param taskId 任务 id
   */
  const handleWebhook = useCallback(async (taskId: string) => {
    try {
      const r = await post<{ ok: boolean; url: string; token: string }>(`/api/tasks/${taskId}/webhook`);
      if (r?.ok) {
        try { await navigator.clipboard.writeText(String(r.url)); } catch { /* 忽略剪贴板失败 */ }
        showToast(t('Webhook 已生成并复制到剪贴板'), 'success');
        setRefreshKey((k) => k + 1);
      }
    } catch (e: any) {
      showToast(e?.message || t('生成 Webhook 失败'), 'error');
    }
  }, [showToast]);

  /**
   * 关闭某任务的 Webhook
   * @param taskId 任务 id
   */
  const handleWebhookOff = useCallback(async (taskId: string) => {
    try {
      await del(`/api/tasks/${taskId}/webhook`);
      showToast(t('Webhook 已关闭'), 'success');
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || t('关闭 Webhook 失败'), 'error');
    }
  }, [showToast]);

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
        showToast(e?.message || t('加载执行历史失败'), 'error');
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
        showToast(e?.message || t('导出执行历史失败'), 'error');
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
      <h1 className="tasks-page__title">{t('计划任务')}</h1>

      <Card>
        <div className="tasks__toolbar">
          <div className="tasks__toolbar-left">
            <span className="tasks__total">{t('共 {{n}} 个任务', { n: tasks.length })}</span>
          </div>
          <div className="tasks__toolbar-right">
            <Button variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
              {t('刷新')}
            </Button>
            <Button variant="primary" size="sm" onClick={openCreate} disabled={!canManage}>
              {t('+ 新建任务')}
            </Button>
          </div>
        </div>

        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title={t('拉取计划任务失败')}
            description={loadError || t('请稍后重试')}
            action={
              <Button variant="secondary" size="sm" onClick={fetchTasks}>
                {t('重试')}
              </Button>
            }
          />
        ) : tasks.length === 0 ? (
          <Empty
            title={t('暂无计划任务')}
            description={t('点击「新建任务」创建定时任务，可自动清理、备份或拉取镜像')}
          />
        ) : (
          <table className="tasks__table">
            <thead>
              <tr>
                <th>{t('名称')}</th>
                <th>{t('类型')}</th>
                <th>{t('cron 表达式')}</th>
                <th>{t('启用')}</th>
                <th>{t('下次执行')}</th>
                <th>{t('上次执行')}</th>
                <th>{t('上次结果')}</th>
                <th className="tasks__cell-actions">{t('操作')}</th>
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
                        disabled={!canManage}
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
                        <span className="tasks__result tasks__result--ok">{t('成功')}</span>
                      ) : (
                        <span className="tasks__result tasks__result--fail">{t('失败')}</span>
                      )
                    ) : (
                      <span className="tasks__result tasks__result--none">{t('未执行')}</span>
                    )}
                  </td>
                  <td className="tasks__cell-actions">
                    <Button variant="ghost" size="sm" onClick={() => openLogs(task)}>
                      {t('日志')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={runId === task.id}
                      disabled={!!runId || !canManage}
                      onClick={() => handleRun(task)}
                    >
                      {t('立即执行')}
                    </Button>
                    {task.webhookToken ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canManage}
                          title={`Webhook URL:\n/api/webhook/${task.webhookToken}`}
                          onClick={() =>
                            navigator.clipboard
                              ?.writeText(`https://${window.location.host}/api/webhook/${task.webhookToken}`)
                              .then(() => showToast(t('Webhook URL 已复制')))
                              .catch(() => {})
                          }
                        >
                          {t('Webhook已开(复制)')}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => handleWebhookOff(task.id)}>
                          {t('关闭Webhook')}
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => handleWebhook(task.id)}>
                        {t('开启Webhook')}
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" onClick={() => openEdit(task)} disabled={!canManage}>
                      {t('编辑')}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setDeleteTarget(task)} disabled={!canManage}>
                      {t('删除')}
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
        title={editing ? t('编辑任务「{{v1}}」', { v1: editing.name }) : t('新建任务')}
        onClose={() => !saving && setFormOpen(false)}
        width={560}
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setFormOpen(false)} disabled={saving}>
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" loading={saving} onClick={handleSave} disabled={!canManage}>
              {editing ? t('保存修改') : t('创建任务')}
            </Button>
          </>
        }
      >
        <div className="tasks__form">
          <Field label={t('任务名称')} required>
            <Input
              value={formName}
              placeholder={t('如：每周清理未使用镜像')}
              onChange={(e) => setFormName(e.target.value)}
            />
          </Field>

          <Field label={t('任务类型')}>
            <Select value={formType} onChange={(e) => setFormType(e.target.value as TaskType)} disabled={!!editing}>
              {TYPE_OPTIONS.map((opt) => (
<option key={opt.value} value={opt.value}>
{t(opt.label)}
</option>
              ))}
            </Select>
            {editing && (
              <div className="tasks__cron-hint">{t('编辑模式下任务类型不可修改')}</div>
            )}
          </Field>

          <Field
            label={t('cron 表达式')}
            required
            hint={t('5 段式：分 时 日 月 星期，如 0 3 * * * 表示每天凌晨 3 点')}
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
                  <div className="tasks__cron-error">{t('cron 表达式需为空格分隔的 5 段')}</div>
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
                  {t(p.label)} ({p.cron})
                </button>
              ))}
            </div>
            <div className="tasks__cron-visual-toolbar">
              <button
                type="button"
                className="tasks__cron-visual-toggle"
                onClick={toggleCronEditor}
              >
                {cronEditorOpen ? t('收起可视化编辑') : t('可视化编辑')}
              </button>
              {cronEditorOpen && (
                <button type="button" className="tasks__cron-visual-toggle" onClick={handleCronResetDefault}>
                  {t('重置为默认')}
                </button>
              )}
            </div>
            {cronEditorOpen && (
              <div className="tasks__cron-visual">
                {CRON_DIMENSIONS.map((dim, i) => {
                  const dimState = cronStates[i];
                  return (
                    <div className="tasks__cron-dim" key={dim.key}>
                      <div className="tasks__cron-dim-head">
                        <span className="tasks__cron-dim-label">
                          {t(dim.label)}
                          <span className="tasks__cron-dim-hint">({dim.hint})</span>
                        </span>
                        <div className="tasks__cron-segmented">
                          {(
                            [
                              { key: 'any', label: '任意' },
                              { key: 'every', label: '周期' },
                              { key: 'specified', label: '指定' },
                            ] as Array<{ key: CronMode; label: string }>
                          ).map((m) => (
                            <button
                              key={m.key}
                              type="button"
                              className={`tasks__cron-seg ${dimState.mode === m.key ? 'tasks__cron-seg--active' : ''}`}
                              onClick={() => updateDimension(i, { mode: m.key })}
                            >
                              {t(m.label)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="tasks__cron-dim-body">
                        {dimState.mode === 'any' && (
                          <div className="tasks__cron-dim-note">{t('不限制，任意取值（段为 *）')}</div>
                        )}
                        {dimState.mode === 'every' && (
                          <label className="tasks__cron-every">
                            <Input
                              type="number"
                              min={1}
                              value={dimState.step}
                              className="tasks__cron-every-input"
                              onChange={(e) =>
                                updateDimension(i, { step: Math.max(1, Number(e.target.value) || 1) })
                              }
                            />
                            <span>{t('每隔该数值执行一次（段为 */N）')}</span>
                          </label>
                        )}
                        {dimState.mode === 'specified' && (
                          <div className="tasks__cron-values">
                            {Array.from(
                              { length: dim.max - dim.min + 1 },
                              (_, k) => dim.min + k
                            ).map((v) => (
                              <label key={v} className="tasks__cron-value">
                                <input
                                  type="checkbox"
                                  checked={dimState.values.includes(v)}
                                  onChange={(e) => toggleCronValue(i, v, e.target.checked)}
                                />
                                {v}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="tasks__cron-visual-footer">
                  <Button variant="secondary" size="sm" loading={cronPreviewing} onClick={handleCronPreview}>
                    {t('预览下次执行时间')}
                  </Button>
                  {cronPreviewText && (
                    <span className="tasks__cron-preview">{cronPreviewText}</span>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setCronEditorOpen(false)}>
                    {t('收起')}
                  </Button>
                </div>
              </div>
            )}
          </Field>

          <ConfigEditor
            type={formType}
            config={formConfig}
            setConfig={setFormConfig}
            projects={projects}
            containers={containers}
            gitCred={editing?.gitCred}
          />

          <Field label={t('启用')}>
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
        title={logsTarget ? t('执行历史：{{v1}}', { v1: logsTarget.name }) : t('执行历史')}
        onClose={() => setLogsTarget(null)}
        width={720}
      >
        {logsLoading ? (
          <SkeletonRows rows={6} />
        ) : logsItems.length === 0 ? (
          <Empty title={t('暂无执行历史')} description={t('任务尚未执行过，或历史已被清空')} />
        ) : (
          <>
            <div className="tasks__logs-scroll">
              <table className="tasks__table">
                <thead>
                  <tr>
                    <th>{t('执行时间')}</th>
                    <th>{t('结果')}</th>
                    <th>{t('详情')}</th>
                  </tr>
                </thead>
                <tbody>
                  {logsItems.map((item) => (
                    <tr key={item.id}>
                      <td className="tasks__cell-time">{formatTime(item.runAt)}</td>
                      <td>
                        {item.status === 0 ? (
                          <span className="tasks__result tasks__result--ok">{t('成功')}</span>
                        ) : (
                          <span className="tasks__result tasks__result--fail">{t('失败')}</span>
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
                {t('共 {{total}} 条，当前第 {{start}}-{{end}} 条', { total: logsTotal, start: logsPageStart, end: logsPageEnd })}
              </span>
              <div className="tasks__logs-controls">
                {logsTarget && (
                  <button
                    className="tasks__page-btn tasks__export-btn"
                    onClick={() => handleExportLogs(logsTarget)}
                  >
                    {t('导出 CSV')}
                  </button>
                )}
                <button
                  className="tasks__page-btn"
                  disabled={logsSafePage <= 1}
                  onClick={() => logsTarget && loadLogs(logsTarget, logsSafePage - 1)}
                >
                  {t('上一页')}
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
                  {t('下一页')}
                </button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* 删除确认框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('删除计划任务')}
        message={t('确定要删除任务 "{{v1}}" 吗？删除后其全部执行历史也会一并清除。', { v1: deleteTarget?.name || '' })}
        confirmText={t('删除')}
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
 * @param param0 type 任务类型、config 当前配置值、setConfig 更新配置、projects Compose 项目列表、containers 容器列表
 */
function ConfigEditor({
  type,
  config,
  setConfig,
  projects,
  containers,
  gitCred,
}: {
  type: TaskType;
  config: Record<string, any>;
  setConfig: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  projects: string[];
  containers: ContainerListItem[];
  gitCred?: CronTask['gitCred'];
}) {
  /**
   * 更新配置的单个字段
   * @param key 字段名
   * @param value 字段新值
   */
  const setKey = (key: string, value: any) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * 切换容器多选中单个容器的选中状态
   * @param id 容器 Id
   * @param checked 是否选中
   */
  const toggleContainer = (id: string, checked: boolean) => {
    const list = Array.isArray(config.containers) ? config.containers.slice() : [];
    const idx = list.indexOf(id);
    if (checked && idx < 0) list.push(id);
    if (!checked && idx >= 0) list.splice(idx, 1);
    setKey('containers', list);
  };

  /** 当前已选中的容器 Id 集合（用于勾选态判定） */
  const selectedContainers = Array.isArray(config.containers) ? config.containers : [];

  /**
   * 渲染容器多选勾选列表（restart / healthcheck 复用）
   * @param extraHint 额外提示文案
   */
  const renderContainerPicker = (extraHint?: string) => (
    <>
      <Field label={t('目标容器')} required hint={extraHint}>
        {containers.length === 0 ? (
          <div className="tasks__cron-hint">{t('未获取到容器列表，请确认 Docker 服务已启动')}</div>
        ) : (
          <div className="tasks__checks tasks__checks--col">
            {containers.map((c) => (
              <label key={c.Id} className="tasks__check">
                <input
                  type="checkbox"
                  checked={selectedContainers.includes(c.Id)}
                  onChange={(e) => toggleContainer(c.Id, e.target.checked)}
                />
                {containerDisplayName(c)}
              </label>
            ))}
          </div>
        )}
      </Field>
    </>
  );

  // prune：四个/五个清理勾选项，默认全选
  if (type === 'prune') {
    return (
      <Field label={t('清理范围')}>
        <div className="tasks__checks">
          {PRUNE_ITEMS.map((item) => (
            <label key={item.key} className="tasks__check">
              <input
                type="checkbox"
                checked={config[item.key] === undefined ? true : !!config[item.key]}
                onChange={(e) => setKey(item.key, e.target.checked)}
              />
              {t(item.label)}
            </label>
          ))}
        </div>
      </Field>
    );
  }

  // vulnScan：可选镜像列表（留空 = 本地镜像前 N 个）与扫描上限
  if (type === 'vulnScan') {
    return (
      <>
        <Field
          label={t('镜像列表（可选）')}
          hint={t('多个镜像用英文逗号分隔，如 nginx:latest,redis:7；留空则自动扫描本地镜像')}
        >
          <TextArea
            value={Array.isArray(config.images) ? config.images.join(',') : config.images || ''}
            placeholder={t('nginx:latest,redis:7')}
            onChange={(e) => setKey('images', e.target.value)}
          />
        </Field>
        <Field label={t('扫描上限')} hint={t('未指定镜像列表时最多扫描的本地镜像数量，默认 20')}>
          <Input
            type="number"
            min={1}
            value={config.maxImages ?? ''}
            placeholder={t('如 20')}
            onChange={(e) => setKey('maxImages', e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </Field>
        <Field label={t('新增高危时推送告警')}>
          <div className="tasks__checks">
            <label className="tasks__check">
              <input
                type="checkbox"
                checked={config.notify !== false}
                onChange={(e) => setKey('notify', e.target.checked)}
              />
              {t('发现新增 Critical / High 漏洞时推送到全部启用渠道')}
            </label>
          </div>
        </Field>
      </>
    );
  }

  // backup：选择备份目标，volumes 时填卷名，keepCount 保留个数
  if (type === 'backup') {
    const target = config.target === 'volumes' ? 'volumes' : 'database';
    return (
      <>
        <Field label={t('备份目标')}>
          <div className="tasks__radios">
            {BACKUP_TARGETS.map((bt) => (
              <label key={bt.value} className="tasks__radio">
                <input
                  type="radio"
                  checked={target === bt.value}
                  onChange={() => setKey('target', bt.value)}
                />
                {t(bt.label)}
              </label>
            ))}
            <div className="tasks__radio-hint">
              {target === 'volumes'
                ? t('备份指定 Docker 命名卷并将其打包为 tar.gz 文件')
                : t('备份本面板自身的 SQLite 数据库副本')}
            </div>
          </div>
        </Field>

        {target === 'volumes' && (
          <Field
            label={t('卷名')}
            hint={t('多个卷名用英文逗号分隔，如 mydata,logs')}
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

        <Field label={t('保留备份数')} hint={t('超过该数量时自动删除最旧的备份，0 或留空表示不清理')}>
          <Input
            type="number"
            min={0}
            value={config.keepCount ?? ''}
            placeholder={t('如 7')}
            onChange={(e) => setKey('keepCount', e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </Field>
      </>
    );
  }

  // pull：拉取镜像
  if (type === 'pull') {
    return (
      <Field label={t('镜像名称')} required hint={t('如 nginx:latest')}>
        <Input
          value={config.image || ''}
          placeholder="nginx:latest"
          onChange={(e) => setKey('image', e.target.value)}
        />
      </Field>
    );
  }

  // restart：定时重启选中的容器（容器多选）
  if (type === 'restart') {
    return renderContainerPicker(t('定时对选中容器执行重启（restart）操作'));
  }

  // command：定时执行自定义宿主命令
  if (type === 'command') {
    return (
      <>
        <Field label={t('执行命令')} required hint={t('在宿主机上执行的 shell 命令')}>
          <TextArea
            value={config.command || ''}
            placeholder="docker system df"
            rows={3}
            onChange={(e) => setKey('command', e.target.value)}
          />
        </Field>
        <Field label={t('工作目录（可选）')} hint={t('命令执行的宿主工作目录，留空使用默认目录')}>
          <Input
            value={config.cwd || ''}
            placeholder="/root"
            onChange={(e) => setKey('cwd', e.target.value)}
          />
        </Field>
      </>
    );
  }

  // git-pull-build：Git 自动构建/部署 + 私有仓库凭证
  if (type === 'git-pull-build') {
    return (
      <>
        <Field label={t('部署模式')}>
          <Select value={config.mode || 'image'} onChange={(e) => setKey('mode', e.target.value)}>
            <option value="image">{t('构建镜像')}</option>
            <option value="compose">{t('Compose 部署')}</option>
          </Select>
        </Field>
        <Field label={t('Git 仓库地址')} required hint={t('支持 https 与 ssh 协议')}>
          <Input value={config.repoUrl || ''} onChange={(e) => setKey('repoUrl', e.target.value)} placeholder="https://github.com/user/repo.git" />
        </Field>
        <Field label={t('分支（可选）')}>
          <Input value={config.branch || ''} onChange={(e) => setKey('branch', e.target.value)} placeholder="main" />
        </Field>
        {config.mode === 'image' ? (
          <>
            <Field label={t('镜像名')} required hint={t('构建后打标签，如 myapp:latest')}>
              <Input value={config.imageName || ''} onChange={(e) => setKey('imageName', e.target.value)} />
            </Field>
            <Field label={t('Dockerfile（可选）')}>
              <Input value={config.dockerfile || 'Dockerfile'} onChange={(e) => setKey('dockerfile', e.target.value)} />
            </Field>
            <Field label={t('工作目录（可选，默认自动）')}>
              <Input value={config.destDir || ''} onChange={(e) => setKey('destDir', e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label={t('Compose 项目')} required hint={t('对应 Compose 项目目录')}>
              <Select value={config.composeProject || ''} onChange={(e) => setKey('composeProject', e.target.value)}>
                <option value="">{t('选择项目…')}</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('构建后部署')}>
              <label className="tasks__check">
                <input type="checkbox" checked={!!config.alsoBuild} onChange={(e) => setKey('alsoBuild', e.target.checked)} /> {t('部署前先构建镜像')}
              </label>
            </Field>
          </>
        )}
        <Field label={t('私有仓库凭证')} hint={gitCred?.hasCred ? t('已配置（留空不修改）') : t('可选，公开仓库可跳过')}>
          <Select value={config.credType || 'token'} onChange={(e) => setKey('credType', e.target.value)}>
            <option value="token">HTTPS Token</option>
            <option value="ssh">{t('SSH 私钥')}</option>
          </Select>
          {config.credType === 'ssh' ? (
            <Input value={config.credKey || ''} onChange={(e) => setKey('credKey', e.target.value)} placeholder={gitCred?.hasCred ? t('已配置，输入以替换…') : t('粘贴私钥内容')} />
          ) : (
            <Input value={config.credToken || ''} onChange={(e) => setKey('credToken', e.target.value)} placeholder={gitCred?.hasCred ? t('已配置，输入以替换…') : t('粘贴 Token')} />
          )}
          {config.credType === 'ssh' && (
            <Field label={t('私钥口令（可选）')}>
              <Input value={config.credPassphrase || ''} onChange={(e) => setKey('credPassphrase', e.target.value)} placeholder={t('SSH 私钥口令')} />
            </Field>
          )}
        </Field>
      </>
    );
  }

  // healthcheck：定时检查容器运行/健康状态，异常经告警中心通知
  if (type === 'healthcheck') {
    return renderContainerPicker(t('定时检查容器是否运行/健康，异常会经告警中心通知'));
  }
  // baselineScan：定时执行安全基线扫描，违规变化经通知渠道推送
  if (type === 'baselineScan') {
    return (
      <>
        <Field label={t('告警严重度下限')} hint={t('达到该级别的违规才纳入告警统计')}>
          <Select value={config.severityMin || 'warn'} onChange={(e) => setKey('severityMin', e.target.value)}>
            <option value="danger">{t('仅危险（danger）')}</option>
            <option value="warn">{t('警告及以上（warn）')}</option>
            <option value="info">{t('全部（info）')}</option>
          </Select>
        </Field>
        <Field label={t('仅新增违规时告警')} hint={t('与上次扫描对比，仅推送新出现的违规；关闭后每次扫描发现违规即推送')}>
          <label className="tasks__check">
            <input type="checkbox" checked={config.onlyOnNew !== false} onChange={(e) => setKey('onlyOnNew', e.target.checked)} />{' '}
            {t('仅告警新增违规（默认开启）')}
          </label>
        </Field>
      </>
    );
  }
  // sqliteBackup：定时备份面板自身数据库，无需额外参数
  if (type === 'sqliteBackup') {
    return (
      <Field label={t('备份参数')} hint={t('备份保存在数据目录 db-backups/ 下，保留份数由设置中心「面板数据库备份保留份数」控制')}>
        <div />
      </Field>
    );
  }
  // composeUp / composeDown：选择 Compose 项目
  return (
    <Field label={t('Compose 项目')} required hint={t('从已登记的 Compose 项目中选择')}>
      <Select value={config.project || ''} onChange={(e) => setKey('project', e.target.value)}>
        <option value="">{t('请选择项目')}</option>
        {projects.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </Select>
    </Field>
  );
}
