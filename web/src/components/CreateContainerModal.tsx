/**
 * 创建容器弹窗 + 从模板创建弹窗
 *
 * 从容器列表页抽出（1.92.0 重构）：表单草稿、配置导入回填、模板选择、
 * 宿主机端口占用检测与提交创建，全部内聚到本组件。
 *
 * 调用方通过 seed 描述打开意图（空白表单 / 导入配置 / 应用模板 / 模板选择器），
 * seed 变化即按意图重置或回填表单；创建成功后回调 onCreated 通知刷新列表。
 */
import React, { useEffect, useRef, useState } from 'react';
import { get, post } from '../api/client';
import { canOperate } from '../api/auth';
import Button from './Button';
import Modal from './Modal';
import { Field, Input, Select } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

/** 创建表单中的端口映射条目 */
interface CreatePort {
  container: string;
  host: string;
  protocol: string;
}

/** 单端口占用检测结果（POST /api/containers/port-check 返回的单项） */
interface PortCheckResult {
  port: number;
  protocol?: string;
  containerOccupied: boolean;
  containerNames: string[];
  hostListening: boolean;
  busy: boolean;
}

/** 创建表单中的挂载卷条目 */
interface CreateVolume {
  source: string;
  target: string;
  readonly: boolean;
}

/** 创建表单中的环境变量条目 */
interface CreateEnv {
  key: string;
  value: string;
}

/** 容器模板项（对齐 /api/templates 返回结构） */
export interface TemplateItem {
  id: string;
  name: string;
  description: string;
  image: string;
  config: any;
  createdAt: number;
  updatedAt: number;
}

/** 打开意图：空白表单 / 导入的容器配置 / 直接应用模板 / 先选模板 */
export type CreateSeed =
  | { type: 'blank' }
  | { type: 'config'; cfg: any }
  | { type: 'template'; tpl: TemplateItem }
  | { type: 'template-picker' };

interface CreateContainerModalProps {
  /** null = 关闭；非空 = 按意图打开（每次传入新对象即重新执行） */
  seed: CreateSeed | null;
  onClose: () => void;
  /** 创建成功后通知调用方刷新容器列表 */
  onCreated: () => void;
}

/** 网络模式选项 */
const NETWORK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'default（默认）' },
  { value: 'bridge', label: 'bridge（桥接）' },
  { value: 'host', label: 'host（宿主机网络）' },
  { value: 'none', label: 'none（禁用网络）' },
];

/** 重启策略选项 */
const RESTART_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'no', label: 'no（不自动重启）' },
  { value: 'always', label: 'always（总是重启）' },
  { value: 'on-failure', label: 'on-failure（失败时重启）' },
  { value: 'unless-stopped', label: 'unless-stopped（除非停止）' },
];

