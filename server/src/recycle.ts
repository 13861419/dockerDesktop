/**
 * 容器回收站模块
 *
 * 容器经面板删除时自动捕获完整配置快照（docker inspect JSON）存入 SQLite
 * 的 container_recycle 表，支持一键按原配置重建。
 *
 * 设计要点：
 *  - 快照捕获为尽力而为：inspect 失败不阻塞删除流程
 *  - 保留最近 MAX_RECYCLE_RECORDS 条，超出自动清理最旧记录
 *  - 恢复时从快照挑选安全子集组装 ContainerCreateOptions（不透传运行时解析字段）
 */
import type Dockerode from 'dockerode';
import { getDb } from './storage';

/** 回收站最大保留条数（超出自动清理最旧记录） */
export const MAX_RECYCLE_RECORDS = 100;

export interface RecycleRecord {
  id: number;
  name: string;
  image: string | null;
  /** docker inspect JSON 快照 */
  config: string;
  deleted_by: string | null;
  deleted_at: number;
}

/**
 * 删除前捕获容器配置快照（尽力而为，失败返回 false 不阻塞删除流程）
 * @param docker dockerode 实例
 * @param id 容器 ID 或名称
 * @param deletedBy 操作人（审计用）
 */
export async function captureContainerSnapshot(
  docker: Dockerode,
  id: string,
  deletedBy?: string,
): Promise<boolean> {
  try {
    const info = await docker.getContainer(id).inspect();
    const name = (info.Name || '').replace(/^\//, '');
    getDb()
      .prepare(
        'INSERT INTO container_recycle (name, image, config, deleted_by, deleted_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(name, info.Config?.Image || null, JSON.stringify(info), deletedBy || null, Date.now());
    trimRecycle();
    return true;
  } catch {
    return false;
  }
}

/** 保留最近 MAX_RECYCLE_RECORDS 条，超出清理最旧记录 */
export function trimRecycle(): void {
  getDb()
    .prepare(
      'DELETE FROM container_recycle WHERE id NOT IN (SELECT id FROM container_recycle ORDER BY id DESC LIMIT ?)',
    )
    .run(MAX_RECYCLE_RECORDS);
}

/** 列出回收站记录（不含快照明文，按删除时间倒序） */
export function listRecycle(): Array<{
  id: number;
  name: string;
  image: string | null;
  deleted_by: string | null;
  deleted_at: number;
}> {
  return getDb()
    .prepare(
      'SELECT id, name, image, deleted_by, deleted_at FROM container_recycle ORDER BY id DESC',
    )
    .all() as unknown as Array<{
    id: number;
    name: string;
    image: string | null;
    deleted_by: string | null;
    deleted_at: number;
  }>;
}

/** 读取单条记录（含快照），不存在返回 undefined */
export function getRecycle(id: number): RecycleRecord | undefined {
  return getDb()
    .prepare('SELECT id, name, image, config, deleted_by, deleted_at FROM container_recycle WHERE id = ?')
    .get(id) as RecycleRecord | undefined;
}

/** 删除单条记录 */
export function deleteRecycle(id: number): void {
  getDb().prepare('DELETE FROM container_recycle WHERE id = ?').run(id);
}

/** 清空回收站 */
export function purgeRecycle(): void {
  getDb().prepare('DELETE FROM container_recycle').run();
}

/**
 * 从 inspect 快照组装安全的创建参数（纯函数，供恢复与单测使用）
 *
 * 只透传创建时可确定的字段：镜像 / 命令 / 环境变量 / 标签 / 端口 / 挂载 /
 * 重启策略 / 网络模式 / 特权 / 资源限制 / 健康检查等；运行时解析字段
 * （Links、NetworkSettings 等）一律不透传，避免历史快照字段污染创建请求。
 *
 * @param cfg docker inspect JSON（Config + HostConfig）
 * @param name 恢复后的容器名（可不同于原名）
 */
export function buildCreateOptionsFromSnapshot(
  cfg: any,
  name: string,
): Dockerode.ContainerCreateOptions {
  const c = cfg?.Config || {};
  const h = cfg?.HostConfig || {};

  // ExposedPorts：优先 Config.ExposedPorts，回退 PortBindings 的键
  let exposedPorts = c.ExposedPorts;
  if ((!exposedPorts || Object.keys(exposedPorts).length === 0) && h.PortBindings) {
    exposedPorts = Object.keys(h.PortBindings).reduce(
      (acc: Record<string, Record<string, unknown>>, k: string) => {
        acc[k] = {};
        return acc;
      },
      {},
    );
  }

  // 重启策略：no/空 不透传（MaximumRetryCount 仅 on-failure 有效）
  const policyName = h.RestartPolicy?.Name;
  const restartPolicy =
    policyName && policyName !== 'no'
      ? { Name: policyName, MaximumRetryCount: h.RestartPolicy.MaximumRetryCount || 0 }
      : undefined;

  return {
    name,
    Image: c.Image,
    Cmd: Array.isArray(c.Cmd) && c.Cmd.length ? c.Cmd : undefined,
    Entrypoint: Array.isArray(c.Entrypoint) && c.Entrypoint.length ? c.Entrypoint : undefined,
    User: c.User || undefined,
    WorkingDir: c.WorkingDir || undefined,
    Hostname: c.Hostname || undefined,
    Labels: c.Labels || undefined,
    Env: Array.isArray(c.Env) && c.Env.length ? c.Env : undefined,
    ExposedPorts: exposedPorts,
    Healthcheck:
      c.Healthcheck?.Test?.length
        ? {
            Test: c.Healthcheck.Test,
            Interval: c.Healthcheck.Interval || undefined,
            Timeout: c.Healthcheck.Timeout || undefined,
            Retries: c.Healthcheck.Retries ?? 3,
          }
        : undefined,
    Tty: c.Tty === true,
    OpenStdin: c.OpenStdin === true,
    HostConfig: {
      Binds: Array.isArray(h.Binds) && h.Binds.length ? h.Binds : undefined,
      PortBindings: h.PortBindings || undefined,
      RestartPolicy: restartPolicy,
      NetworkMode: h.NetworkMode || 'default',
      Privileged: h.Privileged === true,
      AutoRemove: h.AutoRemove === true,
      Memory: h.Memory > 0 ? h.Memory : undefined,
      NanoCpus: h.NanoCpus > 0 ? h.NanoCpus : undefined,
      ExtraHosts: Array.isArray(h.ExtraHosts) && h.ExtraHosts.length ? h.ExtraHosts : undefined,
      CapAdd: Array.isArray(h.CapAdd) && h.CapAdd.length ? h.CapAdd : undefined,
      CapDrop: Array.isArray(h.CapDrop) && h.CapDrop.length ? h.CapDrop : undefined,
    },
  };
}
