/**
 * 系统设置页
 *
 * 提供账号管理（列用户 / 新增 / 删除 / 改密）与关于 / Docker 引擎信息展示。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Card from '../components/Card';
import Button from '../components/Button';
import Modal from '../components/Modal';
import { Field, Input, TextArea, Select } from '../components/Form';
import { useToast } from '../components/Toast';
import { useTheme } from '../hooks/useTheme';
import { useCanManage } from '../hooks/useCanManage';
import { get, post, put, del, download } from '../api/client';
import { getToken, setRole, type UserRole } from '../api/auth';
import type {
  ConfigImportConflict,
  SystemConfigExport,
  SystemConfigImportResponse,
} from '../types';
import { useLang } from '../i18n';
import './settings.less';

interface UserItem {
  username: string;
  // 角色名：内置 admin/operator/user/auditor 或自定义角色
  role: string;
  createdAt: number;
  ipAllowlist?: string;
}

/** 角色信息（/api/roles） */
interface RoleInfo {
  name: string;
  permissions: string[];
  system: boolean;
}

/** 权限目录项（/api/roles/permissions） */
interface PermissionItem {
  key: string;
  label: string;
  group: string;
}

/** 内置角色展示名 */
const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  operator: '运维人员',
  user: '普通用户',
  auditor: '审计员（只读）',
};
function roleLabel(name: string): string {
  return ROLE_LABELS[name] || name;
}

interface EngineInfo {
  name?: string;
  os?: string;
  arch?: string;
  cpu?: number;
  mem?: number;
  dockerVersion?: string;
  apiVersion?: string;
  containers?: number;
  running?: number;
  images?: number;
}

interface SettingsInfo {
  port: number;
  version: string;
  engine: EngineInfo | null;
}

interface UpdateInfo {
  available: boolean;
  current?: string;
  latest?: string;
  url?: string;
  error?: string;
  notes?: string;
  releaseUrl?: string;
  assets?: Array<{ name: string; url: string; size: number; platform: string }>;
}

interface CurrentUserInfo {
  username: string;
  role?: UserRole;
}

/** 配置中心条目（GET /api/settings 返回） */
interface SettingItem {
  key: string;
  label: string;
  hint?: string;
  type: 'number' | 'string' | 'bool' | 'secret';
  env?: string;
  def?: any;
  group: 'general' | 'runtime' | 'security' | 'retention' | 'notification';
  readonly?: boolean;
  value?: any;
  source?: 'db' | 'env' | 'default';
  configured?: boolean;
}

/** 配置分组显示名 */
const KV_GROUP_LABELS: Record<SettingItem['group'], string> = {
  general: '通用',
  runtime: '运行',
  security: '安全',
  retention: '数据保留',
  notification: '通知默认',
};

