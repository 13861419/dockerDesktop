/**
 * 后端 API 数据类型定义
 *
 * 与 server 端各路由返回的 JSON 结构保持一致。
 */

/** Docker 引擎总览信息 */
export interface Overview {
  serverVersion: string;
  name?: string;
  id?: string;
  driver?: string;
  dockerRootDir?: string;
  operatingSystem?: string;
  os: string;
  architecture: string;
  kernelVersion: string;
  nCPU: number;
  memTotal: number;
  containers: { total: number; running: number; stopped: number };
  images: number;
  volumes: number;
  networks: number;
  swarm: string;
}

/** Docker 系统信息（/api/system/info） */
export interface SystemInfo {
  ServerVersion: string;
  OperatingSystem: string;
  Architecture: string;
  KernelVersion: string;
  NCPU: number;
  MemTotal: number;
  Containers: number;
  Images: number;
  Name: string;
  ID: string;
  DockerRootDir: string;
  Driver: string;
  [key: string]: unknown;
}

/** Docker 版本信息 */
export interface DockerVersion {
  ApiVersion: string;
  Os: string;
  Arch: string;
  KernelVersion: string;
  MinAPIVersion: string;
  Version: string;
  GitCommit: string;
  Platform: { Name: string };
  [key: string]: unknown;
}

/** 容器列表项（/api/containers 返回的原生 dockerode 结构） */
export interface ContainerListItem {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  Ports: Array<{
    IP?: string;
    PrivatePort: number;
    PublicPort?: number;
    Type: string;
  }>;
  Labels: Record<string, string>;
  State: string;
  Status: string;
  /** 健康检查状态（none 表示未配置健康检查或 inspect 失败） */
  health?: 'starting' | 'healthy' | 'unhealthy' | 'none';
  /** CPU 限制（NanoCpus 纳核，0 表示不限制） */
  cpuLimit?: number;
  /** 内存限制（字节，0 表示不限制） */
  memLimit?: number;
  SizeRw?: number;
  SizeRootFs?: number;
}

/** 容器详情/格式化后的精简结构 */
export interface ContainerDetail {
  id: string;
  idShort: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  running: boolean;
  restarting: boolean;
  exited: boolean;
  created: string;
  startedAt: string;
  exitCode: number | null;
  ports: Array<{ internal: string; published: string[] }>;
  mainPort: string;
  networks: string[];
  labels: Record<string, string>;
  restartPolicy: string;
  command: string;
}

/** 容器资源统计 */
export interface ContainerStats {
  cpuPercent: number;
  memory: { usage: number; limit: number; percent: number };
  network: { rx: number; tx: number };
  blockRead?: number;
  blockWrite?: number;
  pids: number;
}

/** 镜像列表项 */
export interface ImageItem {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[];
  ParentId: string;
  Size: number;
  VirtualSize?: number;
  SharedSize: number;
  Created: number;
  /** 本地拉取时间（秒），无记录时省略 */
  pullTime?: number;
  Containers: number;
  Labels: Record<string, string>;
}

/** 数据卷 */
export interface VolumeItem {
  CreatedAt: string;
  Driver: string;
  Labels: Record<string, string> | null;
  Mountpoint: string;
  Name: string;
  Options: Record<string, string> | null;
  Scope: string;
  [key: string]: unknown;
}

/** 网络 */
export interface NetworkItem {
  Name: string;
  Id: string;
  Created: string;
  Scope: string;
  Driver: string;
  EnableIPv6: boolean;
  IPAM: { Driver: string; Options: Record<string, string>; Config: any[] };
  Internal: boolean;
  Attachable: boolean;
  Ingress: boolean;
  ConfigFrom: { Network: string } | null;
  ConfigOnly: boolean;
  Containers: Record<string, unknown>;
  Options: Record<string, string>;
  Labels: Record<string, string>;
}

/** Compose 项目 */
export interface ComposeProject {
  name: string;
  path: string;
  composeFile: string | null;
  hasCompose: boolean;
}

