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
import { get, post, del, download } from '../api/client';
import { getToken, setRole, type UserRole } from '../api/auth';
import type {
  ConfigImportConflict,
  SystemConfigExport,
  SystemConfigImportResponse,
} from '../types';
import './settings.less';

interface UserItem {
  username: string;
  // 支持管理员 / 运维人员 / 普通用户三种角色
  role: 'admin' | 'operator' | 'user';
  createdAt: number;
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

interface CurrentUserInfo {
  username: string;
  role?: UserRole;
}

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

  // 新增用户表单
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'operator' | 'user'>('user');
  const [creating, setCreating] = useState(false);

  // 修改密码表单
  const [oldPassword, setOldPassword] = useState('');
  const [chgPassword, setChgPassword] = useState('');
  const [changing, setChanging] = useState(false);

  /**
   * 加载设置页数据
   */
  const load = useCallback(async () => {
    try {
      const [u, s, me] = await Promise.all([
        get<UserItem[]>('/api/system/users'),
        get<SettingsInfo>('/api/system/settings'),
        get<CurrentUserInfo>('/api/auth/me'),
      ]);
      const role = me.role || 'user';
      setUsers(u || []);
      setSettings(s);
      setCurrentUser(me.username || '');
      setCurrentRole(role);
      setRole(role);
    } catch (e: any) {
      showToast(e?.message || '加载设置失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 新增用户
   */
  async function handleCreateUser() {
    if (currentRole !== 'admin') {
      showToast('仅管理员可创建用户', 'error');
      return;
    }
    if (!newUsername.trim()) {
      showToast('请输入用户名', 'error');
      return;
    }
    if (newPassword.length < 6) {
      showToast('密码至少 6 位', 'error');
      return;
    }
    setCreating(true);
    try {
      await post('/api/system/users', { username: newUsername.trim(), password: newPassword, role: newRole });
      showToast('用户已创建');
      setNewUsername('');
      setNewPassword('');
      load();
    } catch (e: any) {
      showToast(e?.message || '创建用户失败', 'error');
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
      showToast('仅管理员可删除用户', 'error');
      return;
    }
    if (username === currentUser) {
      showToast('不能删除当前登录用户', 'error');
      return;
    }
    try {
      await del(`/api/system/users/${encodeURIComponent(username)}`);
      showToast('用户已删除');
      load();
    } catch (e: any) {
      showToast(e?.message || '删除用户失败', 'error');
    }
  }

  // 数据备份：下载 SQLite 数据库文件
  const [backingUp, setBackingUp] = useState(false);
  async function handleBackup() {
    if (currentRole !== 'admin') {
      showToast('仅管理员可导出备份', 'error');
      return;
    }
    setBackingUp(true);
    try {
      await download('/api/system/backup', 'docker-manager-backup.db');
      showToast('数据库备份已导出');
    } catch (e: any) {
      showToast(e?.message || '备份失败', 'error');
    } finally {
      setBackingUp(false);
    }
  }

  // 数据恢复：选择 db 备份文件上传替换
  const [restoreInput, setRestoreInput] = useState<HTMLInputElement | null>(null);
  const [restoring, setRestoring] = useState(false);
  async function handleRestoreFile(file: File) {
    if (currentRole !== 'admin') {
      showToast('仅管理员可恢复数据', 'error');
      return;
    }
    if (!file) return;
    const confirmed = window.confirm(
      `确定要使用 "${file.name}" 恢复数据吗？\n将覆盖当前全部用户与面板数据，此操作不可撤销。`,
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
        throw new Error(data?.error || '恢复失败');
      }
      showToast(`数据库恢复成功，共 ${data?.users ?? '?'} 个用户`);
      // 恢复后重新加载页面数据
      load();
      setTimeout(() => {
        if (window.confirm('恢复成功，是否立即刷新页面以应用数据？')) {
          window.location.reload();
        }
      }, 500);
    } catch (e: any) {
      showToast(e?.message || '恢复失败', 'error');
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
      showToast('未获取到当前用户', 'error');
      return;
    }
    if (!oldPassword) {
      showToast('请输入原密码', 'error');
      return;
    }
    if (chgPassword.length < 6) {
      showToast('新密码至少 6 位', 'error');
      return;
    }
    setChanging(true);
    try {
      await post('/api/system/password', {
        username: currentUser,
        oldPassword,
        newPassword: chgPassword,
      });
      showToast('密码已修改');
      setOldPassword('');
      setChgPassword('');
      // 若处于强制改密模式，改密成功后解除
      setForceChange(false);
    } catch (e: any) {
      showToast(e?.message || '修改密码失败', 'error');
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
      showToast('仅管理员可导出配置', 'error');
      return;
    }
    setExporting(true);
    try {
      const data = await get<SystemConfigExport>('/api/system/config/export', {
        includeSecrets: exportIncludeSecrets ? 1 : 0,
      });
      if (!data) throw new Error('导出数据为空');
      downloadJson(data, configFileName());
      showToast('配置已导出');
      setExportOpen(false);
    } catch (e: any) {
      showToast(e?.message || '导出失败', 'error');
    } finally {
      setExporting(false);
    }
  }

  /**
   * 打开导入弹窗（重置表单与结果）
   */
  function openImport() {
    if (!cfgCanManage) {
      showToast('仅管理员可导入配置', 'error');
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
      setImportTextError('读取文件失败，请重试');
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
      setImportTextError('JSON 必须是对象（完整导出或 data 子对象）');
      return null;
    } catch {
      setImportTextError('JSON 格式不正确，请检查后重试');
      return null;
    }
  }

  /**
   * 提交配置导入：校验弹窗内容后调用导入接口
   */
  async function handleImportSubmit() {
    if (!cfgCanManage) {
      showToast('仅管理员可导入配置', 'error');
      return;
    }
    if (!importText.trim()) {
      setImportTextError('请粘贴 JSON 或选择 JSON 文件');
      return;
    }
    const parsed = parseImportText();
    if (!parsed) return;

    const confirmed = window.confirm(
      '导入将写入/覆盖面板配置（冲突策略：' +
        (conflict === 'skip' ? '跳过已存在' : conflict === 'overwrite' ? '覆盖已存在' : '出错即回滚') +
        '）。\n若来源导出为脱敏版本，敏感字段（通知渠道密钥、云端/数据库口令）将为占位空值，需在导入后重新填写。确定继续？',
    );
    if (!confirmed) return;

    setImporting(true);
    try {
      const res = await post<SystemConfigImportResponse>('/api/system/config/import', {
        config: parsed,
        conflict,
      });
      setImportResult(res);
      showToast('配置导入成功');
    } catch (e: any) {
      showToast(e?.message || '导入失败', 'error');
    } finally {
      setImporting(false);
    }
  }

  const engineEl = settings?.engine ? (
    <table className="settings-table">
      <tbody>
        <tr>
          <td>主机名</td>
          <td>{settings.engine.name || '-'}</td>
        </tr>
        <tr>
          <td>操作系统</td>
          <td>{settings.engine.os || '-'}</td>
        </tr>
        <tr>
          <td>架构</td>
          <td>{settings.engine.arch || '-'}</td>
        </tr>
        <tr>
          <td>CPU 核数</td>
          <td>{settings.engine.cpu ?? '-'}</td>
        </tr>
        <tr>
          <td>内存</td>
          <td>{formatBytes(settings.engine.mem)}</td>
        </tr>
        <tr>
          <td>Docker 版本</td>
          <td>{settings.engine.dockerVersion || '-'}</td>
        </tr>
        <tr>
          <td>API 版本</td>
          <td>{settings.engine.apiVersion || '-'}</td>
        </tr>
        <tr>
          <td>容器总数</td>
          <td>{settings.engine.containers ?? '-'}</td>
        </tr>
        <tr>
          <td>运行中容器</td>
          <td>{settings.engine.running ?? '-'}</td>
        </tr>
        <tr>
          <td>镜像数</td>
          <td>{settings.engine.images ?? '-'}</td>
        </tr>
      </tbody>
    </table>
  ) : (
    <div className="settings-empty">无法获取 Docker 引擎信息（引擎可能未连接）。</div>
  );

  if (loading) {
    return <div className="settings-page">加载中...</div>;
  }

  return (
    <div className="settings-page">
      {/* 账号管理 */}
      <Card title="账号管理">
        <table className="settings-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>创建时间</th>
              <th style={{ width: 100 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username}>
                <td>
                  {u.username}
                  {u.username === currentUser ? (
                    <span className="settings-current">当前</span>
                  ) : null}
                </td>
                {/* 角色列：三态展示，operator 显示为运维人员 */}
                <td>{u.role === 'admin' ? '管理员' : u.role === 'operator' ? '运维人员' : '普通用户'}</td>
                <td>{formatDate(u.createdAt)}</td>
                <td>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteUser(u.username)}
                    disabled={u.username === currentUser}
                  >
                    删除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 新增用户 */}
        <div className="settings-section">
          <div className="settings-section__title">新增用户</div>
          <div className="settings-form">
            <Field label="用户名" required>
              <Input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="请输入用户名"
              />
            </Field>
            <Field label="密码" required>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 6 位"
                disabled={currentRole !== 'admin'}
              />
            </Field>
            <Field label="角色">
              <select className="settings-select" value={newRole} onChange={(e) => setNewRole(e.target.value as 'admin' | 'operator' | 'user')} disabled={currentRole !== 'admin'}>
                <option value="user">普通用户</option>
                <option value="operator">运维人员</option>
                <option value="admin">管理员</option>
              </select>
            </Field>
            <div className="settings-form__actions">
              <Button variant="primary" size="sm" onClick={handleCreateUser} loading={creating}>
                创建用户
              </Button>
            </div>
          </div>
        </div>

        {/* 修改密码 */}
        {forceChange && (
          <div className="settings-force-banner">
            <strong>请设置新密码</strong> 当前仍在使用默认密码，为安全起见请修改后再继续操作。
          </div>
        )}
        <div className="settings-section">
          <div className="settings-section__title">修改当前用户密码</div>
          <div className="settings-form">
            <Field label="原密码">
              <Input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="请输入原密码"
              />
            </Field>
            <Field label="新密码" required>
              <Input
                type="password"
                value={chgPassword}
                onChange={(e) => setChgPassword(e.target.value)}
                placeholder="至少 6 位"
              />
            </Field>
            <div className="settings-form__actions">
              <Button variant="primary" size="sm" onClick={handleChangePassword} loading={changing}>
                修改密码
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* 数据备份与恢复 */}
      <Card title="数据备份与恢复">
        <div className="settings-section">
          <div className="settings-section__title">数据库备份</div>
          <div className="settings-backup">
            <p className="settings-backup__desc">
              备份面板数据（用户、镜像源、操作日志等），导出为 SQLite 数据库文件。
            </p>
            <div className="settings-backup__actions">
              <Button variant="primary" size="sm" onClick={handleBackup} loading={backingUp} disabled={currentRole !== 'admin'}>
                导出备份
              </Button>
            </div>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section__title">恢复备份</div>
          <div className="settings-backup">
            <p className="settings-backup__desc">
              从备份文件恢复面板数据。注意：恢复会覆盖当前全部数据，且需刷新页面后生效。
            </p>
            <div className="settings-backup__actions">
              <Button variant="danger" size="sm" loading={restoring} onClick={() => restoreInput?.click()} disabled={currentRole !== 'admin'}>
                {restoring ? '恢复中…' : '选择备份文件并恢复'}
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

      {/* 配置导入/导出 */}
      <Card title="配置导入导出">
        <p className="settings-backup__desc">
          以 JSON 格式导出/导入面板配置（引擎/模板/计划任务/站点/告警/通知渠道/云端备份/数据库实例/镜像源/设置/账号），
          用于迁移到另一台机器；与"数据备份与恢复"（全库二进制快照）互补。
        </p>
        <div className="settings-backup__actions">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setExportOpen(true)}
            disabled={!cfgCanManage}
          >
            导出配置
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={openImport}
            disabled={!cfgCanManage}
          >
            导入配置
          </Button>
        </div>
      </Card>

      {/* 关于 / 引擎信息 */}
      <Card title="关于">
        <div className="settings-info">
          <div className="settings-info__row">
            <span>面板版本</span>
            <span>{settings?.version || '-'}</span>
          </div>
          <div className="settings-info__row">
            <span>服务端口</span>
            <span>{settings?.port ?? '-'}</span>
          </div>
        </div>

        {/* 外观 / 主题切换 */}
        <div className="settings-section">
          <div className="settings-section__title">外观</div>
          <div className="settings-theme">
            <span className="settings-theme__label">
              当前主题：{theme === 'dark' ? '深色' : '浅色'}
            </span>
            <div className="settings-theme__actions">
              <Button
                variant={theme === 'light' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setTheme('light')}
              >
                浅色
              </Button>
              <Button
                variant={theme === 'dark' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setTheme('dark')}
              >
                深色
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Docker 引擎信息">{engineEl}</Card>

      {/* 导出配置弹窗：选择是否包含敏感字段 */}
      <Modal
        open={exportOpen}
        title="导出面板配置"
        onClose={() => setExportOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)} disabled={exporting}>
              取消
            </Button>
            <Button variant="primary" onClick={handleExport} loading={exporting}>
              导出
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
              <span>包含敏感字段</span>
            </label>
            {exportIncludeSecrets && (
              <p className="settings-config__warn">
                注意：选择后将把通知渠道密钥、云端备份口令、数据库口令以<b>明文</b>写入导出文件，请妥善保管。
              </p>
            )}
            {!exportIncludeSecrets && (
              <p className="settings-config__hint">
                不包含敏感字段时，相关口令会以"已设置"占位导出（无明文），导入后需重新填写。
              </p>
            )}
          </div>
        </div>
      </Modal>