/** 字节转可读文本 */
function formatBytes(n?: number): string {
  if (!n) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 时间戳转日期文本 */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

/**
 * 系统设置页
 */
export default function SettingsPage() {
  const { t, lang, setLang } = useLang();
  const { showToast } = useToast();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  // 强制改密模式：首次使用默认密码登录后进入，需完成改密
  const [forceChange, setForceChange] = useState(
    (location.state as { forceChangePassword?: boolean } | null)?.forceChangePassword === true,
  );
  const [users, setUsers] = useState<UserItem[]>([]);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [currentUser, setCurrentUser] = useState('');
  const [currentRole, setCurrentRole] = useState<UserRole>('user');
  const [loading, setLoading] = useState(true);

  // 版本更新检测
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // 新增用户表单
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [creating, setCreating] = useState(false);

  // 角色管理（RBAC）
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [permCatalog, setPermCatalog] = useState<PermissionItem[]>([]);
  const [roleEditing, setRoleEditing] = useState<{ name: string; permissions: string[] } | null>(null);
  const [roleSaving, setRoleSaving] = useState(false);

  // 修改密码表单
  const [oldPassword, setOldPassword] = useState('');
  const [chgPassword, setChgPassword] = useState('');
  const [changing, setChanging] = useState(false);

  // 配置中心（KV 系统参数）
  const [kvItems, setKvItems] = useState<SettingItem[]>([]);
  // 待保存的编辑值（key -> 字符串；仅管理员可编辑）
  const [kvEdits, setKvEdits] = useState<Record<string, string>>({});
  const [kvSaving, setKvSaving] = useState(false);

  // 面板数据库备份（SQLite 服务端快照管理）
  interface SqliteBackupInfo {
    file: string;
    size: number;
    createdAt: number;
  }
  const [dbBackups, setDbBackups] = useState<SqliteBackupInfo[]>([]);
  const [dbBackupBusy, setDbBackupBusy] = useState(false);

  const loadDbBackups = useCallback(async () => {
    try {
      const r = await get<{ items: SqliteBackupInfo[] }>('/api/sqlite-backups');
      setDbBackups(r.items || []);
    } catch {
      // 非管理员或接口不可用时静默（列表区块不展示）
      setDbBackups([]);
    }
  }, []);

  /** 立即备份 / 恢复 / 删除（均仅管理员） */
  async function handleSqliteBackup() {
    setDbBackupBusy(true);
    try {
      await post('/api/sqlite-backups', { reason: 'manual' });
      showToast(t('备份已创建'), 'success');
      await loadDbBackups();
    } catch (e: any) {
      showToast(e?.message || t('备份失败'), 'error');
    } finally {
      setDbBackupBusy(false);
    }
  }

  async function handleSqliteRestore(file: string) {
    if (!confirm(t('确定用该备份恢复面板数据库吗？当前数据将被覆盖，建议恢复后重启面板。'))) return;
    setDbBackupBusy(true);
    try {
      const r = await post<{ ok: boolean; message: string }>(`/api/sqlite-backups/${encodeURIComponent(file)}/restore`, {});
      showToast(r.message || t('恢复完成'), 'success');
      await load();
    } catch (e: any) {
      showToast(e?.message || t('恢复失败'), 'error');
    } finally {
      setDbBackupBusy(false);
    }
  }

  async function handleSqliteDelete(file: string) {
    if (!confirm(t('确定删除备份 {{file}} 吗？', { file }))) return;
    setDbBackupBusy(true);
    try {
      await del(`/api/sqlite-backups/${encodeURIComponent(file)}`);
      showToast(t('已删除'), 'info');
      await loadDbBackups();
    } catch (e: any) {
      showToast(e?.message || t('删除失败'), 'error');
    } finally {
      setDbBackupBusy(false);
    }
  }

  useEffect(() => {
    loadDbBackups();
  }, [loadDbBackups]);

  /**
   * 加载设置页数据
   */
  const load = useCallback(async () => {
    try {
      const [u, s, me, r, pc] = await Promise.all([
        get<UserItem[]>('/api/system/users'),
        get<SettingsInfo>('/api/system/settings'),
        get<CurrentUserInfo>('/api/auth/me'),
        get<{ roles: RoleInfo[] }>('/api/roles'),
        get<{ permissions: PermissionItem[] }>('/api/roles/permissions'),
      ]);
      const role = me.role || 'user';
      setUsers(u || []);
      setIpEdits(Object.fromEntries((u || []).map((x) => [x.username, x.ipAllowlist || ''])));
      setSettings(s);
      setCurrentUser(me.username || '');
      setCurrentRole(role);
      setRole(role);
      setRoles(r?.roles || []);
      setPermCatalog(pc?.permissions || []);
    } catch (e: any) {
      showToast(e?.message || t('加载设置失败'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /** 加载配置中心条目（系统参数） */
  const loadKvSettings = useCallback(async () => {
    try {
      const resp = await get<{ items: SettingItem[] }>('/api/settings');
      setKvItems(resp?.items || []);
      setKvEdits({});
    } catch {
      // 非管理员或后端异常时静默，不影响设置页其余区块
    }
  }, []);

  useEffect(() => {
    loadKvSettings();
  }, [loadKvSettings]);

  /** 2FA 状态与在线会话（安全卡） */
  interface SessionItem {
    id: string;
    username: string;
    createdAt: number;
    expiresAt: number;
    ip: string;
    userAgent: string;
    current: boolean;
  }
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  const loadSecurity = useCallback(async () => {
    try {
      const [st, ss] = await Promise.all([
        get<{ enabled: boolean }>('/api/system/totp/status'),
        get<{ sessions: SessionItem[] }>('/api/auth/sessions'),
      ]);
      setTotpEnabled(!!st?.enabled);
      setSessions(ss?.sessions || []);
    } catch {
      // 静默：旧后端或会话失效时不影响其余区块
    }
  }, []);

  useEffect(() => {
    loadSecurity();
  }, [loadSecurity]);

  /** 生成 2FA 密钥（待确认） */
  async function handleTotpSetup() {
    try {
      setTotpSetup(await post<{ secret: string; uri: string }>('/api/system/totp/setup', {}));
    } catch (e: any) {
      showToast(e?.message || t('生成密钥失败'), 'error');
    }
  }

  /** 用首枚验证码确认启用 2FA */
  async function handleTotpEnable() {
    setTotpBusy(true);
    try {
      await post('/api/system/totp/enable', { code: totpCode });
      showToast(t('2FA 已启用'), 'success');
      setTotpSetup(null);
      setTotpCode('');
      loadSecurity();
    } catch (e: any) {
      showToast(e?.message || t('启用失败'), 'error');
    } finally {
      setTotpBusy(false);
    }
  }

  /** 关闭 2FA */
  async function handleTotpDisable() {
    setTotpBusy(true);
    try {
      await post('/api/system/totp/disable', { code: totpCode });
      showToast(t('2FA 已关闭'), 'success');
      setTotpCode('');
      loadSecurity();
    } catch (e: any) {
      showToast(e?.message || t('关闭失败'), 'error');
    } finally {
      setTotpBusy(false);
    }
  }

  /** 撤销会话（id 缺省 = 撤销除当前外的全部） */
  async function handleRevoke(id?: string) {
    try {
      const r = await post<{ revoked: number }>('/api/auth/sessions/revoke', id ? { id } : {});
      showToast(t('已撤销 {{n}} 个会话', { n: String(r?.revoked ?? 0) }), 'success');
      loadSecurity();
    } catch (e: any) {
      showToast(e?.message || t('撤销失败'), 'error');
    }
  }

  // 按用户 IP 白名单（管理员，内联编辑）
  const [ipEdits, setIpEdits] = useState<Record<string, string>>({});

  async function handleSaveIpAllowlist(name: string) {
    try {
      await put(`/api/system/users/${encodeURIComponent(name)}/ip-allowlist`, {
        allowlist: ipEdits[name] ?? '',
      });
      showToast(t('已保存 {{name}} 的 IP 白名单', { name }), 'success');
      load();
    } catch (e: any) {
      showToast(e?.message || t('保存失败'), 'error');
    }
  }

  /** 保存配置中心编辑项（仅提交有改动的键） */
  async function handleSaveKv() {
    const payload: Record<string, string> = {};
    for (const item of kvItems) {
      if (item.readonly) continue;
      const edited = kvEdits[item.key];
      if (edited === undefined) continue;
      payload[item.key] = edited;
    }
    if (!Object.keys(payload).length) {
      showToast(t('没有需要保存的修改'), 'error');
      return;
    }
    setKvSaving(true);
    try {
      await put('/api/settings', payload);
      showToast(t('系统参数已保存'));
      loadKvSettings();
    } catch (e: any) {
      showToast(e?.message || t('保存失败'), 'error');
    } finally {
      setKvSaving(false);
    }
  }

  /** 恢复某项设置为默认（清除落库值，回退 env/default） */
  async function handleResetKv(item: SettingItem) {
    try {
      await del(`/api/settings/${encodeURIComponent(item.key)}`);
      showToast(t('{{v1}} 已恢复默认', { v1: item.label }));
      loadKvSettings();
    } catch (e: any) {
      showToast(e?.message || t('恢复默认失败'), 'error');
    }
  }

  /**
   * 检查 GitHub Releases 获取最新版本
   */
  async function handleCheckUpdate() {
    setCheckingUpdate(true);
    try {
      const info = await get<UpdateInfo>('/api/system/update/check');
      setUpdateInfo(info);
    } catch (e: any) {
      setUpdateInfo({ available: false, error: e?.message || t('检查失败') });
    } finally {
      setCheckingUpdate(false);
    }
  }

  /**
   * 新增用户
   */
  async function handleCreateUser() {
    if (currentRole !== 'admin') {
      showToast(t('仅管理员可创建用户'), 'error');
      return;
    }
    if (!newUsername.trim()) {
      showToast(t('请输入用户名'), 'error');
      return;
    }
    if (newPassword.length < 6) {
      showToast(t('密码至少 6 位'), 'error');
      return;
    }
    setCreating(true);
    try {
      await post('/api/system/users', { username: newUsername.trim(), password: newPassword, role: newRole });
      showToast(t('用户已创建'));
      setNewUsername('');
      setNewPassword('');
      load();
    } catch (e: any) {
      showToast(e?.message || t('创建用户失败'), 'error');
    } finally {
      setCreating(false);
    }
  }

  /**
   * 删除用户
   * @param username 用户名
   */
  async function handleDeleteUser(username: string) {
    if (currentRole !== 'admin') {
      showToast(t('仅管理员可删除用户'), 'error');
      return;
    }
    if (username === currentUser) {
      showToast(t('不能删除当前登录用户'), 'error');
      return;
    }
    try {
      await del(`/api/system/users/${encodeURIComponent(username)}`);
      showToast(t('用户已删除'));
      load();
    } catch (e: any) {
      showToast(e?.message || t('删除用户失败'), 'error');
    }
  }

  /** 新建/编辑角色：切换编辑器（name 为空串表示新建） */
  function beginCreateRole() {
    setRoleEditing({ name: '', permissions: [] });
  }
  function beginEditRole(r: RoleInfo) {
    setRoleEditing({ name: r.name, permissions: [...r.permissions] });
  }
  function toggleRolePerm(key: string, checked: boolean) {
    setRoleEditing((prev) => {
      if (!prev) return prev;
      const perms = checked
        ? [...prev.permissions, key]
        : prev.permissions.filter((k) => k !== key);
      return { ...prev, permissions: perms };
    });
  }

  /** 保存角色（存在即更新，否则创建） */
  async function handleSaveRole() {
    if (!roleEditing) return;
    if (!roleEditing.name.trim()) {
      showToast(t('请输入角色名'), 'error');
      return;
    }
    setRoleSaving(true);
    try {
      if (roles.some((r) => r.name === roleEditing.name)) {
        await put(`/api/roles/${encodeURIComponent(roleEditing.name)}`, {
          permissions: roleEditing.permissions,
        });
        showToast(t('角色权限已更新'));
      } else {
        await post('/api/roles', { name: roleEditing.name.trim(), permissions: roleEditing.permissions });
        showToast(t('角色已创建'));
      }
      setRoleEditing(null);
      load();
    } catch (e: any) {
      showToast(e?.message || t('保存角色失败'), 'error');
    } finally {
      setRoleSaving(false);
    }
  }

  /** 删除自定义角色 */
  async function handleDeleteRole(name: string) {
    try {
      await del(`/api/roles/${encodeURIComponent(name)}`);
      showToast(t('角色已删除'));
      load();
    } catch (e: any) {
      showToast(e?.message || t('删除角色失败'), 'error');
    }
  }

  // 数据备份：下载 SQLite 数据库文件
  const [backingUp, setBackingUp] = useState(false);
  async function handleBackup() {
    if (currentRole !== 'admin') {
      showToast(t('仅管理员可导出备份'), 'error');
      return;
    }
    setBackingUp(true);
    try {
      await download('/api/system/backup', 'docker-manager-backup.db');
      showToast(t('数据库备份已导出'));
    } catch (e: any) {
      showToast(e?.message || t('备份失败'), 'error');
    } finally {
      setBackingUp(false);
    }
  }

  // 数据恢复：选择 db 备份文件上传替换
  const [restoreInput, setRestoreInput] = useState<HTMLInputElement | null>(null);
  const [restoring, setRestoring] = useState(false);
  async function handleRestoreFile(file: File) {
    if (currentRole !== 'admin') {
      showToast(t('仅管理员可恢复数据'), 'error');
      return;
    }
    if (!file) return;
    const confirmed = window.confirm(
      t('确定要使用 "{{v1}}" 恢复数据吗？\n将覆盖当前全部用户与面板数据，此操作不可撤销。', { v1: file.name }),
    );
    if (!confirmed) return;
    setRestoring(true);
    try {
      const buffer = await file.arrayBuffer();
      const res = await fetch('/api/system/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${getToken()}`,
        },
        body: buffer,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || t('恢复失败'));
      }
      showToast(t('数据库恢复成功，共 {{v1}} 个用户', { v1: data?.users ?? '?' }));
      // 恢复后重新加载页面数据
      load();
      setTimeout(() => {
        if (window.confirm(t('恢复成功，是否立即刷新页面以应用数据？'))) {
          window.location.reload();
        }
      }, 500);
    } catch (e: any) {
      showToast(e?.message || t('恢复失败'), 'error');
    } finally {
      setRestoring(false);
      if (restoreInput) restoreInput.value = '';
    }
  }

  /**
   * 修改当前用户密码
   */
  async function handleChangePassword() {
    if (!currentUser) {
      showToast(t('未获取到当前用户'), 'error');
      return;
    }
    if (!oldPassword) {
      showToast(t('请输入原密码'), 'error');
      return;
    }
    if (chgPassword.length < 6) {
      showToast(t('新密码至少 6 位'), 'error');
      return;
    }
    setChanging(true);
    try {
      await post('/api/system/password', {
        username: currentUser,
        oldPassword,
        newPassword: chgPassword,
      });
      showToast(t('密码已修改'));
      setOldPassword('');
      setChgPassword('');
      // 若处于强制改密模式，改密成功后解除
      setForceChange(false);
    } catch (e: any) {
      showToast(e?.message || t('修改密码失败'), 'error');
    } finally {
      setChanging(false);
    }
  }

  // ===================== 配置导入/导出 =====================
  // 权限判定：以服务端权威角色为准（管理员可导出/导入配置）
  const { canManage: cfgCanManage } = useCanManage();

  // 导出弹窗：是否包含敏感字段（通知渠道密钥、云端/数据库口令明文）
  const [exportOpen, setExportOpen] = useState(false);
  const [exportIncludeSecrets, setExportIncludeSecrets] = useState(false);
  const [exporting, setExporting] = useState(false);

  // 导入弹窗
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importTextError, setImportTextError] = useState('');
  const [conflict, setConflict] = useState<ConfigImportConflict>('overwrite');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<SystemConfigImportResponse | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  /**
   * 构造配置导出的 JSON 文件名，形如 config-YYYYMMDD-HHmmss.json
   * @returns 下载文件名
   */
  function configFileName(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `config-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
      d.getHours(),
    )}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  }

  /**
   * 触发浏览器下载：将 JSON 对象序列化为字符串后生成 Blob 并下载
   * @param obj 待下载的 JSON 对象
   * @param filename 文件名
   */
  function downloadJson(obj: unknown, filename: string) {
    const str = JSON.stringify(obj, null, 2);
    const blob = new Blob([str], { type: 'application/json;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  /**
   * 执行配置导出：拉取后端导出 JSON 并下载为文件
   */
  async function handleExport() {
    if (!cfgCanManage) {
      showToast(t('仅管理员可导出配置'), 'error');
      return;
    }
    setExporting(true);
    try {
      const data = await get<SystemConfigExport>('/api/system/config/export', {
        includeSecrets: exportIncludeSecrets ? 1 : 0,
      });
      if (!data) throw new Error(t('导出数据为空'));
      downloadJson(data, configFileName());
      showToast(t('配置已导出'));
      setExportOpen(false);
    } catch (e: any) {
      showToast(e?.message || t('导出失败'), 'error');
    } finally {
      setExporting(false);
    }
  }

  /**
   * 打开导入弹窗（重置表单与结果）
   */
  function openImport() {
    if (!cfgCanManage) {
      showToast(t('仅管理员可导入配置'), 'error');
      return;
    }
    setImportText('');
    setImportTextError('');
    setConflict('overwrite');
    setImportResult(null);
    setImportOpen(true);
  }

  /**
   * 读取用户选择的 JSON 文件并填入导入文本域
   * @param file 选中的 json 文件
   */
  async function handleImportFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      setImportText(text);
      setImportTextError('');
    } catch {
      setImportTextError(t('读取文件失败，请重试'));
    }
  }

  /**
   * 解析导入文本（校验 JSON 合法性）
   * @returns 解析出的配置对象；无法解析时返回 null 并设置错误提示
   */
  function parseImportText(): Record<string, any> | null {
    setImportTextError('');
    try {
      const obj = JSON.parse(importText);
      // 兼容完整导出对象（含 data 字段）与 data 子对象两种结构
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj;
      }
      setImportTextError(t('JSON 必须是对象（完整导出或 data 子对象）'));
      return null;
    } catch {
      setImportTextError(t('JSON 格式不正确，请检查后重试'));
      return null;
    }
  }

  /**
   * 提交配置导入：校验弹窗内容后调用导入接口
   */
  async function handleImportSubmit() {
    if (!cfgCanManage) {
      showToast(t('仅管理员可导入配置'), 'error');
      return;
    }
    if (!importText.trim()) {
      setImportTextError(t('请粘贴 JSON 或选择 JSON 文件'));
      return;
    }
    const parsed = parseImportText();
    if (!parsed) return;

    const strategyText = conflict === 'skip' ? t('跳过已存在') : conflict === 'overwrite' ? t('覆盖已存在') : t('出错即回滚');
    const confirmed = window.confirm(
      t('导入将写入/覆盖面板配置（冲突策略：{{strategy}}）。\n若来源导出为脱敏版本，敏感字段（通知渠道密钥、云端/数据库口令）将为占位空值，需在导入后重新填写。确定继续？', { strategy: strategyText }),
    );
    if (!confirmed) return;

    setImporting(true);
    try {
      const res = await post<SystemConfigImportResponse>('/api/system/config/import', {
        config: parsed,
        conflict,
      });
      setImportResult(res);
      showToast(t('配置导入成功'));
    } catch (e: any) {
      showToast(e?.message || t('导入失败'), 'error');
    } finally {
      setImporting(false);
    }
  }

  const engineEl = settings?.engine ? (
    <table className="settings-table">
      <tbody>
        <tr>
          <td>{t('主机名')}</td>
          <td>{settings.engine.name || '-'}</td>
        </tr>
        <tr>
          <td>{t('操作系统')}</td>
          <td>{settings.engine.os || '-'}</td>
        </tr>
        <tr>
          <td>{t('架构')}</td>
          <td>{settings.engine.arch || '-'}</td>
        </tr>
        <tr>
          <td>{t('CPU 核数')}</td>
          <td>{settings.engine.cpu ?? '-'}</td>
        </tr>
        <tr>
          <td>{t('内存')}</td>
          <td>{formatBytes(settings.engine.mem)}</td>
        </tr>
        <tr>
          <td>{t('Docker 版本')}</td>
          <td>{settings.engine.dockerVersion || '-'}</td>
        </tr>
        <tr>
          <td>{t('API 版本')}</td>
          <td>{settings.engine.apiVersion || '-'}</td>
        </tr>
        <tr>
          <td>{t('容器总数')}</td>
          <td>{settings.engine.containers ?? '-'}</td>
        </tr>
        <tr>
          <td>{t('运行中容器')}</td>
          <td>{settings.engine.running ?? '-'}</td>
        </tr>
        <tr>
          <td>{t('镜像数')}</td>
          <td>{settings.engine.images ?? '-'}</td>
        </tr>
      </tbody>
    </table>
  ) : (
    <div className="settings-empty">{t('无法获取 Docker 引擎信息（引擎可能未连接）。')}</div>
  );

  if (loading) {
    return <div className="settings-page">{t('加载中...')}</div>;
  }

  return (
    <div className="settings-page">
      {/* 账号管理 */}
      <Card title={t('账号管理')}>
        <table className="settings-table">
          <thead>
            <tr>
              <th>{t('用户名')}</th>
              <th>{t('角色')}</th>
              <th>{t('IP 白名单')}</th>
              <th>{t('创建时间')}</th>
              <th style={{ width: 100 }}>{t('操作')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username}>
                <td>
                  {u.username}
                  {u.username === currentUser ? (
                    <span className="settings-current">{t('当前')}</span>
                  ) : null}
                </td>
                {/* 角色列：内置角色显示中文名，自定义角色显示角色名 */}
                <td>{t(roleLabel(u.role))}</td>
                {/* IP 白名单：内联编辑（管理员），空 = 回退全局白名单 */}
                <td>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Input
                      type="text"
                      value={ipEdits[u.username] ?? ''}
                      placeholder={t('如 192.168.1.0/24，留空不限制')}
                      onChange={(e) => setIpEdits({ ...ipEdits, [u.username]: e.target.value })}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSaveIpAllowlist(u.username)}
                      disabled={u.username === currentUser}
                    >
                      {t('保存')}
                    </Button>
                  </div>
                </td>
                <td>{formatDate(u.createdAt)}</td>
                <td>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteUser(u.username)}
                    disabled={u.username === currentUser}
                  >
                    {t('删除')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 新增用户 */}
        <div className="settings-section">
          <div className="settings-section__title">{t('新增用户')}</div>
          <div className="settings-form">
            <Field label={t('用户名')} required>
              <Input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={t('请输入用户名')}
              />
            </Field>
            <Field label={t('密码')} required>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('至少 6 位')}
                disabled={currentRole !== 'admin'}
              />
            </Field>
            <Field label={t('角色')}>
              <select className="settings-select" value={newRole} onChange={(e) => setNewRole(e.target.value)} disabled={currentRole !== 'admin'}>
                {roles.map((r) => (
                  <option key={r.name} value={r.name}>{t(roleLabel(r.name))}</option>
                ))}
              </select>
            </Field>
            <div className="settings-form__actions">
              <Button variant="primary" size="sm" onClick={handleCreateUser} loading={creating}>
                {t('创建用户')}
              </Button>
            </div>
          </div>
        </div>

        {/* 修改密码 */}
        {forceChange && (
          <div className="settings-force-banner">
            <strong>{t('请设置新密码')}</strong> {t('当前仍在使用默认密码，为安全起见请修改后再继续操作。')}
          </div>
        )}
        <div className="settings-section">
          <div className="settings-section__title">{t('修改当前用户密码')}</div>
          <div className="settings-form">
            <Field label={t('原密码')}>
              <Input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder={t('请输入原密码')}
              />
            </Field>
            <Field label={t('新密码')} required>
              <Input
                type="password"
                value={chgPassword}
                onChange={(e) => setChgPassword(e.target.value)}
                placeholder={t('至少 6 位')}
              />
            </Field>
            <div className="settings-form__actions">
              <Button variant="primary" size="sm" onClick={handleChangePassword} loading={changing}>
                {t('修改密码')}
              </Button>
            </div>
          </div>
        </div>
        {/* 安全加固：2FA + 会话管理 */}
        <div className="settings-section">
          <div className="settings-section__title">{t('两步验证（2FA）')}</div>
          {totpEnabled === null ? (
            <div className="settings-hint">{t('加载中…')}</div>
          ) : totpEnabled ? (
            <div className="settings-form">
              <div className="settings-hint">{t('当前账号已启用 2FA，登录时需输入认证器验证码。')}</div>
              <Field label={t('验证码')}>
                <Input
                  type="text"
                  value={totpCode}
                  maxLength={6}
                  placeholder={t('6 位数字验证码')}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
              <div className="settings-form__actions">
                <Button variant="danger" size="sm" loading={totpBusy} onClick={handleTotpDisable}>
                  {t('关闭 2FA')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="settings-form">
              <div className="settings-hint">
                {t('使用 Google Authenticator 等认证器 App 扫码或手动录入密钥，启用后登录需输入验证码。')}
              </div>
              {!totpSetup ? (
                <div className="settings-form__actions">
                  <Button variant="primary" size="sm" onClick={handleTotpSetup}>
                    {t('生成密钥')}
                  </Button>
                </div>
              ) : (
                <>
                  <Field label={t('密钥（手动录入用）')}>
                    <Input type="text" value={totpSetup.secret} readOnly />
                  </Field>
                  <div className="settings-hint">{totpSetup.uri}</div>
                  <Field label={t('首枚验证码')} required>
                    <Input
                      type="text"
                      value={totpCode}
                      maxLength={6}
                      placeholder={t('6 位数字验证码')}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                    />
                  </Field>
                  <div className="settings-form__actions">
                    <Button variant="primary" size="sm" loading={totpBusy} onClick={handleTotpEnable}>
                      {t('确认启用')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setTotpSetup(null)}>
                      {t('取消')}
                    </Button>
                  </div>
                </>
              )}
          </div>
          )}
        </div>
        <div className="settings-section">
          <div className="settings-section__title">
            {t('在线会话')}
            <Button variant="ghost" size="sm" style={{ marginLeft: 12 }} onClick={() => handleRevoke()}>
              {t('撤销其他会话')}
            </Button>
          </div>
          <table className="settings-table">
            <thead>
              <tr>
                <th>{t('会话 ID')}</th>
                <th>{t('用户')}</th>
                <th>{t('IP')}</th>
                <th>{t('登录时间')}</th>
                <th>{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <code>{s.id}</code>
                    {s.current && (
                      <span className="settings-hint" style={{ marginLeft: 6 }}>
                        ({t('当前')})
                      </span>
                    )}
                  </td>
                  <td>{s.username}</td>
                  <td>{s.ip || '-'}</td>
                  <td>{formatDate(s.createdAt)}</td>
                  <td>
                    {!s.current && (
                      <Button variant="ghost" size="sm" onClick={() => handleRevoke(s.id)}>
                        {t('撤销')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={5}>{t('暂无在线会话')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* 角色管理（RBAC） */}
      <Card title={t('角色管理')}>
        <div className="settings-section">
          <div className="settings-section__title">
            {t('角色列表')}
            {currentRole === 'admin' && (
              <Button variant="primary" size="sm" style={{ marginLeft: 12 }} onClick={beginCreateRole}>
                {t('新建角色')}
              </Button>
            )}
          </div>
          <table className="settings-table">
            <thead>
              <tr>
                <th>{t('角色名')}</th>
                <th>{t('类型')}</th>
                <th>{t('权限')}</th>
                <th>{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.name}>
                  <td>{t(roleLabel(r.name))}</td>
                  <td>{r.system ? t('内置') : t('自定义')}</td>
                  <td>
                    {r.permissions.includes('*')
                      ? t('全部权限')
                      : r.permissions.length === 0
                        ? t('只读')
                        : t('{{v1}} 项：{{v2}}', { v1: r.permissions.length, v2: r.permissions.join('、') })}
                  </td>
                  <td>
                    {currentRole === 'admin' && (r.system ? r.name === 'operator' : true) ? (
                      <span>
                        <Button variant="ghost" size="sm" onClick={() => beginEditRole(r)}>
                          {t('编辑')}
                        </Button>
                        {!r.system && (
                          <Button variant="ghost" size="sm" onClick={() => handleDeleteRole(r.name)}>
                            {t('删除')}
                          </Button>
                        )}
                      </span>
                    ) : (
                      <span className="settings-current">{t('固定')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 角色编辑器 */}
        {roleEditing && (
          <div className="settings-section">
            <div className="settings-section__title">
              {roles.some((r) => r.name === roleEditing.name) ? t('编辑角色：{{v1}}', { v1: roleLabel(roleEditing.name) }) : t('新建角色')}
            </div>
            <div className="settings-form">
              <Field label={t('角色名')} required>
                <Input
                  value={roleEditing.name}
                  placeholder={t('2-40 位中英文、数字、下划线或连字符')}
                  disabled={roles.some((r) => r.name === roleEditing.name)}
                  onChange={(e) => setRoleEditing((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                />
              </Field>
              {Array.from(new Set(permCatalog.map((p) => p.group))).map((group) => (
                <Field key={group} label={group}>
                  <div className="settings-kv" style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {permCatalog
                      .filter((p) => p.group === group)
                      .map((p) => (
                        <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={roleEditing.permissions.includes(p.key)}
                            onChange={(e) => toggleRolePerm(p.key, e.target.checked)}
                          />
                          {p.label}
                        </label>
                      ))}
                  </div>
                </Field>
              ))}
              <div className="settings-form__actions">
                <Button variant="primary" size="sm" loading={roleSaving} onClick={handleSaveRole}>
                  {t('保存角色')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRoleEditing(null)}>
                  {t('取消')}
                </Button>
              </div>
            </div>
          </div>
        )}
        <p className="settings-backup__desc">
          {t('说明：角色权限仅作用于资源管理域（容器 / 镜像 / 卷 / 网络 / 编排）；用户管理、系统设置、引擎切换等系统级操作始终需要管理员。')}
          {t('若开启「高危操作审批流」，未获授权的角色可提交审批，由管理员批准后执行。')}
        </p>
      </Card>

      {/* 数据备份与恢复 */}
      <Card title={t('数据备份与恢复')}>
        <div className="settings-section">
          <div className="settings-section__title">{t('数据库备份')}</div>
          <div className="settings-backup">
            <p className="settings-backup__desc">
              {t('备份面板数据（用户、镜像源、操作日志等），导出为 SQLite 数据库文件。')}
            </p>
            <div className="settings-backup__actions">
              <Button variant="primary" size="sm" onClick={handleBackup} loading={backingUp} disabled={currentRole !== 'admin'}>
                {t('导出备份')}
              </Button>
            </div>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section__title">{t('恢复备份')}</div>
          <div className="settings-backup">
            <p className="settings-backup__desc">
              {t('从备份文件恢复面板数据。注意：恢复会覆盖当前全部数据，且需刷新页面后生效。')}
            </p>
            <div className="settings-backup__actions">
              <Button variant="danger" size="sm" loading={restoring} onClick={() => restoreInput?.click()} disabled={currentRole !== 'admin'}>
                {restoring ? t('恢复中…') : t('选择备份文件并恢复')}
              </Button>
              <input
                ref={(el) => setRestoreInput(el)}
                type="file"
                accept=".db,.sqlite,.backup"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleRestoreFile(f);
                }}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* 面板数据库备份管理（服务端快照） */}
      {currentRole === 'admin' && (
        <Card title={t('面板数据库备份管理')}>
          <p className="settings-backup__desc">
            {t('对面板自身数据库做一致性快照（保存在数据目录 db-backups/ 下），支持一键恢复；保留份数由系统参数「面板数据库备份保留份数」控制，')}
            {t('也可在计划任务中新建「数据库备份」类型实现定时自动备份。')}
          </p>
          <div className="settings-backup__actions" style={{ marginBottom: 12 }}>
            <Button variant="primary" size="sm" onClick={handleSqliteBackup} loading={dbBackupBusy}>
              {t('立即备份')}
            </Button>
          </div>
          {dbBackups.length > 0 ? (
            <table className="settings-table">
              <thead>
                <tr>
                  <th>{t('备份文件')}</th>
                  <th style={{ width: '14%' }}>{t('大小')}</th>
                  <th style={{ width: '22%' }}>{t('时间')}</th>
                  <th style={{ width: '26%' }}>{t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {dbBackups.map((b) => (
                  <tr key={b.file}>
                    <td style={{ wordBreak: 'break-all' }}>{b.file}</td>
                    <td>{(b.size / 1024).toFixed(0)} KB</td>
                    <td>{formatDate(b.createdAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <Button variant="primary" size="sm" disabled={dbBackupBusy} onClick={() => handleSqliteRestore(b.file)}>
                          {t('恢复')}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => download(`/api/sqlite-backups/${encodeURIComponent(b.file)}/download`, b.file)}
                        >
                          {t('下载')}
                        </Button>
                        <Button variant="danger" size="sm" disabled={dbBackupBusy} onClick={() => handleSqliteDelete(b.file)}>
                          {t('删除')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="settings-backup__desc">{t('暂无备份文件。')}</p>
          )}
        </Card>
      )}

      {/* 配置导入/导出 */}
      <Card title={t('配置导入导出')}>
        <p className="settings-backup__desc">
          {t('以 JSON 格式导出/导入面板配置（引擎/模板/计划任务/站点/告警/通知渠道/云端备份/数据库实例/镜像源/设置/账号），')}
          {t('用于迁移到另一台机器；与"数据备份与恢复"（全库二进制快照）互补。')}
        </p>
        <div className="settings-backup__actions">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setExportOpen(true)}
            disabled={!cfgCanManage}
          >
            {t('导出配置')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={openImport}
            disabled={!cfgCanManage}
          >
            {t('导入配置')}
          </Button>
        </div>
      </Card>

      {/* 系统参数（配置中心） */}
      {kvItems.length > 0 && (
        <Card title={t('系统参数')}>
          {(['runtime', 'security', 'retention', 'notification', 'general'] as SettingItem['group'][])
            .map((group) => ({ group, items: kvItems.filter((s) => s.group === group) }))
            .filter((g) => g.items.length > 0)
            .map(({ group, items }) => (
              <div className="settings-section" key={group}>
                <div className="settings-section__title">{t(KV_GROUP_LABELS[group])}</div>
                {items.map((item) => (
                  <div className="settings-kv" key={item.key}>
                    <div className="settings-kv__info">
                      <div className="settings-kv__label">
                        {item.label}
                        {item.source === 'db' && <span className="settings-kv__badge">{t('自定义')}</span>}
                        {item.readonly && <span className="settings-kv__badge settings-kv__badge--muted">{t('只读')}</span>}
                      </div>
                      {item.hint && <div className="settings-kv__hint">{item.hint}</div>}
                    </div>
                    <div className="settings-kv__control">
                      {item.type === 'secret' ? (
                        <span className="settings-kv__value">{item.configured ? t('已配置') : t('未配置')}</span>
                      ) : (
                        <Input
                          className="settings-kv__input"
                          value={
                            kvEdits[item.key] ??
                            (item.value === undefined || item.value === null ? '' : String(item.value))
                          }
                          disabled={item.readonly || currentRole !== 'admin'}
                          onChange={(e) => setKvEdits((prev) => ({ ...prev, [item.key]: e.target.value }))}
                        />
                      )}
                      {currentRole === 'admin' && !item.readonly && (
                        <Button variant="ghost" size="sm" onClick={() => handleResetKv(item)}>
                          {t('恢复默认')}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          {currentRole === 'admin' && (
            <div className="settings-backup__actions">
              <Button variant="primary" size="sm" onClick={handleSaveKv} loading={kvSaving}>
                {t('保存修改')}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* 关于 / 引擎信息 */}
      <Card title={t('关于')}>
        <div className="settings-info">
          <div className="settings-info__row">
            <span>{t('面板版本')}</span>
            <span>
              v{settings?.version || '-'}
              {updateInfo?.available && (
                <span style={{ marginLeft: 8, color: '#f59e0b', fontSize: 12 }}>
                  {t('(最新版 v')}{updateInfo.latest})
                </span>
              )}
            </span>
          </div>
          <div className="settings-info__row">
            <span>{t('服务端口')}</span>
            <span>{settings?.port ?? '-'}</span>
          </div>
          <div className="settings-info__row">
            <span>{t('更新检查')}</span>
            <span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCheckUpdate}
                loading={checkingUpdate}
              >
                {updateInfo?.available ? t('有新版本可用') : updateInfo ? t('已是最新版') : t('检查更新')}
              </Button>
              {updateInfo?.available && updateInfo.releaseUrl && (
                <a
                  href={updateInfo.releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ marginLeft: 8, fontSize: 12, color: '#3b82f6' }}
                >
                  {t('前往下载')}
                </a>
              )}
              {updateInfo?.error && (
                <span style={{ marginLeft: 8, fontSize: 12, color: '#9ca3af' }}>
                  {updateInfo.error}
                </span>
              )}
            </span>
          </div>
          {updateInfo?.available && (updateInfo.assets?.length || 0) > 0 && (
            <div className="settings-info__row" style={{ alignItems: 'flex-start' }}>
              <span>{t('更新包')}</span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                {(updateInfo.assets || []).map((a) => (
                  <a
                    key={a.name}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 12, color: '#3b82f6', wordBreak: 'break-all' }}
                  >
                    {a.name}（{Math.round(a.size / 1024 / 1024 * 10) / 10} MB）
                  </a>
                ))}
              </span>
            </div>
          )}
          {updateInfo?.available && updateInfo.notes && (
            <div className="settings-info__row" style={{ alignItems: 'flex-start' }}>
              <span>{t('更新说明')}</span>
              <span style={{ fontSize: 12, opacity: 0.75, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 160, overflow: 'auto', maxWidth: 480 }}>
                {updateInfo.notes}
              </span>
            </div>
          )}
        </div>

        {/* 外观 / 主题切换 */}
        <div className="settings-section">
          <div className="settings-section__title">{t('外观')}</div>
          <div className="settings-theme">
            <span className="settings-theme__label">
              {t('当前主题：')}{theme === 'dark' ? t('深色') : t('浅色')}
            </span>
            <div className="settings-theme__actions">
              <Button
                variant={theme === 'light' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setTheme('light')}
              >
                {t('浅色')}
              </Button>
              <Button
                variant={theme === 'dark' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setTheme('dark')}
              >
                {t('深色')}
              </Button>
            </div>
          </div>
        </div>

        {/* 界面语言切换 */}
        <div className="settings-section">
          <div className="settings-section__title">{t('界面语言')}</div>
          <div className="settings-theme">
            <span className="settings-theme__label">
              {t('当前语言：{{v}}', { v: lang === 'zh' ? t('中文') : 'English' })}
            </span>
            <div className="settings-theme__actions">
              <Button
                variant={lang === 'zh' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setLang('zh')}
              >
                {t('中文')}
              </Button>
              <Button
                variant={lang === 'en' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setLang('en')}
              >
                English
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card title={t('Docker 引擎信息')}>{engineEl}</Card>

      {/* 导出配置弹窗：选择是否包含敏感字段 */}
      <Modal
        open={exportOpen}
        title={t('导出面板配置')}
        onClose={() => setExportOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)} disabled={exporting}>
              {t('取消')}
            </Button>
            <Button variant="primary" onClick={handleExport} loading={exporting}>
              {t('导出')}
            </Button>
          </>
        }
      >
        <div className="settings-config">
          <div className="settings-config__row">
            <label className="settings-config__checkbox">
              <input
                type="checkbox"
                checked={exportIncludeSecrets}
                onChange={(e) => setExportIncludeSecrets(e.target.checked)}
                disabled={exporting}
              />
              <span>{t('包含敏感字段')}</span>
            </label>
            {exportIncludeSecrets && (
              <p className="settings-config__warn">
                {t('注意：选择后将把通知渠道密钥、云端备份口令、数据库口令以')}<b>{t('明文')}</b>{t('写入导出文件，请妥善保管。')}
              </p>
            )}
            {!exportIncludeSecrets && (
              <p className="settings-config__hint">
                {t('不包含敏感字段时，相关口令会以"已设置"占位导出（无明文），导入后需重新填写。')}
              </p>
            )}
          </div>
        </div>
      </Modal>

      {/* 导入配置弹窗：粘贴/选择 JSON + 冲突策略 + 结果 */}
      <Modal
        open={importOpen}
        title={t('导入面板配置')}
        onClose={() => setImportOpen(false)}
        width={600}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)} disabled={importing}>
              {t('关闭')}
            </Button>
            <Button variant="danger" onClick={handleImportSubmit} loading={importing} disabled={!cfgCanManage}>
              {t('导入')}
            </Button>
          </>
        }
      >
        <div className="settings-config">
          <div className="settings-config__row">
            <Button variant="ghost" size="sm" onClick={() => importFileRef.current?.click()} disabled={importing}>
              {t('选择 JSON 文件')}
            </Button>
            <input
              ref={importFileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                handleImportFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <span className="settings-config__hint">{t('也可直接在下方粘贴 JSON 内容')}</span>
          </div>
          <Field label={t('配置 JSON')} error={importTextError} hint={importTextError ? undefined : t('支持完整导出对象（含 data 字段）或 data 子对象')}>
            <TextArea
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                setImportTextError('');
              }}
              error={!!importTextError}
              placeholder='{"version":1,"exportedAt":"...","includeSecrets":false,"data":{...}}'
              disabled={importing}
              style={{ minHeight: 180 }}
            />
          </Field>
          <Field label={t('冲突策略')}>
            <Select value={conflict} onChange={(e) => setConflict(e.target.value as ConfigImportConflict)} disabled={importing}>
              <option value="overwrite">{t('覆盖已存在')}</option>
              <option value="skip">{t('跳过已存在')}</option>
              <option value="error">{t('出错即回滚')}</option>
            </Select>
          </Field>
        </div>

        {/* 导入结果统计 */}
        {importResult && (
          <div className="settings-config__result">
            <div className="settings-config__result-title">{t('导入结果（策略：{{strategy}}）', { strategy: importResult.conflict === 'skip' ? t('跳过') : importResult.conflict === 'overwrite' ? t('覆盖') : t('出错回滚') })}</div>
            <div className="settings-config__result-grid">
              {Object.entries(importResult.imported || {}).map(([key, count]) => (
                <div className="settings-config__result-item" key={key}>
                  <span className="settings-config__result-label">{key}</span>
                  <span className="settings-config__result-count">{count}</span>
                </div>
              ))}
            </div>
            {importResult.note && <p className="settings-config__hint">{importResult.note}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}
