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
  UsageData?: { Size?: number | null; RefCount?: number | null } | null;
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
export type TaskType =
  | 'prune'
  | 'backup'
  | 'pull'
  | 'composeUp'
  | 'composeDown'
  | 'restart'
  | 'command'
  | 'healthcheck'
  | 'git-pull-build'
  | 'imageGc'
  | 'baselineScan'
  | 'sqliteBackup';

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
  /** Webhook 触发 token（仅 admin 可见明文） */
  webhookToken?: string | null;
  /** Git 凭证描述（不含明文） */
  gitCred?: { type?: 'token' | 'ssh'; hasCred: boolean };
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

/** cron 表达式下次执行时间预览（GET /api/tasks/cron-preview 返回） */
export interface CronPreviewResponse {
  /** 输入的 cron 表达式 */
  cron: string;
  /** 下次执行毫秒时间戳；null 表示非法/无法计算 */
  nextRun: number | null;
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

/** ===================== 健康体检 ===================== */

/** 健康级别：healthy 健康 / warning 警告 / danger 危险 */
export type HealthLevel = 'healthy' | 'warning' | 'danger';

/** 体检条目（/api/health-check 返回的 items 项） */
export interface HealthItem {
  /** 条目唯一标识（如 engine / cpu / disk / danglingImages 等） */
  key: string;
  /** 条目标题 */
  title: string;
  /** 健康级别 */
  level: HealthLevel;
  /** 概要描述 */
  message: string;
  /** 更详细的说明（可选） */
  detail?: string;
}

/** 健康体检汇总统计（/api/health-check 返回的 summary） */
export interface HealthCheckSummary {
  /** 容器总数 */
  containers: number;
  /** 镜像总数 */
  images: number;
  /** 数据卷总数 */
  volumes: number;
  /** 网络总数 */
  networks: number;
  /** 可回收空间（字节） */
  reclaimable: number;
}

/** 健康体检结果（/api/health-check 返回） */
export interface HealthCheck {
  /** 健康评分（0-100） */
  score: number;
  /** 总体健康级别 */
  level: HealthLevel;
  /** 汇总统计 */
  summary: HealthCheckSummary;
  /** 逐项体检结果 */
  items: HealthItem[];
}

/** Swarm 集群状态（/api/swarm/status） */
export interface SwarmStatus {
  /** 是否已启用 swarm（LocalNodeState === 'active'） */
  enabled: boolean;
  /** 节点本地状态：inactive/pending/active/error/locked */
  localNodeState: string;
  /** 本节点是否为 swarm 管理器 */
  controlAvailable: boolean;
  /** 集群节点数 */
  nodes?: number;
  /** 管理器数量 */
  managers?: number;
  /** 本节点 ID */
  nodeID?: string;
}

/** Swarm 服务列项（/api/swarm/services） */
export interface SwarmServiceItem {
  /** 服务 id */
  id: string;
  /** 服务名 */
  name: string;
  /** 镜像 */
  image: string;
  /** 模式：global/replicated */
  mode: string;
  /** 当前运行副本数 */
  runningTasks: number;
  /** 期望副本数（replicated 模式） */
  desired: number;
  /** 更新时间（毫秒） */
  updatedAt: number;
}

/** 镜像跨引擎迁移请求（POST /api/transfer/images） */
export interface TransferImageRequest {
  /** 源镜像引用 */
  image: string;
  /** 源引擎 id */
  sourceEngineId: string;
  /** 目标引擎 id */
  targetEngineId: string;
  /** 目标 tag（可选，默认沿用源） */
  tag?: string;
}

/** 镜像跨引擎迁移结果 */
export interface TransferImageResult {
  ok: boolean;
  /** 目标引擎中加载的镜像信息 */
  loaded?: string;
  error?: string;
}

/** ===================== 跨引擎聚合总览 ===================== */

/** 单个引擎的资源统计 */
export interface EngineResources {
  /** CPU 核数 */
  nCPU: number;
  /** 内存总量（字节） */
  memTotal: number;
  /** 已用内存（字节） */
  memUsed: number;
  /** CPU 使用率（百分比） */
  cpuPercent: number;
}

/** 单个引擎的对象计数 */
export interface EngineCounts {
  /** 容器总数 */
  containers: number;
  /** 运行中容器数 */
  running: number;
  /** 镜像数 */
  images: number;
  /** 数据卷数 */
  volumes: number;
  /** 网络数 */
  networks: number;
}

/** 单个引擎的版本信息 */
export interface EngineVersion {
  /** Docker 版本号 */
  version?: string;
  /** API 版本号 */
  apiVersion?: string;
  /** 操作系统 */
  os?: string;
  /** 架构 */
  arch?: string;
  /** 内核版本 */
  kernel?: string;
}

/** 聚合总览中的单个引擎 */
export interface EngineAggregate {
  /** 引擎 id */
  id: string;
  /** 引擎名称 */
  name: string;
  /** 引擎端点 */
  endpoint: string;
  /** 是否为当前引擎 */
  isCurrent: boolean;
  /** 是否在线 */
  online: boolean;
  /** 离线或探测失败时的错误信息 */
  error?: string;
  /** 版本信息 */
  version?: EngineVersion;
  /** 资源统计 */
  resources?: EngineResources;
  /** 对象计数 */
  counts?: EngineCounts;
}

/** 全部引擎聚合后的汇总统计 */
export interface EngineAggregateSummary {
  /** 容器总数 */
  containers: number;
  /** 运行中容器数 */
  running: number;
  /** 镜像数 */
  images: number;
  /** 数据卷数 */
  volumes: number;
  /** 网络数 */
  networks: number;
  /** CPU 总核数 */
  nCPU: number;
  /** 内存总量（字节） */
  memTotal: number;
}

/** GET /api/aggregate/engines 返回 */
export interface EngineAggregateResponse {
  /** 各引擎聚合信息 */
  engines: EngineAggregate[];
  /** 汇总统计 */
  totals: EngineAggregateSummary;
  /** 引擎总数 */
  engineCount: number;
  /** 在线引擎数 */
  onlineCount: number;
}

/** ===================== 批量镜像分发 ===================== */

/** ===================== 跨引擎容器迁移 ===================== */

/** 引擎列表项（GET /api/engines 返回） */
export interface EngineListItem {
  /** 引擎 id */
  id: string;
  /** 引擎名称 */
  name: string;
  /** 引擎端点 */
  endpoint: string;
  /** 是否为当前引擎 */
  isCurrent: boolean;
}

/** 引擎列表响应（GET /api/engines） */
export interface EngineListResponse {
  engines: EngineListItem[];
}

/** 容器跨引擎迁移结果（POST /api/transfer/container 返回） */
export interface ContainerTransferResult {
  /** 是否整体成功 */
  ok: boolean;
  /** 失败时返回的错误信息 */
  error?: string;
  /** 目标容器 id */
  id?: string;
  /** 目标容器名 */
  name?: string;
  /** 镜像是否已传输到位（false 表示目标未创建成功时被跳过，或源镜像不存在） */
  imageTransferred?: boolean;
  /** 是否已启动目标容器 */
  started?: boolean;
  /** 目标容器启动失败的错误信息 */
  startError?: string;
  /** 迁移过程中的警告信息（如命名卷为空卷提示） */
  warning?: string;
  /** 迁移注意事项（如 networkWarning 等） */
  note?: string;
}

/** ===================== 批量镜像分发 ===================== */

/** 批量分发中单个目标引擎的结果 */
export interface TransferBatchResult {
  /** 目标引擎 id */
  engineId: string;
  /** 目标引擎名称 */
  name: string;
  /** 是否成功 */
  ok: boolean;
  /** 成功时加载的镜像信息 */
  loaded?: string;
  /** 失败原因 */
  error?: string;
}

/** POST /api/transfer/batch 返回 */
export interface TransferBatchResponse {
  /** 是否整体成功 */
  ok: boolean;
  /** 目标引擎总数 */
  total: number;
  /** 成功数 */
  okCount: number;
  /** 失败数 */
  failedCount: number;
  /** 逐目标结果 */
  results: TransferBatchResult[];
}

/** ===================== Compose 结构视图 ===================== */

/** Compose 端口映射（/api/compose/:name/structure 返回） */
export interface ComposePort {
  /** 宿主机端口（未映射时省略） */
  published?: string;
  /** 容器内端口 */
  target: string;
  /** 协议（默认 tcp） */
  protocol: string;
}

/** Compose 卷挂载（/api/compose/:name/structure 返回） */
export interface ComposeVolumeMount {
  /** 挂载类型：bind / volume */
  type: string;
  /** 源（named volume 或宿主路径） */
  source?: string;
  /** 容器内挂载目标 */
  target: string;
  /** 是否只读 */
  readOnly: boolean;
}

/** Compose 服务节点（/api/compose/:name/structure 返回的 services 项） */
export interface ComposeServiceNode {
  /** 服务名 */
  name: string;
  /** 镜像名（build 服务可能缺失） */
  image?: string;
  /** 端口映射列表 */
  ports: ComposePort[];
  /** 卷挂载列表 */
  volumes: ComposeVolumeMount[];
  /** 依赖的服务名列表 */
  depends_on: string[];
  /** 环境变量（["K=V"] 形式） */
  environment: string[];
}

/** Compose 结构视图（GET /api/compose/:name/structure 返回） */
export interface ComposeStructure {
  /** 项目名 */
  name: string;
  /** 服务列表 */
  services: ComposeServiceNode[];
  /** 命名卷名列表 */
  volumes: string[];
  /** 网络名列表 */
  networks: string[];
}

/** ===================== 告警中心 ===================== */

/** 容器级告警监控类型 */
export type ContainerRuleWatchType = 'exited' | 'health' | 'port' | 'cpu' | 'mem';

/** 容器级告警规则（/api/notifications/container-rules 返回的单条规则） */
export interface ContainerRule {
  /** 规则 id */
  id: number;
  /** 目标容器 id */
  containerId: string;
  /** 目标容器名（后端补充，可能缺失） */
  containerName?: string;
  /** 监控类型：exited=容器退出 / health=健康检查失败 / port=端口不可达 / cpu=CPU 使用率 / mem=内存使用率 */
  watchType: ContainerRuleWatchType;
  /** 是否启用 */
  enabled: boolean;
  /** CPU/内存阈值（watchType=cpu/mem 时使用）：警告阈值（0-100） */
  warnThreshold: number;
  /** CPU/内存阈值（watchType=cpu/mem 时使用）：危险阈值（0-100） */
  dangerThreshold: number;
  /** 当前使用率（后端为 cpu/mem 行补充，可选） */
  currentValue?: number | null;
  /** 探测端口（watchType=port 时使用，其余为 null） */
  port: number | null;
  /** 静默时段开始（HH:mm） */
  silentStart: string | null;
  /** 静默时段结束（HH:mm） */
  silentEnd: string | null;
  /** 是否仅工作日告警 */
  workdaysOnly: boolean;
  /** 工作时段开始（HH:mm） */
  workStart: string | null;
  /** 工作时段结束（HH:mm） */
  workEnd: string | null;
}

/** 容器级告警规则列表响应（GET /api/notifications/container-rules） */
export interface ContainerRuleListResponse {
  rules: ContainerRule[];
}

/** 容器级告警规则新增/编辑响应（POST/PUT /api/notifications/container-rules） */
export interface ContainerRuleSaveResponse {
  ok: boolean;
  rule: ContainerRule;
}

/** ===================== 面板配置导入/导出 ===================== */

/** 冲突处理策略：skip=跳过已存在 / overwrite=覆盖 / error=出错即回滚 */
export type ConfigImportConflict = 'skip' | 'overwrite' | 'error';

/** 配置导出中 data 子对象的单个元素（通用宽松结构，字段均为 camelCase） */
export interface ConfigDataItem {
  [key: string]: any;
}

/** 面板配置导出（GET /api/system/config/export 返回的 JSON 对象） */
export interface SystemConfigExport {
  /** 导出格式版本 */
  version: number;
  /** 导出时间（ISO 字符串） */
  exportedAt: string;
  /** 是否包含敏感字段（通知渠道 / 云端 / 数据库口令明文） */
  includeSecrets: boolean;
  /** 各实体数据 */
  data: {
    users: ConfigDataItem[];
    hubSources: ConfigDataItem[];
    settings: ConfigDataItem[];
    engines: ConfigDataItem[];
    composeTemplates: ConfigDataItem[];
    containerTemplates: ConfigDataItem[];
    cronTasks: ConfigDataItem[];
    sites: ConfigDataItem[];
    alertRules: ConfigDataItem[];
    containerAlertRules: ConfigDataItem[];
    notifyChannels: ConfigDataItem[];
    cloudTargets: ConfigDataItem[];
    databaseInstances: ConfigDataItem[];
  };
}

/** 配置导入响应（POST /api/system/config/import 返回） */
export interface SystemConfigImportResponse {
  ok: boolean;
  /** 实际采用的冲突策略 */
  conflict: ConfigImportConflict;
  /** 各实体导入数量 */
  imported: Record<string, number>;
  note?: string;
}

// ---- AI 助手（/api/ai） ----
export interface AiSettings {
  enabled: boolean;
  /** 是否已配置且可用 */
  available: boolean;
  /** 当前默认 profile（null 表示未设置） */
  defaultProfile: AiProfile | null;
}
export interface AiCapability {
  id: string;
  label: string;
  description: string;
  prompt: string;
  tool?: string;
}
export interface AiCapabilitiesResponse {
  available: boolean;
  capabilities: AiCapability[];
}
export interface AiChatRequest {
  messages: Array<{ role: string; content: string }>;
  tool?: string;
  target?: string;
}
export interface AiChatResponse {
  enabled: boolean;
  reply: string;
  toolContext?: string;
}

export interface AiUsageSummary {
  totalPrompt: number;
  totalCompletion: number;
  total: number;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
}
export interface AiUsageByModel {
  model: string;
  provider: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  successCalls: number;
}
export interface AiUsageByDay {
  day: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export interface AiUsageResponse {
  summary: AiUsageSummary;
  byModel: AiUsageByModel[];
  byDay: AiUsageByDay[];
}

export interface AiChatSessionLite {
  id: number;
  title: string;
  messageCount: number;
  tool: string;
  target: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}
export interface AiChatSession extends AiChatSessionLite {
  messages: AiChatMessage[];
}
export interface AiSessionsResponse {
  sessions: AiChatSessionLite[];
}
export interface AiTestResponse {
  ok: boolean;
  message: string;
}
export interface AiProfile {
  id: number;
  name: string;
  kind: 'local' | 'cloud';
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  isDefault: boolean;
  timeoutMs: number;
  systemPrompt: string;
  budgetMonthlyTokens: number;
  budgetMonthlyCost: number;
}
export interface AiPreset {
  id: string;
  name: string;
  kind: 'local' | 'cloud';
  baseUrl: string;
  models: string[];
  keyHint?: string;
}

// ---- Compose 逆向（/api/compose/infer） ----
export interface ComposeInferCandidate {
  id: string;
  name: string;
  image: string;
  status?: string;
}
export interface ComposeInferService {
  name: string;
  image: string;
  ports: string[];
  networks: string[];
}
export interface ComposeInferResult {
  projectName: string;
  services: ComposeInferService[];
  volumes: string[];
  networks: string[];
  content: string;
  warnings: string[];
  valid: boolean;
  validateError?: string;
}

// ---- 日志聚合（/api/logs） ----
export interface LogSourceContainer {
  id: string;
  name: string;
  image: string;
  status?: string;
}
export interface LogLine {
  ts?: number;
  container: string;
  stream: 'stdout' | 'stderr';
  text: string;
}
export interface LogsQueryResponse {
  lines: LogLine[];
  total: number;
  truncated: boolean;
  matched: boolean;
}

// ---- 镜像 GC 策略（/api/gc） ----
export interface GcImageInfo {
  id: string;
  repoTags: string[];
  created: number;
  size: number;
  usedByContainers: boolean;
}
export interface GcCandidate extends GcImageInfo {
  lastPullAt?: number;
  reasons: string[];
}
export interface GcPolicy {
  keepPerRepo?: number;
  olderThanDays?: number;
  pruneDangling?: boolean;
}
export interface GcPlanResponse {
  candidates: GcCandidate[];
  keepers: GcImageInfo[];
  skipped: Array<{ name: string; reason: string }>;
  totals: { toFree: number; bytes: number; bytesText: string };
  warnings: string[];
}
export interface GcRunResult {
  ok: boolean;
  deleted: string[];
  spaceReclaimed: number;
  detail: string;
  policy: GcPolicy;
}

// ---- 网络拓扑（/api/topology） ----
export interface TopoNode {
  id: string;
  kind: 'container' | 'network';
  label: string;
  name?: string;
  status?: string;
  health?: string;
  image?: string;
  projectName?: string;
  networks?: string[];
  ports?: Array<{ target: string; protocol: string; published?: string }>;
  driver?: string;
}
export interface TopoEdge {
  from: string;
  to: string;
  kind: 'network';
}
export interface TopologyResponse {
  nodes: TopoNode[];
  edges: TopoEdge[];
  counts: { containers: number; networks: number };
  truncated?: boolean;
}

/** AI Prompt 模板 */
export interface AiPromptTemplate {
  id: number;
  name: string;
  category: string;
  prompt: string;
  isSystem: boolean;
  username: string;
  createdAt: number;
  updatedAt: number;
}
export interface AiTemplatesResponse {
  templates: AiPromptTemplate[];
}
export interface AiTemplateCategoriesResponse {
  categories: string[];
}

// Action 审批
export interface AiAction {
  id: number;
  username: string;
  actionType: string;
  params: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'gated' | 'executed' | 'failed';
  aiMessage: string;
  result: string;
  createdAt: number;
  resolvedAt: number | null;
}
export interface AiActionsResponse {
  actions: AiAction[];
  actionTypes: Record<string, string>;
}
export interface AiActionStats {
  pending: number;
  approved: number;
  rejected: number;
  executed: number;
  failed: number;
}

// 本地模型状态
export interface AiLocalModelStatus {
  ok: boolean;
  message: string;
  models: Array<{ id: string; name: string; size?: number }>;
  serviceInfo?: Record<string, unknown>;
}

// 文件分析
export interface AiAnalysisIssue {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  line?: number;
}
export interface AiAnalysisResult {
  fileType: 'dockerfile' | 'compose' | 'log' | 'config' | 'text';
  score: { security: number; performance: number; maintainability: number };
  issues: AiAnalysisIssue[];
  suggestions: string;
  cfg?: { provider: string; model: string };
}

// Ollama 模型管理
export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: Record<string, unknown>;
}
export interface OllamaStatus {
  ok: boolean;
  message: string;
  models: OllamaModel[];
  version?: string;
}
export interface OllamaRunningModel {
  name: string;
  size: number;
  size_vram: number;
}
export interface OllamaRunningStatus {
  ok: boolean;
  models: OllamaRunningModel[];
}

// 知识库
export interface KnowledgeEntry {
  id: number;
  title: string;
  category: string;
  content: string;
  tags: string[];
  owner: string;
  shared: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface KnowledgeListResponse {
  items: KnowledgeEntry[];
  total: number;
}
export interface KnowledgeStats {
  category: string;
  count: number;
}

// AI 用量仪表盘
export interface AiUsageDashboard {
  summary: {
    totalPrompt: number;
    totalCompletion: number;
    total: number;
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
  };
  byDayCost: Array<{ day: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; cost: number }>;
  byWeek: Array<{ week: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
  byModel: Array<{ model: string; provider: string; calls: number; promptTokens: number; completionTokens: number; totalTokens: number; successCalls: number }>;
  performance: AiPerformanceMetric[];
  totalCost: number;
}

export interface AiPerformanceMetric {
  model: string;
  provider: string;
  totalCalls: number;
  successRate: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
  avgTotalTokens: number;
  avgDurationMs: number;
  totalTokens: number;
}