      {/* 导入配置弹窗：粘贴/选择 JSON + 冲突策略 + 结果 */}
      <Modal
        open={importOpen}
        title="导入面板配置"
        onClose={() => setImportOpen(false)}
        width={600}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)} disabled={importing}>
              关闭
            </Button>
            <Button variant="danger" onClick={handleImportSubmit} loading={importing} disabled={!cfgCanManage}>
              导入
            </Button>
          </>
        }
      >
        <div className="settings-config">
          <div className="settings-config__row">
            <Button variant="ghost" size="sm" onClick={() => importFileRef.current?.click()} disabled={importing}>
              选择 JSON 文件
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
            <span className="settings-config__hint">也可直接在下方粘贴 JSON 内容</span>
          </div>
          <Field label="配置 JSON" error={importTextError} hint={importTextError ? undefined : '支持完整导出对象（含 data 字段）或 data 子对象'}>
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
          <Field label="冲突策略">
            <Select value={conflict} onChange={(e) => setConflict(e.target.value as ConfigImportConflict)} disabled={importing}>
              <option value="overwrite">覆盖已存在</option>
              <option value="skip">跳过已存在</option>
              <option value="error">出错即回滚</option>
            </Select>
          </Field>
        </div>

        {/* 导入结果统计 */}
        {importResult && (
          <div className="settings-config__result">
            <div className="settings-config__result-title">导入结果（策略：{importResult.conflict === 'skip' ? '跳过' : importResult.conflict === 'overwrite' ? '覆盖' : '出错回滚'}）</div>
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