/** Compose 服务状态 */
export interface ComposeService {
  ID: string;
  Name: string;
  Image: string;
  Command: string;
  Project: string;
  Service: string;
  Created: string;
  State: string;
  Status: string;
  Health: string;
  Ports: number[];
}

/** Compose 模板（/api/compose-templates 返回，存用户保存的常用 YAML 配置） */
export interface ComposeTemplate {
  /** 模板唯一标识 */
  id: string;
  /** 模板名称（唯一） */
  name: string;
  /** 模板描述（可选） */
  description: string;
  /** 完整的 docker-compose.yml 文本 */
  content: string;
  /** 创建时间（秒） */
  createdAt: number;
  /** 更新时间（秒） */
  updatedAt: number;
}

/** 容器端口映射（/api/containers/:id/detail 返回结构） */
export interface ContainerDetailPort {
  internal: string;
  published: Array<{ hostIp: string; hostPort: string }>;
}

/** 容器挂载卷（/api/containers/:id/detail 返回结构） */
export interface ContainerDetailMount {
  type: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

/** 容器网络（/api/containers/:id/detail 返回结构） */
export interface ContainerDetailNetwork {
  name: string;
  ipAddress: string;
  gateway: string;
  aliases: string[];
  macAddress: string;
}

/** 容器健康检查日志条目（/api/containers/:id/detail 返回结构） */
export interface ContainerHealthLog {
  start: string;
  exit: number;
  output: string;
}

/** 容器健康检查状态（/api/containers/:id/detail 返回结构，null 表示未配置） */
export interface ContainerHealth {
  status: string;
  failingStreak: number;
  log: ContainerHealthLog[];
}

/** 宿主机端口占用冲突映射（/api/containers/ports 返回结构，key 为 HostPort） */
export type ContainerPortConflicts = Record<
  string,
  Array<{ containerId: string; containerName: string }>
>;

/** 容器完整详情（/api/containers/:id/detail 返回结构） */
export interface ContainerDetailInfo {
  id: string;
  idShort: string;
  name: string;
  image: string;
  imageId: string;
  created: string;
  state: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  /** 容器重启次数 */
  restartCount: number;
  command: string;
  entrypoint: string;
  user: string;
  workingDir: string;
  restartPolicy: string;
  autoRemove: boolean;
  privileged: boolean;
  /** CPU 限制（NanoCpus 纳核，0 表示不限制） */
  cpuLimit: number;
  /** 内存限制（字节，0 表示不限制） */
  memLimit: number;
  env: Record<string, string>;
  labels: Record<string, string>;
  mounts: ContainerDetailMount[];
  networks: ContainerDetailNetwork[];
  ports: ContainerDetailPort[];
  hostname: string;
  health: ContainerHealth | null;
  /** 健康检查配置（test 数组 / interval / timeout / retries，单位 ms；test=['NONE'] 表示禁用） */
  healthcheck: ContainerHealthcheckConfig | null;
}

/** 容器健康检查配置 */
export interface ContainerHealthcheckConfig {
  /** 检测命令数组，如 ['CMD','curl','-f','http://localhost']；['NONE'] 表示禁用 */
  test: string[];
  /** 检测间隔（毫秒） */
  interval: number;
  /** 超时（毫秒） */
  timeout: number;
  /** 失败重试次数 */
  retries: number;
}

/** 应用商店应用定义（/api/appstore 返回的应用目录字段） */
export interface AppStoreApp {
  /** 应用唯一 id */
  id: string;
  /** 应用名称，如 'Nginx' */
  name: string;
  /** 应用描述（中文） */
  description: string;
  /** 应用分类，如 '数据库' */
  category: string;
  /** 镜像名称，如 'nginx:latest' */
  image: string;
  /** 图标的 emoji */
  icon: string;
  /** 端口映射列表 */
  ports?: Array<{ container: number; host?: number }>;
  /** 环境变量列表 */
  env?: Array<{ key: string; value?: string; desc?: string }>;
  /** 挂载卷列表 */
  volumes?: Array<{ container: string; host?: string }>;
  /** 标签 */
  tags?: string[];
  /** 是否为用户自定义应用（id 以 custom- 前缀的为自定义，true 时前端显示编辑/删除入口） */
  isCustom?: boolean;
}

/** 应用商店应用及其实时安装状态（/api/appstore 返回的单个应用项） */
export interface AppStoreItem extends AppStoreApp {
  /** 是否已安装（存在对应容器） */
  installed: boolean;
  /** 对应容器 id */
  containerId?: string;
  /** 容器是否运行中 */
  running?: boolean;
  /** 主端口映射，形如 "host:container"，无映射时为 null */
  port?: string | null;
  /** 安装模式：single=单容器，compose=多容器 Compose 套件 */
  mode?: 'single' | 'compose';
  /** Compose 套件的服务名列表（mode=compose 时存在） */
  services?: string[];
  /** 已安装应用的版本号（Compose 套件，来源于安装/升级记录或默认版本） */
  version?: string;
}

/** 应用安装状态信息（/api/appstore/status 返回的单条目结构） */
export interface AppStoreStatusInfo {
  /** 是否已安装 */
  installed: boolean;
  /** 对应容器 id */
  containerId?: string;
  /** 对应容器名称 */
  containerName?: string;
  /** 容器是否运行中 */
  running?: boolean;
  /** 主端口映射，无映射时为 null */
  port?: string | null;
}

/** ===================== 计划任务 ===================== */

/** 计划任务类型 */
export type TaskType = 'prune' | 'backup' | 'pull' | 'composeUp' | 'composeDown';

/** 计划任务（/api/tasks 返回） */
export interface CronTask {
  id: string;
  name: string;
  type: TaskType;
  cron: string;
  enabled: boolean;
  /** 任务参数对象（类型不同字段不同） */
  config: Record<string, any>;
  lastRunAt: number | null;
  lastStatus: number | null;
  lastDetail: string | null;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
}

/** 任务列表响应（/api/tasks） */
export interface CronTaskListResponse {
  tasks: CronTask[];
  projects: string[];
}

/** 任务执行历史条目（/api/tasks/logs） */
export interface CronTaskLogItem {
  id: number;
  taskId: string;
  name: string | null;
  type: string | null;
  runAt: number;
  status: number;
  detail: string | null;
}

/** 任务执行历史分页响应 */
export interface CronTaskLogPage {
  items: CronTaskLogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** ===================== 容器内文件管理 ===================== */

/** 容器内文件条目（/api/files/:id/ls 返回） */
export interface ContainerFileItem {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
}

/** ===================== 数据库管理 ===================== */

/** 数据库类型 */
export type DatabaseType = 'mysql' | 'postgres' | 'mariadb' | 'redis';

/** 已登记的数据库实例（/api/databases 返回） */
export interface DatabaseInstance {
  id: number;
  name: string;
  type: DatabaseType;
  containerRef?: string | null;
  host: string;
  port: number;
  user: string | null;
  /** 是否已设置口令（不返回明文） */
  hasPassword: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 数据库实例列表响应（含自动识别结果） */
export interface DatabaseListResponse {
  instances: DatabaseInstance[];
  recognizedInstances: Array<{
    containerId: string;
    containerName: string;
    image: string;
    type: DatabaseType;
  }>;
}

/** 数据库实例列表响应（/api/databases 的 instances 项） */
export interface DatabaseInstanceRow {
  id: number;
  name: string;
  type: DatabaseType;
  containerRef?: string | null;
  host: string;
  port: number;
  user: string | null;
  hasPassword: boolean;
  createdAt: number;
  updatedAt: number;
}

/** SQL 查询结果（/api/databases/:id/query 返回） */
export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
}

/** Redis 键信息（/api/databases/:id/redis/keys 返回） */
export interface RedisKeyItem {
  key: string;
  type?: string;
  size?: number;
}

/** Redis 指标（/api/databases/:id/redis/info 返回） */
export interface RedisInfo {
  usedMemory?: string;
  usedMemoryHuman?: string;
  hitRate?: string;
  connectedClients?: string;
  uptime?: string;
  keyspace?: string;
  [key: string]: any;
}
