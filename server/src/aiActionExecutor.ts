/**
 * AI Action 执行引擎
 *
 * 审批通过后的操作自动执行，使用 dockerode 操作 Docker 容器/镜像。
 * 支持操作：重启/停止/启动/删除容器，删除镜像，系统清理。
 * 执行结果写回 ai_actions.result 字段。
 */
import { getDockerClient } from './docker/client';
import { getAction, markExecuted, type AiAction } from './aiActions';
import Dockerode from 'dockerode';

export interface ExecuteResult {
  ok: boolean;
  actionId: number;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * 执行已批准的 AI 操作
 */
export async function executeAction(actionId: number): Promise<ExecuteResult> {
  const action = getAction(actionId);
  if (!action) return { ok: false, actionId, message: '操作不存在' };
  if (action.status !== 'approved') return { ok: false, actionId, message: `操作状态为 ${action.status}，无法执行` };

  try {
    const docker = await getDockerClient();
    const result = await runAction(docker, action);
    markExecuted(actionId, result.message, result.ok);
    return { ok: result.ok, actionId, message: result.message, details: result.details };
  } catch (err: any) {
    const msg = err?.message || '执行失败';
    markExecuted(actionId, msg, false);
    return { ok: false, actionId, message: msg };
  }
}

/**
 * 根据操作类型分发到具体的 Docker 操作
 */
async function runAction(docker: Dockerode, action: AiAction): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
  const { actionType, params } = action;

  switch (actionType) {
    case 'restart_container': {
      const containerId = params.containerId as string;
      if (!containerId) return { ok: false, message: '缺少 containerId 参数' };
      const container = docker.getContainer(containerId);
      await container.restart({ t: 10 });
      return { ok: true, message: `容器 ${containerId.slice(0, 12)} 已重启` };
    }

    case 'stop_container': {
      const containerId = params.containerId as string;
      if (!containerId) return { ok: false, message: '缺少 containerId 参数' };
      const container = docker.getContainer(containerId);
      await container.stop({ t: 10 });
      return { ok: true, message: `容器 ${containerId.slice(0, 12)} 已停止` };
    }

    case 'start_container': {
      const containerId = params.containerId as string;
      if (!containerId) return { ok: false, message: '缺少 containerId 参数' };
      const container = docker.getContainer(containerId);
      await container.start();
      return { ok: true, message: `容器 ${containerId.slice(0, 12)} 已启动` };
    }

    case 'remove_container': {
      const containerId = params.containerId as string;
      if (!containerId) return { ok: false, message: '缺少 containerId 参数' };
      const force = params.force === true;
      const container = docker.getContainer(containerId);
      await container.remove({ force, v: !!params.removeVolumes });
      return { ok: true, message: `容器 ${containerId.slice(0, 12)} 已删除${force ? '（强制）' : ''}` };
    }

    case 'remove_image': {
      const imageId = params.imageId as string;
      if (!imageId) return { ok: false, message: '缺少 imageId 参数' };
      const image = docker.getImage(imageId);
      await image.remove({ force: true });
      return { ok: true, message: `镜像 ${imageId.slice(0, 12)} 已删除` };
    }

    case 'system_prune': {
      const result = await docker.pruneContainers();
      const imagesResult = await docker.pruneImages();
      const volumesResult = await docker.pruneVolumes();
      const msg = `系统清理完成：容器 ${result.ContainersDeleted?.length || 0} 个，镜像 ${imagesResult.ImagesDeleted?.length || 0} 个，卷 ${volumesResult.VolumesDeleted?.length || 0} 个`;
      return {
        ok: true,
        message: msg,
        details: {
          containers: result.ContainersDeleted?.length || 0,
          images: imagesResult.ImagesDeleted?.length || 0,
          volumes: volumesResult.VolumesDeleted?.length || 0,
          spaceReclaimed: (result.SpaceReclaimed || 0) + (imagesResult.SpaceReclaimed || 0),
        },
      };
    }

    case 'restart_network': {
      const networkId = params.networkId as string;
      if (!networkId) return { ok: false, message: '缺少 networkId 参数' };
      // Docker API 不支持直接 restart network，通过 disconnect + reconnect 实现
      const network = docker.getNetwork(networkId);
      // 获取网络信息
      const info = await network.inspect();
      const containers = info.Containers || {};
      const containerIds = Object.keys(containers);
      if (containerIds.length === 0) return { ok: true, message: `网络 ${info.Name} 无连接容器` };
      // 逐个断开再重连
      for (const cid of containerIds) {
        const net = docker.getNetwork(networkId);
        await net.disconnect({ Container: cid, Force: true });
        await net.connect({ Container: cid });
      }
      return { ok: true, message: `网络 ${info.Name} 已重启（${containerIds.length} 个容器重新连接）` };
    }

    case 'prune_volumes': {
      const result = await docker.pruneVolumes();
      const count = result.VolumesDeleted?.length || 0;
      return { ok: true, message: `已清理 ${count} 个数据卷，释放 ${(result.SpaceReclaimed || 0) / 1024 / 1024}MB`, details: { volumes: count, spaceReclaimed: result.SpaceReclaimed } };
    }

    case 'exec_command': {
      const containerId = params.containerId as string;
      const cmd = params.command as string;
      if (!containerId) return { ok: false, message: '缺少 containerId 参数' };
      if (!cmd) return { ok: false, message: '缺少 command 参数' };
      const container = docker.getContainer(containerId);
      // 在容器内执行命令
      const exec = await container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ Detach: false, Tty: false });
      // 读取输出（最多 10KB）
      const chunks: Buffer[] = [];
      let totalLen = 0;
      for await (const chunk of stream) {
        chunks.push(chunk);
        totalLen += chunk.length;
        if (totalLen > 10240) break;
      }
      const output = Buffer.concat(chunks).toString('utf-8').slice(0, 2000);
      const inspect = await exec.inspect();
      const exitCode = inspect.ExitCode ?? 0;
      return { ok: exitCode === 0, message: exitCode === 0 ? `命令执行成功` : `命令执行失败（退出码 ${exitCode}）`, details: { exitCode, output } };
    }

    default:
      return { ok: false, message: `不支持的操作类型: ${actionType}` };
  }
}