export default function CreateContainerModal({ seed, onClose, onCreated }: CreateContainerModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // 基础字段草稿
  const [createName, setCreateName] = useState('');
  const [createImage, setCreateImage] = useState('');
  const [createCommand, setCreateCommand] = useState('');
  const [createNetworkMode, setCreateNetworkMode] = useState('default');
  const [createRestartPolicy, setCreateRestartPolicy] = useState('no');
  const [createTty, setCreateTty] = useState(false);
  // 导入配置的扩展字段（创建弹窗不展示，提交时随请求带上以完整还原）
  const [createEntrypoint, setCreateEntrypoint] = useState('');
  const [createUser, setCreateUser] = useState('');
  const [createWorkingDir, setCreateWorkingDir] = useState('');
  const [createHostname, setCreateHostname] = useState('');
  const [createPrivileged, setCreatePrivileged] = useState(false);
  const [createAutoRemove, setCreateAutoRemove] = useState(false);
  // 资源限制：内存上限(MB) / CPU 上限(毫核, 1000=1核)，空为不限制
  const [createMemLimit, setCreateMemLimit] = useState('');
  const [createCpuLimit, setCreateCpuLimit] = useState('');
  // 健康检查：命令(test) / 间隔(秒) / 超时(秒) / 重试次数
  const [createHealthCmd, setCreateHealthCmd] = useState('');
  const [createHealthInterval, setCreateHealthInterval] = useState('');
  const [createHealthTimeout, setCreateHealthTimeout] = useState('');
  const [createHealthRetries, setCreateHealthRetries] = useState('');
  // 端口 / 挂载 / 环境变量 列表草稿
  const [createPorts, setCreatePorts] = useState<CreatePort[]>([{ container: '', host: '', protocol: 'tcp' }]);
  const [createVolumes, setCreateVolumes] = useState<CreateVolume[]>([{ source: '', target: '', readonly: false }]);
  const [createEnvs, setCreateEnvs] = useState<CreateEnv[]>([{ key: '', value: '' }]);
  // 从模板创建弹窗状态
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateList, setTemplateList] = useState<TemplateItem[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateApplying, setTemplateApplying] = useState('');
  // 创建表单端口占用检测结果（key 为端口行 index）
  const [portChecks, setPortChecks] = useState<Record<number, PortCheckResult>>({});
  // 某行端口是否正在检测
  const [portCheckLoading, setPortCheckLoading] = useState<Record<number, boolean>>({});
  // 端口检测防抖定时器（按行 index 保存）
  const portCheckTimer = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  /** 重置表单全部草稿为空白 */
  function resetForm() {
    setCreateName('');
    setCreateImage('');
    setCreateCommand('');
    setCreateNetworkMode('default');
    setCreateRestartPolicy('no');
    setCreateTty(false);
    setCreateEntrypoint('');
    setCreateUser('');
    setCreateWorkingDir('');
    setCreateHostname('');
    setCreatePrivileged(false);
    setCreateAutoRemove(false);
    setCreatePorts([{ container: '', host: '', protocol: 'tcp' }]);
    setCreateVolumes([{ source: '', target: '', readonly: false }]);
    setCreateEnvs([{ key: '', value: '' }]);
    setPortChecks({});
    setPortCheckLoading({});
  }

  /**
   * 将容器配置对象回填到创建表单草稿（供导入配置 / 从模板创建复用）。
   * 兼容导出接口的 config 结构：env/ports/volumes 数组转表单列表。
   * @param cfg 容器配置对象
   */
  function applyConfigToForm(cfg: any) {
    const c = cfg || {};
    setCreateName(String(c.name || '').trim());
    setCreateImage(String(c.image || '').trim());
    setCreateCommand(String(c.command || '').trim());
    setCreateNetworkMode(String(c.networkMode || 'default'));
    setCreateRestartPolicy(String(c.restartPolicy || 'no'));
    setCreateTty(c.tty !== false);
    setCreateEntrypoint(String(c.entrypoint || '').trim());
    setCreateUser(String(c.user || '').trim());
    setCreateWorkingDir(String(c.workingDir || '').trim());
    setCreateHostname(String(c.hostname || '').trim());
    setCreatePrivileged(c.privileged === true);
    setCreateAutoRemove(c.autoRemove === true);

    // env: ["K=V",...] -> [{key,value}]
    const envArr = Array.isArray(c.env) ? c.env : [];
    setCreateEnvs(
      envArr.length
        ? envArr.map((e: string) => {
            const idx = String(e).indexOf('=');
            return idx > -1
              ? { key: String(e).slice(0, idx), value: String(e).slice(idx + 1) }
              : { key: String(e), value: '' };
          })
        : [{ key: '', value: '' }],
    );

    // ports: [{host,container,protocol,hostIp}] -> [{container,host,protocol}]
    const portArr = Array.isArray(c.ports) ? c.ports : [];
    setCreatePorts(
      portArr.length
        ? portArr.map((p: any) => ({
            container: String(p?.container ?? ''),
            host: String(p?.host ?? ''),
            protocol: p?.protocol || 'tcp',
          }))
        : [{ container: '', host: '', protocol: 'tcp' }],
    );

    // volumes: [{source,target,readonly}] -> 同构
    const volArr = Array.isArray(c.volumes) ? c.volumes : [];
    setCreateVolumes(
      volArr.length
        ? volArr.map((v: any) => ({
            source: String(v?.source ?? ''),
            target: String(v?.target ?? ''),
            readonly: v?.readonly === true,
          }))
        : [{ source: '', target: '', readonly: false }],
    );
  }

  /**
   * 打开"从模板创建"弹窗：拉取模板列表供用户选择
   */
  async function openTemplatePicker() {
    setTemplateLoading(true);
    try {
      const res = await get<TemplateItem[]>('/api/templates');
      setTemplateList(res || []);
      setTemplateOpen(true);
    } catch (e: any) {
      showToast(t('获取模板列表失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setTemplateLoading(false);
    }
  }

  /**
   * 应用所选模板：将模板 config 回填到创建表单草稿并打开创建弹窗
   * @param tpl 选中的模板项
   */
  async function applyTemplate(tpl: TemplateItem) {
    setTemplateApplying(tpl.id);
    try {
      // 将模板 config 包装为 { config } 结构，复用 applyConfigToForm 回填
      applyConfigToForm(tpl.config);
      setTemplateOpen(false);
      setCreateOpen(true);
      showToast(t('已应用模板「{{v1}}」，请确认后创建', { v1: tpl.name }));
    } catch (e: any) {
      showToast(t('应用模板失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setTemplateApplying('');
    }
  }

  // 按 seed 意图打开：空白 / 导入配置 / 应用模板 / 模板选择器；seed 置空即关闭全部弹窗
  useEffect(() => {
    if (!seed) {
      setCreateOpen(false);
      setTemplateOpen(false);
      return;
    }
    if (seed.type === 'blank') {
      resetForm();
      setTemplateOpen(false);
      setCreateOpen(true);
    } else if (seed.type === 'config') {
      applyConfigToForm(seed.cfg);
      setTemplateOpen(false);
      setCreateOpen(true);
    } else if (seed.type === 'template') {
      void applyTemplate(seed.tpl);
    } else if (seed.type === 'template-picker') {
      setCreateOpen(false);
      void openTemplatePicker();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  /** 更新创建端口草稿中某个条目 */
  function updateCreatePort(index: number, field: 'container' | 'host' | 'protocol', value: string) {
    setCreatePorts((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /**
   * 对创建表单某一行的宿主端口做占用检测（POST /api/containers/port-check），
   * 结果写入 portChecks，供行内提示与提交前拦截使用。
   * @param index 端口行 index
   * @param host 宿主机端口字符串
   */
  async function checkHostPort(index: number, host: string) {
    const port = Number(host.trim());
    // 非合法端口清空检测态
    if (!host.trim() || !Number.isFinite(port) || port < 1 || port > 65535) {
      setPortChecks((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      return;
    }
    setPortCheckLoading((prev) => ({ ...prev, [index]: true }));
    try {
      const res = await post<{ results: PortCheckResult[] }>('/api/containers/port-check', {
        ports: [{ port, protocol: createPorts[index]?.protocol || 'tcp' }],
      });
      const result = res?.results?.[0];
      if (result) {
        // 仅当该行宿主端口仍是检测时输入的值时才写入（避免过期结果覆盖）
        const currentHost = createPorts[index]?.host;
        if (currentHost !== undefined && currentHost === host) {
          setPortChecks((prev) => ({ ...prev, [index]: result }));
        }
      }
    } catch {
      // 检测失败静默忽略，不阻塞表单录入
    } finally {
      setPortCheckLoading((prev) => ({ ...prev, [index]: false }));
    }
  }

  /**
   * 宿主端口输入变化时触发防抖检测（约 400ms）
   */
  function onHostPortChange(index: number, value: string) {
    updateCreatePort(index, 'host', value);
    // 先清除该行旧检测结果
    setPortChecks((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    // 清除该行旧定时器
    if (portCheckTimer.current[index]) {
      clearTimeout(portCheckTimer.current[index]);
      delete portCheckTimer.current[index];
    }
    const trimmed = value.trim();
    if (!trimmed) return;
    portCheckTimer.current[index] = setTimeout(() => {
      checkHostPort(index, value);
    }, 400);
  }

  /** 删除端口行时同步清理其检测状态与定时器 */
  function removeCreatePort(index: number) {
    setCreatePorts((prev) => prev.filter((_, i) => i !== index));
    setPortChecks((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setPortCheckLoading((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    if (portCheckTimer.current[index]) {
      clearTimeout(portCheckTimer.current[index]);
      delete portCheckTimer.current[index];
    }
  }

  /** 新增一个创建端口条目 */
  function addCreatePort() {
    setCreatePorts((prev) => [...prev, { container: '', host: '', protocol: 'tcp' }]);
  }

  /** 更新创建挂载草稿中某个条目 */
  function updateCreateVolume(index: number, field: 'source' | 'target' | 'readonly', value: any) {
    setCreateVolumes((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /** 删除创建挂载草稿中某个条目 */
  function removeCreateVolume(index: number) {
    setCreateVolumes((prev) => prev.filter((_, i) => i !== index));
  }

  /** 新增一个创建挂载条目 */
  function addCreateVolume() {
    setCreateVolumes((prev) => [...prev, { source: '', target: '', readonly: false }]);
  }

  /** 更新创建环境变量草稿中某个条目 */
  function updateCreateEnv(index: number, field: 'key' | 'value', value: string) {
    setCreateEnvs((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /** 删除创建环境变量草稿中某个条目 */
  function removeCreateEnv(index: number) {
    setCreateEnvs((prev) => prev.filter((_, i) => i !== index));
  }

  /** 新增一个创建环境变量条目 */
  function addCreateEnv() {
    setCreateEnvs((prev) => [...prev, { key: '', value: '' }]);
  }

  /**
   * 提交创建容器
   *
   * 校验镜像 / 容器名必填；将端口、挂载、环境变量草稿按后端格式组装后 POST /api/containers。
   */
  async function submitCreate() {
    if (!canOperate()) {
      showToast(t('仅管理员可创建容器'), 'error');
      onClose();
      return;
    }
    // 必填校验
    if (!createName.trim()) {
      showToast(t('请填写容器名'), 'error');
      return;
    }
    if (!createImage.trim()) {
      showToast(t('请填写镜像'), 'error');
      return;
    }
    // 前置端口占用告警：存在已检测为占用的宿主端口时提示，但不阻塞（Docker 启动时会做最终校验）
    const busyPorts = createPorts
      .filter((item) => item.host.trim() !== '')
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => portChecks[index]?.busy)
      .map(({ item }) => item.host.trim());
    if (busyPorts.length > 0) {
      showToast(t('警告：端口 {{v1}} 疑似已被占用，若启动失败请更换端口', { v1: busyPorts.join(', ') }), 'error');
    }
    setCreating(true);
    try {
      // ports：过滤空容器端口，container 转 number，host 可空则 undefined
      const ports = createPorts
        .filter((item) => item.container.trim() !== '')
        .map((item) => ({
          host: item.host.trim() ? item.host.trim() : undefined,
          container: Number(item.container.trim()),
          protocol: item.protocol,
        }));
      // volumes：过滤来源或目标为空的条目
      const volumes = createVolumes
        .filter((item) => item.source.trim() !== '' && item.target.trim() !== '')
        .map((item) => ({
          source: item.source.trim(),
          target: item.target.trim(),
          readonly: item.readonly,
        }));
      // env：过滤空键名，转为 "KEY=VALUE" 字符串数组
      const env = createEnvs
        .filter((item) => item.key.trim() !== '')
        .map((item) => `${item.key.trim()}=${item.value}`);

      await post('/api/containers', {
        name: createName.trim(),
        image: createImage.trim(),
        command: createCommand.trim() || undefined,
        entrypoint: createEntrypoint.trim() || undefined,
        user: createUser.trim() || undefined,
        workingDir: createWorkingDir.trim() || undefined,
        hostname: createHostname.trim() || undefined,
        privileged: createPrivileged,
        autoRemove: createAutoRemove,
        env: env.length ? env : undefined,
        ports,
        volumes,
        networkMode: createNetworkMode,
        restartPolicy: createRestartPolicy,
        tty: createTty,
        // 资源限制：内存 MB 转字节；CPU 毫核转纳核
        memLimit: createMemLimit.trim() ? Number(createMemLimit) * 1024 * 1024 : undefined,
        cpuLimit: createCpuLimit.trim() ? Number(createCpuLimit) * 1000000 : undefined,
        // 健康检查
        healthcheck:
          createHealthCmd.trim()
            ? {
                test: ['CMD-SHELL', createHealthCmd.trim()],
                interval: createHealthInterval.trim() ? Number(createHealthInterval) * 1000 : undefined,
                timeout: createHealthTimeout.trim() ? Number(createHealthTimeout) * 1000 : undefined,
                retries: createHealthRetries.trim() ? Number(createHealthRetries) : undefined,
              }
            : undefined,
      });
      showToast(t('容器创建成功'));
      onClose();
      onCreated();
    } catch (e: any) {
      showToast(t('创建失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Modal
        open={createOpen}
        title={t('创建容器')}
        onClose={() => !creating && onClose()}
        width={720}
        footer={
          <div className="create-modal__footer">
            <Button variant="ghost" size="md" onClick={onClose} disabled={creating}>
              {t('取消')}
            </Button>
            <Button variant="primary" size="md" loading={creating} onClick={submitCreate}>
              {t('创建')}
            </Button>
          </div>
        }
      >
        <div className="create-modal__body">
          <div className="create-modal__grid">
            <Field label={t('容器名')} required>
              <Input
                placeholder="my-container"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                disabled={creating}
              />
            </Field>
            <Field label={t('镜像')} required>
              <Input
                placeholder="nginx:latest"
                value={createImage}
                onChange={(e) => setCreateImage(e.target.value)}
                disabled={creating}
              />
            </Field>
          </div>

          <Field label={t('命令')} hint={t('可选，多个参数以空格分隔')}>
            <Input
              placeholder="sh -c ..."
              value={createCommand}
              onChange={(e) => setCreateCommand(e.target.value)}
              disabled={creating}
            />
          </Field>

          <div className="create-modal__grid">
            <Field label={t('网络模式')}>
              <Select value={createNetworkMode} onChange={(e) => setCreateNetworkMode(e.target.value)} disabled={creating}>
                {NETWORK_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('重启策略')}>
              <Select
                value={createRestartPolicy}
                onChange={(e) => setCreateRestartPolicy(e.target.value)}
                disabled={creating}
              >
                {RESTART_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* 资源限制 */}
          <div className="create-modal__grid">
            <Field label={t('内存上限 (MB)')}>
              <Input
                type="number"
                min={0}
                placeholder={t('留空不限制，如 512')}
                value={createMemLimit}
                onChange={(e) => setCreateMemLimit(e.target.value)}
                disabled={creating}
              />
            </Field>
            <Field label={t('CPU 上限 (毫核)')}>
              <Input
                type="number"
                min={0}
                placeholder={t('留空不限制，1000=1核')}
                value={createCpuLimit}
                onChange={(e) => setCreateCpuLimit(e.target.value)}
                disabled={creating}
              />
            </Field>
          </div>

          {/* 健康检查 */}
          <Field label={t('健康检查命令')}>
            <Input
              placeholder={t('留空不启用，如 CMD: curl -f http://localhost || exit 1')}
              value={createHealthCmd}
              onChange={(e) => setCreateHealthCmd(e.target.value)}
              disabled={creating}
            />
          </Field>
          {createHealthCmd.trim() ? (
            <div className="create-modal__grid">
              <Field label={t('检查间隔 (秒)')}>
                <Input
                  type="number"
                  min={1}
                  placeholder={t('默认 30')}
                  value={createHealthInterval}
                  onChange={(e) => setCreateHealthInterval(e.target.value)}
                  disabled={creating}
                />
              </Field>
              <Field label={t('超时 (秒)')}>
                <Input
                  type="number"
                  min={1}
                  placeholder={t('默认 5')}
                  value={createHealthTimeout}
                  onChange={(e) => setCreateHealthTimeout(e.target.value)}
                  disabled={creating}
                />
              </Field>
              <Field label={t('重试次数')}>
                <Input
                  type="number"
                  min={1}
                  placeholder={t('默认 3')}
                  value={createHealthRetries}
                  onChange={(e) => setCreateHealthRetries(e.target.value)}
                  disabled={creating}
                />
              </Field>
            </div>
          ) : null}

          <Field label={t('TTY 模式')}>
            <label className="create-modal__tty">
              <input
                type="checkbox"
                checked={createTty}
                onChange={(e) => setCreateTty(e.target.checked)}
                disabled={creating}
              />
              {t('启用 TTY（交互式终端）')}
            </label>
          </Field>

          {/* 端口映射 */}
          <Field label={t('端口映射')}>
            <div className="create-modal__section">
              <div className="create-modal__head">
                <span className="create-modal__col-container">{t('容器端口')}</span>
                <span className="create-modal__col-host">{t('宿主机端口')}</span>
                <span className="create-modal__col-protocol">{t('协议')}</span>
                <span className="create-modal__col-op" />
              </div>
              {createPorts.map((item, index) => (
                <div className="create-modal__row" key={index}>
                  <Input
                    className="create-modal__col-container"
                    placeholder="80"
                    value={item.container}
                    onChange={(e) => updateCreatePort(index, 'container', e.target.value)}
                    disabled={creating}
                  />
                  <div className="create-modal__col-host">
                    <Input
                      className="create-modal__input-host"
                      placeholder={t('8080（可选）')}
                      value={item.host}
                      onChange={(e) => onHostPortChange(index, e.target.value)}
                      disabled={creating}
                    />
                    {/* 端口占用检测提示 */}
                    {item.host.trim() &&
                      (portCheckLoading[index] ? (
                        <div className="port-check__tip port-check__tip--checking">{t('检测中…')}</div>
                      ) : portChecks[index]?.busy ? (
                        <div className="port-check__tip port-check__tip--busy">
                          {portChecks[index]?.containerOccupied
                            ? t('该端口已被容器占用：{{v1}}', { v1: (portChecks[index]?.containerNames || []).join(', ') })
                            : portChecks[index]?.hostListening
                              ? t('该端口已被本机进程监听')
                              : t('端口已被占用')}
                        </div>
                      ) : portChecks[index] ? (
                        <div className="port-check__tip port-check__tip--ok">{t('端口可用')}</div>
                      ) : null)}
                  </div>
                  <Select
                    className="create-modal__col-protocol"
                    value={item.protocol}
                    onChange={(e) => updateCreatePort(index, 'protocol', e.target.value)}
                    disabled={creating}
                  >
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="create-modal__col-op"
                    onClick={() => removeCreatePort(index)}
                    disabled={creating}
                    title={t('删除这项端口')}
                  >
                    {t('删除')}
                  </Button>
                </div>
              ))}
              <div className="create-modal__add">
                <Button variant="secondary" size="sm" onClick={addCreatePort} disabled={creating}>
                  {t('+ 添加端口')}
                </Button>
              </div>
            </div>
          </Field>

          {/* 挂载卷 */}
          <Field label={t('挂载卷')}>
            <div className="create-modal__section">
              <div className="create-modal__head">
                <span className="create-modal__col-source">{t('来源')}</span>
                <span className="create-modal__col-target">{t('容器路径')}</span>
                <span className="create-modal__col-readonly">{t('只读')}</span>
                <span className="create-modal__col-op" />
              </div>
              {createVolumes.map((item, index) => (
                <div className="create-modal__row" key={index}>
                  <Input
                    className="create-modal__col-source"
                    placeholder={t('宿主机路径或卷名')}
                    value={item.source}
                    onChange={(e) => updateCreateVolume(index, 'source', e.target.value)}
                    disabled={creating}
                  />
                  <Input
                    className="create-modal__col-target"
                    placeholder={t('/容器/路径')}
                    value={item.target}
                    onChange={(e) => updateCreateVolume(index, 'target', e.target.value)}
                    disabled={creating}
                  />
                  <label className="create-modal__readonly">
                    <input
                      type="checkbox"
                      checked={item.readonly}
                      onChange={(e) => updateCreateVolume(index, 'readonly', e.target.checked)}
                      disabled={creating}
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="create-modal__col-op"
                    onClick={() => removeCreateVolume(index)}
                    disabled={creating}
                    title={t('删除这项挂载')}
                  >
                    {t('删除')}
                  </Button>
                </div>
              ))}
              <div className="create-modal__add">
                <Button variant="secondary" size="sm" onClick={addCreateVolume} disabled={creating}>
                  {t('+ 添加挂载')}
                </Button>
              </div>
            </div>
          </Field>

          {/* 环境变量 */}
          <Field label={t('环境变量')}>
            <div className="create-modal__section">
              {createEnvs.map((item, index) => (
                <div className="create-modal__row" key={index}>
                  <Input
                    className="create-modal__col-env-key"
                    placeholder={t('变量名')}
                    value={item.key}
                    onChange={(e) => updateCreateEnv(index, 'key', e.target.value)}
                    disabled={creating}
                  />
                  <Input
                    className="create-modal__col-env-value"
                    placeholder={t('变量值')}
                    value={item.value}
                    onChange={(e) => updateCreateEnv(index, 'value', e.target.value)}
                    disabled={creating}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="create-modal__col-op"
                    onClick={() => removeCreateEnv(index)}
                    disabled={creating}
                    title={t('删除这项')}
                  >
                    {t('删除')}
                  </Button>
                </div>
              ))}
              <div className="create-modal__add">
                <Button variant="secondary" size="sm" onClick={addCreateEnv} disabled={creating}>
                  {t('+ 添加环境变量')}
                </Button>
              </div>
            </div>
          </Field>
        </div>
      </Modal>

      {/* 从模板创建弹窗 */}
      <Modal
        open={templateOpen}
        title={t('从模板创建容器')}
        onClose={() => setTemplateOpen(false)}
        width={640}
        footer={
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setTemplateOpen(false)}>{t('取消')}</Button>
          </div>
        }
      >
        {templateLoading ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted, #888)' }}>
            {t('正在加载模板列表…')}
          </div>
        ) : templateList.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted, #888)' }}>
            {t('暂无模板，可到「容器模板」页或在容器详情页「保存为模板」创建。')}
          </div>
        ) : (
          <div className="template-pick__list">
            {templateList.map((tpl) => (
              <div key={tpl.id} className="template-pick__item">
                <div className="template-pick__info">
                  <div className="template-pick__name">{tpl.name}</div>
                  <div className="template-pick__desc">
                    {tpl.image || '—'}
                    {tpl.description ? ` · ${tpl.description}` : ''}
                  </div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  loading={templateApplying === tpl.id}
                  onClick={() => applyTemplate(tpl)}
                >
                  {t('使用')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
