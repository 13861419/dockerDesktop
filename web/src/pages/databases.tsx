/**
 * 数据库可视化管理页
 *
 * 支持登记 / 编辑 / 删除数据库实例，对实例做连接测试，
 * 并可列库、执行只读 SQL（mysql/postgres/mariadb）或浏览 Redis 键与指标。
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
import { get, post, put, del, download } from '../api/client';
import { isAdmin, canOperate } from '../api/auth';
import {
  DatabaseInstance,
  DatabaseListResponse,
  SqlQueryResult,
  RedisKeyItem,
  RedisInfo,
  DatabaseType,
} from '../types';
import './databases.less';

/** 已识别容器项类型（取自列表接口返回） */
type RecognizedContainer = DatabaseListResponse['recognizedInstances'][number];

/** 实例登记 / 编辑表单的提交值（port 以字符串编辑，提交前转数字） */
interface InstanceFormValues {
  name: string;
  type: DatabaseType;
  host: string;
  port: string;
  user: string;
  password: string;
  containerRef?: string;
}

/** 数据库类型的中文展示名映射 */
const TYPE_LABELS: Record<DatabaseType, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
};

/**
 * 数据库可视化管理页面组件
 */
export default function DatabasesPage() {
  const { showToast } = useToast();
  // 登记 / 编辑等管理操作为 operator 及以上（与后端 requireOperator 对齐）
  const canManage = canOperate();
  // 删除登记实例仅 admin 可用（后端 requireAdmin）
  const canDelete = isAdmin();
  const [instances, setInstances] = useState<DatabaseInstance[]>([]);
  const [recognized, setRecognized] = useState<RecognizedContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  // 列表加载失败的错误信息（用于展示可重试的错误态）
  const [loadError, setLoadError] = useState('');
  // 登记弹窗是否打开
  const [registerOpen, setRegisterOpen] = useState(false);
  // 待编辑的实例（打开编辑弹窗）
  const [editTarget, setEditTarget] = useState<DatabaseInstance | null>(null);
  // 登记 / 编辑是否提交中
  const [saving, setSaving] = useState(false);
  // 正在执行连接测试的实例 id
  const [testingId, setTestingId] = useState<number | null>(null);
  // 待删除的实例（用于确认框）
  const [deleteTarget, setDeleteTarget] = useState<DatabaseInstance | null>(null);
  // 删除实例是否进行中
  const [deleting, setDeleting] = useState(false);
  // 查看详情的实例（打开详情弹窗）
  const [detailTarget, setDetailTarget] = useState<DatabaseInstance | null>(null);

  /**
   * 拉取数据库实例列表与已识别容器列表
   */
  const fetchDatabases = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<DatabaseListResponse>('/api/databases');
      setInstances(data?.instances || []);
      setRecognized(data?.recognizedInstances || []);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || '拉取数据库实例失败');
      showToast(e?.message || '拉取数据库实例失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchDatabases();
  }, [fetchDatabases, refreshKey]);

  /**
   * 登记或更新实例（由表单弹窗统一提交）
   * @param target 编辑目标实例，登记时为空
   * @param values 表单值
   */
  const handleSave = useCallback(
    async (target: DatabaseInstance | null, values: InstanceFormValues) => {
      if (!canManage) {
        showToast(target ? '仅管理员可编辑数据库实例' : '仅管理员可登记数据库实例', 'error');
        setRegisterOpen(false);
        setEditTarget(null);
        return;
      }
      setSaving(true);
      try {
        // 编辑实例时若密码留空则保持原密码，不提交 password 字段
        if (target) {
          const payload: Record<string, any> = {
            name: values.name.trim(),
            type: values.type,
            host: values.host.trim(),
            port: Number(values.port),
            user: values.user.trim(),
          };
          if (values.password.trim()) payload.password = values.password.trim();
          await put(`/api/databases/${target.id}`, payload);
          showToast(`${values.name} 已更新`);
        } else {
          await post('/api/databases', {
            name: values.name.trim(),
            type: values.type,
            host: values.host.trim(),
            port: Number(values.port),
            user: values.user.trim(),
            password: values.password.trim() || undefined,
            containerRef: values.containerRef || undefined,
          });
          showToast(`${values.name} 登记成功`);
        }
        setRegisterOpen(false);
        setEditTarget(null);
        setRefreshKey((k) => k + 1);
      } catch (e: any) {
        showToast(e?.message || '保存失败', 'error');
      } finally {
        setSaving(false);
      }
    },
    [canManage, showToast]
  );

  /**
   * 对实例执行连接测试
   * @param instance 目标实例
   */
  const handleTest = useCallback(
    async (instance: DatabaseInstance) => {
      setTestingId(instance.id);
      try {
        const data = await post<{ ok: boolean; message?: string }>(
          `/api/databases/${instance.id}/test`
        );
        if (data?.ok) {
          showToast(data.message || `${instance.name} 连接正常`);
        } else {
          showToast(data.message || `${instance.name} 连接失败`, 'error');
        }
      } catch (e: any) {
        showToast(e?.message || `${instance.name} 连接失败`, 'error');
      } finally {
        setTestingId(null);
      }
    },
    [showToast]
  );

  /**
   * 删除实例（经确认框调用）
   */
  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (!canDelete) {
      showToast('仅管理员可删除数据库实例', 'error');
      setDeleteTarget(null);
      return;
    }
    const target = deleteTarget;
    setDeleting(true);
    try {
      await del(`/api/databases/${target.id}`);
      showToast(`${target.name} 已删除`);
      setDeleteTarget(null);
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canDelete, deleteTarget, showToast]);

  /**
   * 渲染单张实例卡片
   * @param instance 实例项
   */
  const renderCard = useCallback(
    (instance: DatabaseInstance) => {
      return (
        <div className="db-card" key={instance.id}>
          <div className="db-card__head">
            <div className="db-card__icon" aria-hidden="true">
              {TYPE_LABELS[instance.type]?.charAt(0) || 'DB'}
            </div>
            <div className="db-card__meta">
              <div className="db-card__name" title={instance.name}>
                {instance.name}
              </div>
              <div className="db-card__type">{TYPE_LABELS[instance.type] || instance.type}</div>
            </div>
          </div>

          <div className="db-card__row">
            <span className="db-card__row-label">地址</span>
            <span className="db-card__row-value">
              {instance.host}:{instance.port}
            </span>
          </div>

          <div className="db-card__row">
            <span className="db-card__row-label">用户</span>
            <span className="db-card__row-value">{instance.user || '—'}</span>
          </div>

          <div className="db-card__row">
            <span className="db-card__row-label">密码</span>
            <span className="db-card__badge badge badge--muted">
              {instance.hasPassword ? '已设置' : '未设置'}
            </span>
          </div>

          <div className="db-card__actions">
            <Button
              variant="ghost"
              size="sm"
              loading={testingId === instance.id}
              disabled={!!testingId}
              onClick={() => handleTest(instance)}
            >
              连接测试
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setDetailTarget(instance)}>
              列库
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditTarget(instance)} disabled={!canManage}>
              编辑
            </Button>
            <Button variant="danger" size="sm" onClick={() => setDeleteTarget(instance)} disabled={!canDelete}>
              删除
            </Button>
          </div>
        </div>
      );
    },
    [testingId, handleTest, canManage, canDelete]
  );

  return (
    <div className="page">
      <Card
        title="数据库管理"
        extra={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            刷新
          </Button>
        }
      >
        <div className="db-tip">
          管理已登记的数据库实例：可登记旋转识别到的容器，浏览库表、执行只读查询或查看 Redis 键。
        </div>

        <div className="db-card__actions" style={{ justifyContent: 'flex-start', marginBottom: 16 }}>
          <Button variant="primary" size="sm" onClick={() => setRegisterOpen(true)} disabled={!canManage}>
            登记实例
          </Button>
        </div>

        {loading ? (
          <SkeletonRows rows={6} />
        ) : loadError ? (
          <Empty
            kind="error"
            title="拉取数据库实例失败"
            description={loadError || '请检查 Docker 引擎连接后重试'}
            action={
              <Button variant="secondary" size="sm" onClick={fetchDatabases}>
                重试
              </Button>
            }
          />
        ) : instances.length === 0 ? (
          <Empty
            title="暂无数据库实例"
            description="点击右上角「登记实例」添加或识别数据库容器"
            action={
              <Button variant="primary" size="sm" onClick={() => setRegisterOpen(true)} disabled={!canManage}>
                登记实例
              </Button>
            }
          />
        ) : (
          <div className="db-grid">{instances.map(renderCard)}</div>
        )}
      </Card>

      {/* 登记实例弹窗 */}
      <InstanceFormModal
        open={registerOpen}
        instance={null}
        recognized={recognized}
        submitting={saving}
        onClose={() => setRegisterOpen(false)}
        onSubmit={(values) => handleSave(null, values)}
      />

      {/* 编辑实例弹窗 */}
      <InstanceFormModal
        open={!!editTarget}
        instance={editTarget}
        recognized={[]}
        submitting={saving}
        onClose={() => setEditTarget(null)}
        onSubmit={(values) => handleSave(editTarget, values)}
      />

      {/* 实例详情弹窗 */}
      <DetailModal
        open={!!detailTarget}
        instance={detailTarget}
        onClose={() => setDetailTarget(null)}
      />

      {/* 删除实例确认框 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除实例"
        message={`确定要删除数据库实例 "${deleteTarget?.name || ''}" 吗？此操作不会影响实际数据库。`}
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
 * 实例登记 / 编辑共用的表单弹窗
 * @param param0 弹窗属性
 */
function InstanceFormModal({
  open,
  instance,
  recognized,
  submitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  instance: DatabaseInstance | null;
  recognized: RecognizedContainer[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: InstanceFormValues) => void;
}) {
  const isEdit = !!instance;
  const [values, setValues] = useState<InstanceFormValues>({
    name: '',
    type: 'mysql',
    host: '',
    port: '',
    user: '',
    password: '',
    containerRef: '',
  });

  // 弹窗打开或切换目标时重置表单
  useEffect(() => {
    if (!open) return;
    setValues({
      name: instance?.name || '',
      type: instance?.type || 'mysql',
      host: instance?.host || '',
      port: instance ? String(instance.port) : '',
      user: instance?.user || '',
      password: '',
      containerRef: instance?.containerRef || '',
    });
  }, [open, instance]);

  /**
   * 更新单个表单字段
   * @param key 字段名
   * @param value 字段值
   */
  const update = (key: keyof InstanceFormValues, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * 从已识别容器快捷填入：containerRef / type / host
   * @param item 已识别容器
   */
  const applyRecognized = (item: RecognizedContainer) => {
    setValues((prev) => ({
      ...prev,
      type: item.type,
      host: item.containerName || item.containerId,
      containerRef: item.containerId,
    }));
  };

  /**
   * 提交表单（做基础必填校验）
   */
  const submit = () => {
    if (!values.name.trim() || !values.host.trim() || !values.port.trim()) {
      return;
    }
    onSubmit(values);
  };

  return (
    <Modal
      open={open}
      title={isEdit ? `编辑实例 ${instance?.name || ''}` : '登记实例'}
      onClose={() => !submitting && onClose()}
      width={520}
      footer={
        <div className="db-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={submitting}
            disabled={!values.name.trim() || !values.host.trim() || !values.port.trim()}
            onClick={submit}
          >
            {isEdit ? '保存' : '登记'}
          </Button>
        </div>
      }
    >
      <div className="db-form">
        {/* 已识别容器快捷入口：仅登记模式下展示 */}
        {!isEdit && recognized.length > 0 && (
          <div className="db-recognized__section">
            <div className="db-recognized__tip">检测到已识别的数据库容器，点击自动填入：</div>
            <div className="db-recognized__list">
              {recognized.map((item) => (
                <button
                  type="button"
                  className="db-recognized__item"
                  key={item.containerId}
                  onClick={() => applyRecognized(item)}
                >
                  <span className="db-recognized__name">{item.containerName}</span>
                  <span className="db-recognized__meta">
                    {TYPE_LABELS[item.type] || item.type} · {item.image}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <Field label="名称" required>
          <Input
            value={values.name}
            placeholder="例如：主数据库"
            onChange={(e) => update('name', e.target.value)}
          />
        </Field>

        <Field label="类型" required>
          <Select value={values.type} onChange={(e) => update('type', e.target.value)}>
            <option value="mysql">MySQL</option>
            <option value="postgres">PostgreSQL</option>
            <option value="mariadb">MariaDB</option>
            <option value="redis">Redis</option>
          </Select>
        </Field>

        <Field label="主机" required>
          <Input
            value={values.host}
            placeholder="127.0.0.1 或容器名"
            onChange={(e) => update('host', e.target.value)}
          />
        </Field>

        <Field label="端口" required>
          <Input
            value={values.port}
            placeholder="3306 / 5432 / 6379"
            onChange={(e) => update('port', e.target.value)}
          />
        </Field>

        <Field label="用户名">
          <Input
            value={values.user}
            placeholder="root（可空）"
            onChange={(e) => update('user', e.target.value)}
          />
        </Field>

        <Field
          label="密码"
          hint={
            isEdit && instance?.hasPassword
              ? '已设置密码；留空则保持原密码不变'
              : '可空（无密码连接）'
          }
        >
          <Input
            type="password"
            value={values.password}
            placeholder={isEdit && instance?.hasPassword ? '已设置' : '可空'}
            onChange={(e) => update('password', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * 实例详情弹窗：按类型展示库表 / Redis 内容
 * @param param0 弹窗属性
 */
function DetailModal({
  open,
  instance,
  onClose,
}: {
  open: boolean;
  instance: DatabaseInstance | null;
  onClose: () => void;
}) {
  const isRedis = instance?.type === 'redis';
  // Redis 键浏览 / 指标等均为管理能力，仅 operator 及以上可用
  const operable = canOperate();
  return (
    <Modal
      open={open}
      title={instance ? `${instance.name} (${TYPE_LABELS[instance.type] || instance.type})` : '实例详情'}
      onClose={onClose}
      width={720}
    >
      {instance && (
        <>
          <div className="db-detail__info">
            地址：<span className="db-card__row-value">{instance.host}:{instance.port}</span> · 用户：
            {instance.user || '—'} · 密码：{instance.hasPassword ? '已设置' : '未设置'}
          </div>
          {isRedis ? (
            operable ? (
              <RedisPanel instance={instance} />
            ) : (
              <Empty
                title="需要操作员/管理员权限"
                description="浏览 Redis 键与指标需具备 operator 或管理员权限，请联系管理员授予相应角色。"
              />
            )
          ) : (
            <SqlViewPanel instance={instance} />
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * mysql / postgres / mariadb 视图：列库、删库、新建库与只读 SQL 查询面板
 * @param param0 实例
 */
function SqlViewPanel({ instance }: { instance: DatabaseInstance }) {
  const { showToast } = useToast();
  // 建库 / 删库等管理操作为 operator 及以上；普通 user 仍可浏览库表列表
  const canManage = canOperate();
  const [databases, setDatabases] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // 新建库弹窗是否打开
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  // 新建库字符集（仅 mysql/mariadb 生效；postgres/redis 忽略）
  const [createCharset, setCreateCharset] = useState('utf8mb4');
  const [creating, setCreating] = useState(false);
  // 待删除的库名
  const [deleteDb, setDeleteDb] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 当前选中的库
  const [activeDb, setActiveDb] = useState('');
  // 当前选中库的表列表
  const [tables, setTables] = useState<string[]>([]);
  // 待查看详情的表（打开表详情弹窗）
  const [detailTable, setDetailTable] = useState<string | null>(null);

  /**
   * 加载库列表，并保持当前选中库
   */
  const loadDatabases = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<{ databases?: string[] } | string[]>(
        `/api/databases/${instance.id}/databases`
      );
      const list = Array.isArray(data) ? data : (data?.databases || []);
      setDatabases(list);
      setActiveDb((prev) => (list.includes(prev) ? prev : list[0] || ''));
    } catch (e: any) {
      showToast(e?.message || '加载库列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [instance.id, showToast]);

  useEffect(() => {
    loadDatabases();
  }, [loadDatabases]);

  /**
   * 加载指定库的表列表
   * @param db 库名
   */
  const loadTables = useCallback(
    async (db: string) => {
      setActiveDb(db);
      try {
        const data = await get<{ tables?: string[] } | string[]>(
          `/api/databases/${instance.id}/databases/${encodeURIComponent(db)}/tables`
        );
        setTables(Array.isArray(data) ? data : (data?.tables || []));
      } catch (e: any) {
        setTables([]);
        showToast(e?.message || '加载表列表失败', 'error');
      }
    },
    [instance.id, showToast]
  );

  /**
   * 新建数据库（mysql/mariadb 附带字符集参数）
   */
  const handleCreate = useCallback(async () => {
    if (!canManage) {
      showToast('需要操作员/管理员权限方可创建数据库', 'error');
      setCreateOpen(false);
      return;
    }
    if (!createName.trim()) return;
    setCreating(true);
    try {
      // mysql/mariadb 支持 CHARACTER SET；postgres/redis 不传（后端忽略）
      const isMysqlLike = instance.type === 'mysql' || instance.type === 'mariadb';
      const body: Record<string, string> = { name: createName.trim() };
      if (isMysqlLike && createCharset) body.charset = createCharset;
      await post(`/api/databases/${instance.id}/databases`, body);
      showToast(`已创建数据库 ${createName.trim()}`);
      setCreateOpen(false);
      setCreateName('');
      loadDatabases();
      setActiveDb(createName.trim());
    } catch (e: any) {
      showToast(e?.message || '创建数据库失败', 'error');
    } finally {
      setCreating(false);
    }
  }, [canManage, instance.id, instance.type, createName, createCharset, showToast, loadDatabases]);

  /**
   * 删除数据库（经确认框调用）
   */
  const handleDelete = useCallback(async () => {
    if (!deleteDb) return;
    if (!canManage) {
      showToast('需要操作员/管理员权限方可删除数据库', 'error');
      setDeleteDb(null);
      return;
    }
    const db = deleteDb;
    setDeleting(true);
    try {
      await del(`/api/databases/${instance.id}/databases/${encodeURIComponent(db)}`);
      showToast(`已删除数据库 ${db}`);
      setDeleteDb(null);
      if (activeDb === db) setTables([]);
      loadDatabases();
    } catch (e: any) {
      showToast(e?.message || '删除数据库失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canManage, instance.id, deleteDb, activeDb, showToast, loadDatabases]);

  return (
    <div>
      <div className="db-detail__section">
        <span className="db-detail__section-title">数据库 ({databases.length})</span>
        <div className="db-detail__section-actions">
          <Button variant="ghost" size="sm" onClick={() => setCreateOpen(true)} disabled={!canManage}>
            新建库
          </Button>
          <Button variant="ghost" size="sm" onClick={loadDatabases}>
            刷新
          </Button>
        </div>
      </div>

      {loading ? (
        <SkeletonRows rows={3} />
      ) : databases.length === 0 ? (
        <div className="db-list__empty">暂无数据库，可点击「新建库」创建。</div>
      ) : (
        <div className="db-list">
          {databases.map((db) => (
            <div className="db-list__row" key={db}>
              <button
                type="button"
                className="db-list__name"
                title={`点击列出 ${db} 的表`}
                onClick={() => loadTables(db)}
              >
                {db}
              </button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteDb(db)}
                disabled={!canManage}
              >
                删除
              </Button>
            </div>
          ))}
        </div>
      )}

      {tables.length > 0 && (
        <div className="db-detail__section">
          <span className="db-detail__section-title">
            {activeDb} 中的表 ({tables.length})
          </span>
        </div>
      )}
      {tables.length > 0 && (
        <div className="db-list" style={{ maxHeight: 120 }}>
          {tables.map((t) => (
            <div className="db-list__row" key={t}>
              {/* 表结构 / 表数据入口仅对 operator 及以上开放（后端 requireOperator） */}
              {canManage ? (
                <button
                  type="button"
                  className="db-list__name"
                  title={`点击查看 ${t} 的结构与数据`}
                  onClick={() => setDetailTable(t)}
                >
                  {t}
                </button>
              ) : (
                <span className="db-list__name" title={t}>
                  {t}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* SQL 查询面板与备份面板仅对 operator 及以上开放 */}
      {canManage && (
        <>
          <div className="db-detail__section">
            <span className="db-detail__section-title">SQL 查询</span>
          </div>
          <SqlQueryPanel instance={instance} activeDb={activeDb} databases={databases} />
        </>
      )}

      {canManage && <DbBackupPanel instance={instance} databases={databases} payloadDb={activeDb} />}

      {/* 新建库弹窗 */}
      <Modal
        open={createOpen}
        title="新建数据库"
        onClose={() => !creating && setCreateOpen(false)}
        width={440}
        footer={
          <div className="db-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setCreateOpen(false)} disabled={creating}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={creating}
              disabled={!createName.trim() || !canManage}
              onClick={handleCreate}
            >
              创建
            </Button>
          </div>
        }
      >
        <div className="db-create__fields">
          <Field label="数据库名" required>
            <Input
              value={createName}
              placeholder="例如：app_db"
              onChange={(e) => setCreateName(e.target.value)}
            />
          </Field>
          {(instance.type === 'mysql' || instance.type === 'mariadb') && (
            <Field label="字符集" hint="Character Set，创建后不可通过本面板修改">
              <Select value={createCharset} onChange={(e) => setCreateCharset(e.target.value)}>
                <option value="utf8mb4">utf8mb4（推荐）</option>
                <option value="utf8mb3">utf8mb3</option>
                <option value="utf8">utf8</option>
                <option value="gbk">gbk</option>
                <option value="latin1">latin1</option>
              </Select>
            </Field>
          )}
        </div>
      </Modal>

      {/* 删除库确认框 */}
      <ConfirmDialog
        open={!!deleteDb}
        title="删除数据库"
        message={`确定要删除数据库 "${deleteDb || ''}" 吗？该操作将删除其中的所有数据。`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteDb(null)}
      />

      {/* 表详情弹窗 */}
      <TableDetailModal
        open={!!detailTable}
        instance={instance}
        db={activeDb}
        table={detailTable}
        onClose={() => setDetailTable(null)}
      />
    </div>
  );
}

/**
 * 表详情弹窗：以 Tab 展示表结构（schema）与分页数据（rows）
 * @param param0 弹窗属性
 */
function TableDetailModal({
  open,
  instance,
  db,
  table,
  onClose,
}: {
  open: boolean;
  instance: DatabaseInstance;
  db: string;
  table: string | null;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  // 当前 Tab：structure（结构） / data（数据）
  const [tab, setTab] = useState<'structure' | 'data'>('structure');
  // 表结构：字段名与字段元信息行
  const [schemaColumns, setSchemaColumns] = useState<string[]>([]);
  const [schemaRows, setSchemaRows] = useState<string[][]>([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  // 每页行数
  const [pageSize, setPageSize] = useState(10);
  // 当前页码（从 1 起）
  const [page, setPage] = useState(1);
  // 数据页：字段名与行数据
  const [dataColumns, setDataColumns] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [total, setTotal] = useState(0);
  const [dataLoading, setDataLoading] = useState(false);

  /** 依据页码与每页行数计算首行偏移量 */
  const offset = (page - 1) * pageSize;

  // 弹窗关闭或切换表时重置状态
  useEffect(() => {
    if (open) {
      setTab('structure');
      setPage(1);
    } else {
      setSchemaColumns([]);
      setSchemaRows([]);
      setDataColumns([]);
      setDataRows([]);
      setTotal(0);
    }
  }, [open]);

  /**
   * 拉取表结构
   */
  const loadSchema = useCallback(async () => {
    if (!table) return;
    setSchemaLoading(true);
    try {
      const data = await get<{ columns: string[]; rows: string[][] }>(
        `/api/databases/${instance.id}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/schema`
      );
      setSchemaColumns(data?.columns || []);
      setSchemaRows(data?.rows || []);
    } catch (e: any) {
      setSchemaColumns([]);
      setSchemaRows([]);
      showToast(e?.message || '加载表结构失败', 'error');
    } finally {
      setSchemaLoading(false);
    }
  }, [instance.id, db, table, showToast]);

  // 打开时若在结构 Tab 则加载结构
  useEffect(() => {
    if (open && tab === 'structure') loadSchema();
  }, [open, tab, loadSchema]);

  // 打开时若在数据 Tab 则加载当前页
  useEffect(() => {
    if (open && tab === 'data' && table) setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  /**
   * 按当前页码与每页行数拉取数据
   */
  const loadData = useCallback(async () => {
    if (!table) return;
    setDataLoading(true);
    try {
      const data = await get<{ columns: string[]; rows: string[][]; total: number }>(
        `/api/databases/${instance.id}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/rows`,
        { limit: pageSize, offset }
      );
      setDataColumns(data?.columns || []);
      setDataRows(data?.rows || []);
      setTotal(data?.total ?? 0);
    } catch (e: any) {
      setDataColumns([]);
      setDataRows([]);
      setTotal(0);
      showToast(e?.message || '加载表数据失败', 'error');
    } finally {
      setDataLoading(false);
    }
  }, [instance.id, db, table, pageSize, offset, showToast]);

  // 在数据 Tab、打开时按页码 / 每页行数变化重新拉取
  useEffect(() => {
    if (open && tab === 'data') loadData();
  }, [open, tab, loadData]);

  /** 最大页码 */
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /** 切换上一页 */
  const prevPage = () => setPage((p) => Math.max(1, p - 1));

  /** 切换下一页 */
  const nextPage = () => setPage((p) => Math.min(totalPages, p + 1));

  return (
    <Modal
      open={open}
      title={table ? `表详情 · ${table}` : '表详情'}
      onClose={onClose}
      width={820}
    >
      {table && (
        <>
          <div className="db-detail__info">
            库：<span className="db-card__row-value">{db}</span> · 表：
            <span className="db-card__row-value">{table}</span>
          </div>

          {/* Tab 切换栏 */}
          <div className="detail-tabs">
            <button
              type="button"
              className={`detail-tabs__item ${tab === 'structure' ? 'detail-tabs__item--active' : ''}`}
              onClick={() => setTab('structure')}
            >
              结构
            </button>
            <button
              type="button"
              className={`detail-tabs__item ${tab === 'data' ? 'detail-tabs__item--active' : ''}`}
              onClick={() => setTab('data')}
            >
              数据
            </button>
          </div>

          {/* 结构 Tab */}
          {tab === 'structure' && (
            <div className="db-table__panel">
              {schemaLoading ? (
                <SkeletonRows rows={3} />
              ) : schemaColumns.length === 0 ? (
                <div className="db-list__empty">暂无结构信息。</div>
              ) : (
                <table className="db-sql__table">
                  <thead>
                    <tr>
                      {schemaColumns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {schemaRows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j} title={cell === null || cell === undefined ? '' : String(cell)}>
                            {cell === null || cell === undefined ? 'NULL' : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* 数据 Tab */}
          {tab === 'data' && (
            <div className="db-table__panel">
              <div className="db-table__toolbar">
                <span className="db-sql__hint">每页行数</span>
                <Select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} style={{ width: 90 }}>
                  <option value={10}>10</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </Select>
                <span className="db-table__page-info">
                  第 {page} / {totalPages} 页 · 共 {total} 行
                </span>
                <div className="db-table__page-actions">
                  <Button variant="ghost" size="sm" onClick={prevPage} disabled={page <= 1}>
                    上一页
                  </Button>
                  <Button variant="ghost" size="sm" onClick={nextPage} disabled={page >= totalPages}>
                    下一页
                  </Button>
                </div>
              </div>

              {dataLoading ? (
                <SkeletonRows rows={3} />
              ) : dataColumns.length === 0 ? (
                <div className="db-list__empty">暂无数据。</div>
              ) : (
                <table className="db-sql__table">
                  <thead>
                    <tr>
                      {dataColumns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataRows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j} title={cell === null || cell === undefined ? '' : String(cell)}>
                            {cell === null || cell === undefined ? 'NULL' : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {dataColumns.length === 0 && !dataLoading && (
                <div className="db-table__page-info" style={{ marginTop: 8 }}>
                  <Button variant="ghost" size="sm" onClick={loadData}>
                    刷新
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * 只读 SQL 查询面板：textarea 输入查询，后端仅允许 SELECT/SHOW 等只读语句，其余返回 403
 * @param param0 面板属性
 */
function SqlQueryPanel({
  instance,
  activeDb,
  databases,
}: {
  instance: DatabaseInstance;
  activeDb: string;
  databases: string[];
}) {
  const { showToast } = useToast();
  // SQL 执行为敏感能力，需操作员/管理员权限（后端 requireOperator 强制校验）
  const canManage = canOperate();
  const [sql, setSql] = useState('');
  const [db, setDb] = useState(activeDb);
  const [querying, setQuerying] = useState(false);
  const [result, setResult] = useState<SqlQueryResult | null>(null);

  // 当外部选中库变化时同步默认查询库
  useEffect(() => {
    if (activeDb && databases.includes(activeDb)) setDb(activeDb);
  }, [activeDb, databases]);

  /**
   * 执行查询并渲染结果
   */
  const runQuery = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可执行 SQL 查询', 'error');
      return;
    }
    if (!sql.trim()) return;
    setQuerying(true);
    try {
      const data = await post<SqlQueryResult>(`/api/databases/${instance.id}/query`, {
        sql: sql.trim(),
        db: db || undefined,
      });
      setResult(data);
      showToast(`查询完成，返回 ${data?.rowCount ?? 0} 行`, 'success');
    } catch (e: any) {
      setResult(null);
      showToast(e?.message || '查询失败，仅允许只读语句', 'error');
    } finally {
      setQuerying(false);
    }
  }, [instance.id, sql, db, showToast, canManage]);

  return (
    <div className="db-sql">
      <div className="db-sql__actions" style={{ justifyContent: 'flex-start' }}>
        <Select
          value={db}
          onChange={(e) => setDb(e.target.value)}
          style={{ width: 220 }}
        >
          <option value="">（不指定库）</option>
          {databases.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        <span className="db-sql__hint">仅允许 SELECT / SHOW 等只读语句</span>
      </div>
      <textarea
        className="input input--area db-sql__area"
        placeholder={canManage ? 'SELECT * FROM users LIMIT 50;' : '需要操作员/管理员权限方可执行 SQL 查询'}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        disabled={!canManage}
      />
      <div className="db-sql__actions">
        <Button
          variant="primary"
          size="sm"
          loading={querying}
          disabled={!sql.trim() || !canManage}
          onClick={runQuery}
        >
          执行查询
        </Button>
      </div>

      {result && (
        <div className="db-sql__result">
          {result.columns.length === 0 ? (
            <div className="db-list__empty">无返回结果（{result.rowCount} 行受影响）</div>
          ) : (
            <table className="db-sql__table">
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} title={cell === null || cell === undefined ? '' : String(cell)}>
                        {cell === null || cell === undefined ? 'NULL' : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Redis 视图：展示指标、键列表并支持删除键与刷新
 * @param param0 实例
 */
function RedisPanel({ instance }: { instance: DatabaseInstance }) {
  const { showToast } = useToast();
  const canDelete = canOperate();
  // Redis 命令交互为敏感能力，需操作员/管理员权限（后端 requireOperator 强制校验）
  const canManage = canOperate();
  const [keys, setKeys] = useState<RedisKeyItem[]>([]);
  const [info, setInfo] = useState<RedisInfo>({});
  const [pattern, setPattern] = useState('*');
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  // 待删除的键名
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 待查看详情的键（打开键详情弹窗）
  const [detailKey, setDetailKey] = useState<string | null>(null);

  /**
   * 加载 Redis 键列表
   * @param pat 匹配模式
   * @param lim 数量限制
   */
  const loadKeys = useCallback(
    async (pat: string, lim: number) => {
      if (!canManage) return;
      setLoading(true);
      try {
        const data = await post<{ keys?: RedisKeyItem[] | string[] } | RedisKeyItem[]>(
          `/api/databases/${instance.id}/redis/keys`,
          { pattern: pat || '*', limit: lim || 100 }
        );
        // 后端返回的 keys 可能是纯键名字符串数组，统一映射为 { key } 对象供列表渲染
        const rawKeys = Array.isArray(data) ? data : (data?.keys || []);
        setKeys(rawKeys.map((k) => (typeof k === 'string' ? { key: k } : k)));
      } catch (e: any) {
        showToast(e?.message || '加载键列表失败', 'error');
      } finally {
        setLoading(false);
      }
    },
    [instance.id, showToast, canManage]
  );

  /**
   * 加载 Redis 指标
   */
  const loadInfo = useCallback(async () => {
    if (!canManage) return;
    try {
      const data = await post<RedisInfo>(`/api/databases/${instance.id}/redis/info`);
      setInfo(data || {});
    } catch (e: any) {
      showToast(e?.message || '加载 Redis 指标失败', 'error');
    }
  }, [instance.id, showToast, canManage]);

  useEffect(() => {
    loadKeys(pattern, limit);
    loadInfo();
    // 首次仅加载默认模式，后续由用户操作触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id]);

  /**
   * 删除指定的 Redis 键（query 传 key，经确认框调用）
   */
  const handleDeleteKey = useCallback(async () => {
    if (!deleteKey) return;
    if (!canDelete) {
      showToast('需要操作员/管理员权限方可删除 Redis 键', 'error');
      setDeleteKey(null);
      return;
    }
    const key = deleteKey;
    setDeleting(true);
    try {
      await del(`/api/databases/${instance.id}/redis/keys`, { key });
      showToast(`已删除键 ${key}`);
      setDeleteKey(null);
      loadKeys(pattern, limit);
    } catch (e: any) {
      showToast(e?.message || '删除键失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canDelete, instance.id, deleteKey, pattern, limit, showToast, loadKeys]);

  /**
   * 挑选指标字段展示
   */
  const infoItems = useMemo(() => {
    const mapping: Array<[string, string]> = [
      ['usedMemoryHuman', '内存'],
      ['connectedClients', '连接数'],
      ['uptime', '运行时长'],
      ['keyspace', '键空间'],
      ['hitRate', '命中率'],
    ];
    return mapping
      .map(([key, label]) => ({ label, value: info[key] }))
      .filter((item) => item.value !== undefined && item.value !== null && item.value !== '');
  }, [info]);

  return (
    <div>
      <div className="db-redis__info">
        {infoItems.length === 0 && (
          <div className="db-redis__info-item">
            <div className="db-redis__info-label">状态</div>
            <div className="db-redis__info-value">已连接</div>
          </div>
        )}
        {infoItems.map((item) => (
          <div className="db-redis__info-item" key={item.label}>
            <div className="db-redis__info-label">{item.label}</div>
            <div className="db-redis__info-value">{String(item.value)}</div>
          </div>
        ))}
      </div>

      <div className="db-detail__section">
        <span className="db-detail__section-title">键列表 ({keys.length})</span>
        <div className="db-detail__section-actions">
          <Button variant="ghost" size="sm" onClick={() => loadKeys(pattern, limit)} disabled={!canManage}>
            刷新
          </Button>
        </div>
      </div>

      <div className="db-redis__toolbar">
        <Input
          className="db-redis__pattern"
          placeholder="匹配模式，如 * / user:*"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          disabled={!canManage}
        />
        <Input
          style={{ width: 90 }}
          placeholder="限制"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          disabled={!canManage}
        />
        <Button variant="secondary" size="sm" onClick={() => loadKeys(pattern, limit)} disabled={!canManage}>
          查询
        </Button>
      </div>

      {loading ? (
        <SkeletonRows rows={3} />
      ) : keys.length === 0 ? (
        <div className="db-list__empty">暂无匹配的键。</div>
      ) : (
        <div className="db-list">
          {keys.map((item) => (
            <div className="db-list__row" key={item.key}>
              <button
                type="button"
                className="db-list__name"
                title={`点击查看 ${item.key} 的值`}
                onClick={() => setDetailKey(item.key)}
              >
                {item.key}
              </button>
              <span className="db-list__meta">
                {item.type ? `${item.type}` : ''}
                {item.size !== undefined ? ` · ${item.size}` : ''}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setDeleteKey(item.key)} disabled={!canDelete}>
                删除
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* 删除键确认框 */}
      <ConfirmDialog
        open={!!deleteKey}
        title="删除键"
        message={`确定要删除 Redis 键 "${deleteKey || ''}" 吗？`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDeleteKey}
        onCancel={() => setDeleteKey(null)}
      />

      {/* 键详情弹窗 */}
      <RedisKeyModal
        open={!!detailKey}
        instance={instance}
        keyName={detailKey}
        onClose={() => setDetailKey(null)}
      />
    </div>
  );
}

/** Redis 键值查看接口的返回类型 */
interface RedisKeyValueResult {
  key: string;
  type: 'string' | 'list' | 'set' | 'zset' | 'hash' | 'none';
  ttl: number;
  value: unknown;
}

/**
 * Redis 键详情弹窗：展示类型、TTL 并按类型渲染键值
 * @param param0 弹窗属性
 */
function RedisKeyModal({
  open,
  instance,
  keyName,
  onClose,
}: {
  open: boolean;
  instance: DatabaseInstance;
  keyName: string | null;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  // 键值查询结果
  const [data, setData] = useState<RedisKeyValueResult | null>(null);
  const [loading, setLoading] = useState(false);

  // 打开时拉取键值
  useEffect(() => {
    if (!open || !keyName) return;
    setLoading(true);
    setData(null);
    (async () => {
      try {
        const res = await post<RedisKeyValueResult>(`/api/databases/${instance.id}/redis/key`, {
          key: keyName,
        });
        setData(res);
      } catch (e: any) {
        setData(null);
        showToast(e?.message || '加载键值失败', 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, keyName, instance.id, showToast]);

  /** 类型中文名映射 */
  const typeLabel = (t: string): string => {
    const map: Record<string, string> = {
      string: '字符串',
      list: '列表',
      set: '集合',
      zset: '有序集合',
      hash: '哈希',
      none: '不存在',
    };
    return map[t] || t;
  };

  /** 展示 TTL：-1 永久，-2 不存在，其余为秒 */
  const renderTtl = (ttl: number): string => {
    if (ttl === -1) return '永久';
    if (ttl === -2) return '不存在';
    return `${ttl} 秒`;
  };

  return (
    <Modal
      open={open}
      title={keyName ? `键详情 · ${keyName}` : '键详情'}
      onClose={onClose}
      width={640}
    >
      {loading ? (
        <SkeletonRows rows={3} />
      ) : !data ? (
        <div className="db-list__empty">暂无键信息。</div>
      ) : data.type === 'none' ? (
        <div className="db-list__empty">键不存在（可能已被删除）。</div>
      ) : (
        <div className="db-redis-key">
          {/* 键信息头 */}
          <div className="db-redis-key__head">
            <span className={`badge badge--primary`}>
              {typeLabel(data.type)}
            </span>
            <span className="db-redis-key__ttl">
              TTL：{renderTtl(data.ttl)}
            </span>
          </div>

          {/* 按类型渲染值 */}
          {data.type === 'string' && (
            <div className="db-redis-key__string">{String(data.value ?? '')}</div>
          )}

          {(data.type === 'list' || data.type === 'set') && (
            <div className="db-redis-key__scroll">
              {(Array.isArray(data.value) ? data.value : []).map((item, i) => (
                <div className="db-redis-key__row" key={i}>
                  <span className="db-card__row-value">{String(item)}</span>
                </div>
              ))}
            </div>
          )}

          {data.type === 'zset' && Array.isArray(data.value) && (
            <table className="db-sql__table">
              <thead>
                <tr>
                  <th>member</th>
                  <th>{'score'}</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // zset 的 value 为 member/score 交替的扁平数组
                  const arr = data.value as string[];
                  const rows: Array<[string, string]> = [];
                  for (let i = 0; i + 1 < arr.length; i += 2) {
                    rows.push([String(arr[i]), String(arr[i + 1])]);
                  }
                  return rows.map(([member, score], idx) => (
                    <tr key={idx}>
                      <td>{member}</td>
                      <td>{score}</td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          )}

          {data.type === 'hash' && Array.isArray(data.value) && (
            <table className="db-sql__table">
              <thead>
                <tr>
                  <th>field</th>
                  <th>value</th>
                </tr>
              </thead>
              <tbody>
                {(data.value as Array<{ field: unknown; value: unknown }>).map((item, idx) => (
                  <tr key={idx}>
                    <td>{String(item.field ?? '')}</td>
                    <td>{String(item.value ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * 数据级备份面板：列出实例的备份文件，支持发起备份、下载与删除
 * @param param0 面板属性
 */
function DbBackupPanel({
  instance,
  databases,
  payloadDb,
}: {
  instance: DatabaseInstance;
  databases: string[];
  payloadDb: string;
}) {
  const { showToast } = useToast();
  // 备份 / 刷新 / 恢复 / 删除备份为 operator 及以上（后端 requireOperator）
  const canManage = canOperate();
  // 下载备份文件（含全量数据）仅 admin 可用（后端 requireAdmin）
  const canDownload = isAdmin();
  const [backups, setBackups] = useState<Array<{ file: string; size: number; createdAt: number }>>([]);
  const [loading, setLoading] = useState(true);
  // 备份的目标库
  const [targetDb, setTargetDb] = useState(payloadDb);
  const [backingUp, setBackingUp] = useState(false);
  // 待删除的备份文件
  const [deleteFile, setDeleteFile] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 待恢复的备份文件（打开恢复确认弹窗）
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  // 恢复目标库（可为空，默认恢复至原库）
  const [restoreDb, setRestoreDb] = useState('');
  const [restoring, setRestoring] = useState(false);

  /**
   * 加载该实例的备份列表
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<{ backups: Array<{ file: string; size: number; createdAt: number }> }>(
        `/api/databases/${instance.id}/backups`
      );
      setBackups(data?.backups || []);
    } catch (e: any) {
      showToast(e?.message || '加载备份列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [instance.id, showToast]);

  useEffect(() => {
    if (canManage) load();
  }, [canManage, load]);

  // 外部选中库变化时同步备份目标库
  useEffect(() => {
    if (payloadDb && databases.includes(payloadDb)) setTargetDb(payloadDb);
  }, [payloadDb, databases]);

  /**
   * 发起一次备份
   */
  const handleBackup = useCallback(async () => {
    if (!canManage) {
      showToast('仅管理员可发起备份', 'error');
      return;
    }
    if (!targetDb.trim()) {
      showToast('请选择要备份的库', 'error');
      return;
    }
    setBackingUp(true);
    try {
      await post(`/api/databases/${instance.id}/backups`, { db: targetDb.trim() });
      showToast('备份已发起');
      load();
    } catch (e: any) {
      showToast(e?.message || '备份失败', 'error');
    } finally {
      setBackingUp(false);
    }
  }, [canManage, instance.id, targetDb, load, showToast]);

  /**
   * 确认删除备份文件
   */
  const handleDelete = useCallback(async () => {
    if (!deleteFile) return;
    if (!canManage) {
      showToast('需要操作员/管理员权限方可删除备份', 'error');
      setDeleteFile(null);
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/databases/${instance.id}/backups/${encodeURIComponent(deleteFile)}`);
      showToast('已删除备份文件');
      setDeleteFile(null);
      load();
    } catch (e: any) {
      showToast(e?.message || '删除失败', 'error');
    } finally {
      setDeleting(false);
    }
  }, [canManage, instance.id, deleteFile, load, showToast]);

  /**
   * 确认恢复备份：POST restore，成功后展示结果并刷新备份列表
   */
  const handleRestore = useCallback(async () => {
    if (!restoreFile) return;
    if (!canManage) {
      showToast('仅管理员可恢复备份', 'error');
      setRestoreFile(null);
      return;
    }
    const file = restoreFile;
    setRestoring(true);
    try {
      const data = await post<{ ok: boolean; restoredDb?: string }>(
        `/api/databases/${instance.id}/backups/${encodeURIComponent(file)}/restore`,
        { db: restoreDb.trim() || undefined }
      );
      setRestoreFile(null);
      if (data?.ok) {
        const msg = data.restoredDb
          ? `已恢复到数据库 ${data.restoredDb}`
          : '备份恢复成功';
        showToast(msg, 'success');
      } else {
        showToast('备份恢复失败', 'error');
      }
      load();
    } catch (e: any) {
      showToast(e?.message || '备份恢复失败', 'error');
    } finally {
      setRestoring(false);
    }
  }, [canManage, instance.id, restoreFile, restoreDb, load, showToast]);

  /**
   * 格式化文件大小
   * @param bytes 字节数
   */
  function formatSize(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /**
   * 格式化时间
   * @param ms 毫秒时间戳
   */
  function formatTime(ms: number): string {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  return (
    <div className="db-backup">
      <div className="db-detail__section">
        <span className="db-detail__section-title">数据备份 ({backups.length})</span>
        <div className="db-detail__section-actions">
          {databases.length > 0 && (
            <Select value={targetDb} onChange={(e) => setTargetDb(e.target.value)} style={{ width: 160 }}>
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          )}
          <Button
            variant="primary"
            size="sm"
            loading={backingUp}
            disabled={!canManage || databases.length === 0}
            onClick={handleBackup}
          >
            备份
          </Button>
          <Button variant="ghost" size="sm" onClick={load} disabled={!canManage}>
            刷新
          </Button>
        </div>
      </div>

      <div className="db-sql__hint" style={{ marginBottom: 8 }}>
        将所选库导出为压缩 SQL 文件（逻辑备份），可下载留存。Redis 暂不支持。
      </div>

      {loading ? (
        <SkeletonRows rows={3} />
      ) : backups.length === 0 ? (
        <div className="db-list__empty">暂无备份文件，选择库后点击「备份」创建。</div>
      ) : (
        <div className="db-list">
          {backups.map((b) => (
            <div className="db-list__row" key={b.file}>
              <span className="db-list__name" style={{ cursor: 'default' }} title={b.file}>
                {b.file}
              </span>
              <span className="db-list__meta">
                {formatSize(b.size)} · {formatTime(b.createdAt)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  download(`/api/databases/${instance.id}/backups/${encodeURIComponent(b.file)}/download`)
                }
                disabled={!canDownload}
              >
                下载
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRestoreDb('');
                  setRestoreFile(b.file);
                }}
                disabled={!canManage}
              >
                恢复
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDeleteFile(b.file)} disabled={!canManage}>
                删除
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* 备份恢复确认弹窗 */}
      <Modal
        open={!!restoreFile}
        title="恢复备份"
        onClose={() => !restoring && setRestoreFile(null)}
        width={460}
        footer={
          <div className="db-modal__footer">
            <Button variant="ghost" size="md" onClick={() => setRestoreFile(null)} disabled={restoring}>
              取消
            </Button>
            <Button variant="primary" size="md" loading={restoring} onClick={handleRestore} disabled={!canManage}>
              确认恢复
            </Button>
          </div>
        }
      >
        <div className="db-restore">
          <div className="db-detail__info">
            实例：<span className="db-card__row-value">{instance.name}</span> · 备份文件：
            <span className="db-card__row-value">{restoreFile || ''}</span>
          </div>
          <Field label="目标库" hint="留空则恢复到备份来源库（可选）">
            <Input
              value={restoreDb}
              placeholder="例如：restore_db（可空）"
              onChange={(e) => setRestoreDb(e.target.value)}
              disabled={!canManage}
            />
          </Field>
          <div className="db-sql__hint">恢复将使用备份文件覆盖指定库的数据，操作前请确认。</div>
        </div>
      </Modal>

      {/* 删除备份确认框 */}
      <ConfirmDialog
        open={!!deleteFile}
        title="删除备份文件"
        message={`确定要删除备份文件 "${deleteFile || ''}" 吗？删除后不可恢复。`}
        confirmText="删除"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteFile(null)}
      />
    </div>
  );
}
