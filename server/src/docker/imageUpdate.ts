/**
 * 容器镜像自动更新 + 回滚
 *
 * 扫描 container_auto_updates 表中启用的条目：
 *   1. 拉取容器镜像的同名 tag（复用 pullWithFailover 多源容灾）
 *   2. 比较新旧镜像 ID，无更新则跳过
 *   3. 有更新则按原配置快照重建（端口/卷/环境变量/网络/能力位/健康检查等）
 *   4. 15 秒后健康检查：运行中且非 unhealthy 视为成功；失败用旧镜像回滚重建
 *
 * 扫描以 'imageUpdate' 类型注册到计划任务调度器，周期在计划任务页配置。
 */
import Dockerode from 'dockerode';
import { getDb } from '../storage';
import { getDockerClient } from './client';
import { pullWithFailover } from './pull';
import { reportTaskFailure } from '../alerting';

export interface AutoUpdateRow {
  id: number;
  container_id: string;
  container_name: string;
  image_ref: string;
  last_check_at: number | null;
  last_status: string | null; // ok | updated | rolledback | fail
  last_result: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ScanOutcome {
  containerId: string;
  containerName: string;
  status: 'ok' | 'updated' | 'rolledback' | 'fail';
  detail: string;
}

/** 健康判定：运行中且非 unhealthy */
function isHealthy(info: Dockerode.ContainerInspectInfo): boolean {
  const health = (info.State as any)?.Health;
  return !!info.State?.Running && (!health || health.Status !== 'unhealthy');
}

/** 从 inspect 快照 createContainer 所需配置（image 参数用于替换镜像） */
function snapshotCreateOpts(inspect: Dockerode.ContainerInspectInfo, image?: string): Dockerode.ContainerCreateOptions {
  const hc = (inspect.HostConfig || {}) as any;
  return {
    Image: image || inspect.Config?.Image || '',
    Cmd: inspect.Config?.Cmd || undefined,
    Entrypoint: inspect.Config?.Entrypoint || undefined,
    WorkingDir: inspect.Config?.WorkingDir || undefined,
    User: inspect.Config?.User || undefined,
    Hostname: inspect.Config?.Hostname || undefined,
    Env: inspect.Config?.Env || undefined,
    Labels: inspect.Config?.Labels || undefined,
    Healthcheck: inspect.Config?.Healthcheck || undefined,
    ExposedPorts: inspect.Config?.ExposedPorts || undefined,
    OpenStdin: inspect.Config?.OpenStdin,
    Tty: inspect.Config?.Tty,
    HostConfig: {
      Binds: hc.Binds || undefined,
      PortBindings: hc.PortBindings || undefined,
      RestartPolicy: hc.RestartPolicy || undefined,
      NetworkMode: hc.NetworkMode || undefined,
      Privileged: hc.Privileged,
      AutoRemove: hc.AutoRemove,
      CapAdd: hc.CapAdd || undefined,
      CapDrop: hc.CapDrop || undefined,
      Devices: hc.Devices || undefined,
      ExtraHosts: hc.ExtraHosts || undefined,
      Dns: hc.Dns || undefined,
      Tmpfs: hc.Tmpfs || undefined,
      SecurityOpt: hc.SecurityOpt || undefined,
      Sysctls: hc.Sysctls || undefined,
      ShmSize: hc.ShmSize,
      Memory: hc.Memory,
      NanoCpus: hc.NanoCpus,
      LogConfig: hc.LogConfig,
    } as any,
  };
}

/** 写回扫描行状态 */
function updateRow(rowId: number, status: string, detail: string, autoDisable = false): void {
  try {
    if (autoDisable) {
      getDb()
        .prepare(
          'UPDATE container_auto_updates SET enabled = 0, last_check_at = ?, last_status = ?, last_result = ?, updated_at = ? WHERE id = ?',
        )
        .run(Date.now(), status, detail, Date.now(), rowId);
      return;
    }
    getDb()
      .prepare(
        'UPDATE container_auto_updates SET last_check_at = ?, last_status = ?, last_result = ?, updated_at = ? WHERE id = ?',
      )
      .run(Date.now(), status, detail, Date.now(), rowId);
  } catch {
    // 状态写库失败不影响扫描
  }
}

/** 扫描单个自动更新条目 */
export async function checkOne(row: AutoUpdateRow): Promise<ScanOutcome> {
  const docker = await getDockerClient();
  const name = row.container_name || row.container_id.slice(0, 12);
  let inspect: Dockerode.ContainerInspectInfo;
  try {
    inspect = await docker.getContainer(row.container_id).inspect();
  } catch {
    const detail = '容器不存在或已被删除，自动更新条目已自动停用';
    updateRow(row.id, 'fail', detail, true);
    return { containerId: row.container_id, containerName: name, status: 'fail', detail };
  }

  const cNameStr = (inspect.Name || '').replace(/^\//, '') || name;
  const ref = inspect.Config?.Image || row.image_ref || '';

  // 摘要固定的镜像无法跟随 tag 更新
  if (!ref || ref.includes('@sha256:')) {
    const detail = ref ? `镜像以摘要固定（${ref.slice(0, 40)}…），跳过自动更新` : '无法识别容器镜像引用';
    updateRow(row.id, 'ok', detail);
    return { containerId: row.container_id, containerName: cNameStr, status: 'ok', detail };
  }

  // 1. 拉取同名 tag（多源容灾）
  try {
    await pullWithFailover(docker, ref);
  } catch (e: any) {
    const detail = `镜像拉取失败: ${String(e?.message || e)}`;
    updateRow(row.id, 'fail', detail);
    return { containerId: row.container_id, containerName: cNameStr, status: 'fail', detail };
  }

  // 2. 比较新旧镜像 ID
  const localId = inspect.Image || '';
  let newId = '';
  try {
    newId = (await docker.getImage(ref).inspect()).Id;
  } catch {
    // ignore
  }
  if (!newId || newId === localId) {
    const detail = '本地镜像已是最新';
    updateRow(row.id, 'ok', detail);
    return { containerId: row.container_id, containerName: cNameStr, status: 'ok', detail };
  }

  // 3. 按原配置重建
  const wasRunning = !!inspect.State?.Running;
  try {
    const created = await docker.createContainer({
      ...snapshotCreateOpts(inspect, ref),
      name: `${cNameStr}-upd-${Date.now()}`,
    });
    const newId2 = created.id;

    // 停旧 → 删旧 → 改名 → 启动
    const old = docker.getContainer(row.container_id);
    if (wasRunning) {
      try {
        await old.stop();
      } catch {
        // 忽略已停止
      }
    }
    await old.remove({ force: true });
    await created.rename({ name: cNameStr });
    if (wasRunning) {
      await created.start();
    }

    // 4. 健康检查（15 秒），未通过则回滚旧镜像
    await new Promise((r) => setTimeout(r, 15000));
    let after: Dockerode.ContainerInspectInfo;
    try {
      after = await docker.getContainer(newId2).inspect();
    } catch {
      throw new Error('更新后容器消失');
    }
    if (wasRunning && !isHealthy(after)) {
      const rb = await docker.createContainer({
        ...snapshotCreateOpts(after, localId),
        name: `${cNameStr}-rb-${Date.now()}`,
      });
      await rb.start();
      try {
        await docker.getContainer(newId2).remove({ force: true });
      } catch {
        // ignore
      }
      await rb.rename({ name: cNameStr });
      const detail = `更新后健康检查未通过，已回滚旧镜像 ${localId.slice(0, 12)}`;
      updateRow(row.id, 'rolledback', detail);
      reportTaskFailure(`容器镜像自动更新【${cNameStr}】`, detail, 'image-update');
      return { containerId: newId2, containerName: cNameStr, status: 'rolledback', detail };
    }

    const detail = `已更新镜像 ${localId.slice(0, 12)} → ${newId.slice(0, 12)}${wasRunning ? '' : '（原为停止状态，保持停止）'}`;
    updateRow(row.id, 'updated', detail);
    return { containerId: newId2, containerName: cNameStr, status: 'updated', detail };
  } catch (e: any) {
    const detail = `重建失败: ${String(e?.message || e)}`;
    updateRow(row.id, 'fail', detail);
    reportTaskFailure(`容器镜像自动更新【${cNameStr}】`, detail, 'image-update');
    return { containerId: row.container_id, containerName: cNameStr, status: 'fail', detail };
  }
}

/** 扫描全部启用条目（imageUpdate 计划任务入口） */
export async function runImageUpdateScan(operator = 'scheduler'): Promise<{ ok: boolean; detail: string }> {
  const rows = getDb()
    .prepare('SELECT * FROM container_auto_updates WHERE enabled = 1')
    .all() as unknown as AutoUpdateRow[];
  if (!rows.length) {
    return { ok: true, detail: '没有启用的自动更新容器' };
  }
  const outcomes: ScanOutcome[] = [];
  for (const row of rows) {
    try {
      outcomes.push(await checkOne(row));
    } catch (e: any) {
      outcomes.push({
        containerId: row.container_id,
        containerName: row.container_name,
        status: 'fail',
        detail: String(e?.message || e),
      });
    }
  }
  const updated = outcomes.filter((o) => o.status === 'updated').length;
  const rolled = outcomes.filter((o) => o.status === 'rolledback').length;
  const failed = outcomes.filter((o) => o.status === 'fail').length;
  const detail = `检查 ${outcomes.length} 个容器：更新 ${updated}，回滚 ${rolled}，失败 ${failed}，无变化 ${
    outcomes.length - updated - rolled - failed
  }`;
  return { ok: failed === 0, detail };
}
