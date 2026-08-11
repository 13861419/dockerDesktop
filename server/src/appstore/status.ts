/**
 * 应用商店安装状态
 *
 * 根据容器 label (APP_LABEL_KEY) 关联应用与容器，提供查询应用安装状态的能力。
 */
import { getDockerClient } from '../docker/client';
import { APP_LABEL_KEY, AppDefinition } from './catalog';
import type Dockerode from 'dockerode';

/** 应用安装状态 */
export interface AppStatus {
  /** 应用 id */
  id: string;
  /** 是否已安装（存在对应容器） */
  installed: boolean;
  /** 对应容器 id */
  containerId?: string;
  /** 对应容器名称 */
  containerName?: string;
  /** 容器是否运行中 */
  running?: boolean;
  /** 主端口映射，形如 "host:container"，无映射时为 null */
  port?: string | null;
}

/** dockerode listContainers 返回的容器列表项 */
type ContainerListEntry = Dockerode.ContainerInfo;

/**
 * 列出所有带应用标签的容器，并以应用 id 为键建立映射
 *
 * 供各接口复用，避免重复调用 listContainers。
 * @returns Map<appId, 容器列表项>
 */
export async function listContainersByAppLabel(): Promise<Map<string, ContainerListEntry>> {
  const docker = await getDockerClient();
  const containers = await docker.listContainers({ all: true });
  const byLabel = new Map<string, ContainerListEntry>();
  for (const c of containers) {
    const appId = c.Labels?.[APP_LABEL_KEY];
    if (appId) {
      byLabel.set(appId, c);
    }
  }
  return byLabel;
}

/**
 * 根据容器列表项提取应用状态
 * @param app 应用定义
 * @param entry 容器列表项（可选，不存在表示未安装）
 * @returns 应用安装状态
 */
export function mapContainerToStatus(app: AppDefinition, entry?: ContainerListEntry): AppStatus {
  if (!entry) {
    return { id: app.id, installed: false };
  }
  return {
    id: app.id,
    installed: true,
    containerId: entry.Id || undefined,
    containerName: (entry.Names?.[0] || '').replace(/^\//, '') || undefined,
    running: entry.State === 'running' || undefined,
    port: buildAppPort(entry),
  };
}

/**
 * 从容器列表项中计算应用展示用的主端口（取第一个端口映射）
 * @param entry 容器列表项
 * @returns 形如 "host:container" 的字符串，无端口映射时为 null
 */
function buildAppPort(entry: ContainerListEntry): string | null {
  const ports = entry.Ports || [];
  const p = ports[0];
  if (!p) return null;
  const host = p.PublicPort ? String(p.PublicPort) : '未知';
  return `${host}:${p.PrivatePort}`;
}

/**
 * 查询单个应用的安装状态
 * @param app 应用定义
 * @returns 该应用的安装状态
 */
export async function getAppStatus(app: AppDefinition): Promise<AppStatus> {
  const byLabel = await listContainersByAppLabel();
  return mapContainerToStatus(app, byLabel.get(app.id));
}
