/**
 * 鍚庣 API 鏁版嵁绫诲瀷瀹氫箟
 *
 * 涓?server 绔悇璺敱杩斿洖鐨?JSON 缁撴瀯淇濇寔涓€鑷淬€?
 */

/** Docker 寮曟搸鎬昏淇℃伅 */
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

/** Docker 绯荤粺淇℃伅锛?api/system/info锛?*/
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

/** Docker 鐗堟湰淇℃伅 */
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

/** 瀹瑰櫒鍒楄〃椤癸紙/api/containers 杩斿洖鐨勫師鐢?dockerode 缁撴瀯锛?*/
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
  /** 鍋ュ悍妫€鏌ョ姸鎬侊紙none 琛ㄧず鏈厤缃仴搴锋鏌ユ垨 inspect 澶辫触锛?*/
  health?: 'starting' | 'healthy' | 'unhealthy' | 'none';
  /** CPU 闄愬埗锛圢anoCpus 绾虫牳锛? 琛ㄧず涓嶉檺鍒讹級 */
  cpuLimit?: number;
  /** 鍐呭瓨闄愬埗锛堝瓧鑺傦紝0 琛ㄧず涓嶉檺鍒讹級 */
  memLimit?: number;
  SizeRw?: number;
  SizeRootFs?: number;
}

/** 瀹瑰櫒璇︽儏/鏍煎紡鍖栧悗鐨勭簿绠€缁撴瀯 */
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

/** 瀹瑰櫒璧勬簮缁熻 */
export interface ContainerStats {
  cpuPercent: number;
  memory: { usage: number; limit: number; percent: number };
  network: { rx: number; tx: number };
  blockRead?: number;
  blockWrite?: number;
  pids: number;
}

/** 闀滃儚鍒楄〃椤?*/
export interface ImageItem {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[];
  ParentId: string;
  Size: number;
  VirtualSize?: number;
  SharedSize: number;
  Created: number;
  /** 鏈湴鎷夊彇鏃堕棿锛堢锛夛紝鏃犺褰曟椂鐪佺暐 */
  pullTime?: number;
  Containers: number;
  Labels: Record<string, string>;
}

/** 鏁版嵁鍗?*/
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

/** 缃戠粶 */
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

/** Compose 椤圭洰 */
export interface ComposeProject {
  name: string;
  path: string;
  composeFile: string | null;
  hasCompose: boolean;
}

/** Compose 鏈嶅姟鐘舵€?*/
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

/** Compose 妯℃澘锛?api/compose-templates 杩斿洖锛屽瓨鐢ㄦ埛淇濆瓨鐨勫父鐢?YAML 閰嶇疆锛?*/
export interface ComposeTemplate {
  /** 妯℃澘鍞竴鏍囪瘑 */
  id: string;
  /** 妯℃澘鍚嶇О锛堝敮涓€锛?*/
  name: string;
  /** 妯℃澘鎻忚堪锛堝彲閫夛級 */
  description: string;
  /** 瀹屾暣鐨?docker-compose.yml 鏂囨湰 */
  content: string;
  /** 鍒涘缓鏃堕棿锛堢锛?*/
  createdAt: number;
  /** 鏇存柊鏃堕棿锛堢锛?*/
  updatedAt: number;
}

/** 瀹瑰櫒绔彛鏄犲皠锛?api/containers/:id/detail 杩斿洖缁撴瀯锛?*/
export interface ContainerDetailPort {
  internal: string;
  published: Array<{ hostIp: string; hostPort: string }>;
}

/** 瀹瑰櫒鎸傝浇鍗凤紙/api/containers/:id/detail 杩斿洖缁撴瀯锛?*/
export interface ContainerDetailMount {
  type: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

/** 瀹瑰櫒缃戠粶锛?api/containers/:id/detail 杩斿洖缁撴瀯锛?*/
export interface ContainerDetailNetwork {
  name: string;
  ipAddress: string;
  gateway: string;
  aliases: string[];
  macAddress: string;
}

/** 瀹瑰櫒鍋ュ悍妫€鏌ユ棩蹇楁潯鐩紙/api/containers/:id/detail 杩斿洖缁撴瀯锛?*/
export interface ContainerHealthLog {
  start: string;
  exit: number;
  output: string;
}

/** 瀹瑰櫒鍋ュ悍妫€鏌ョ姸鎬侊紙/api/containers/:id/detail 杩斿洖缁撴瀯锛宯ull 琛ㄧず鏈厤缃級 */
export interface ContainerHealth {
  status: string;
  failingStreak: number;
  log: ContainerHealthLog[];
}

/** 瀹夸富鏈虹鍙ｅ崰鐢ㄥ啿绐佹槧灏勶紙/api/containers/ports 杩斿洖缁撴瀯锛宬ey 涓?HostPort锛?*/
export type ContainerPortConflicts = Record<
  string,
  Array<{ containerId: string; containerName: string }>
>;

/** 瀹瑰櫒瀹屾暣璇︽儏锛?api/containers/:id/detail 杩斿洖缁撴瀯锛?*/
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
  /** 瀹瑰櫒閲嶅惎娆℃暟 */
  restartCount: number;
  command: string;
  entrypoint: string;
  user: string;
  workingDir: string;
  restartPolicy: string;
  autoRemove: boolean;
  privileged: boolean;
  /** CPU 闄愬埗锛圢anoCpus 绾虫牳锛? 琛ㄧず涓嶉檺鍒讹級 */
  cpuLimit: number;
  /** 鍐呭瓨闄愬埗锛堝瓧鑺傦紝0 琛ㄧず涓嶉檺鍒讹級 */
  memLimit: number;
  env: Record<string, string>;
  labels: Record<string, string>;
  mounts: ContainerDetailMount[];
  networks: ContainerDetailNetwork[];
  ports: ContainerDetailPort[];
  hostname: string;
  health: ContainerHealth | null;
  /** 鍋ュ悍妫€鏌ラ厤缃紙test 鏁扮粍 / interval / timeout / retries锛屽崟浣?ms锛泃est=['NONE'] 琛ㄧず绂佺敤锛?*/
  healthcheck: ContainerHealthcheckConfig | null;
}

/** 瀹瑰櫒鍋ュ悍妫€鏌ラ厤缃?*/
export interface ContainerHealthcheckConfig {
  /** 妫€娴嬪懡浠ゆ暟缁勶紝濡?['CMD','curl','-f','http://localhost']锛沎'NONE'] 琛ㄧず绂佺敤 */
  test: string[];
  /** 妫€娴嬮棿闅旓紙姣锛?*/
  interval: number;
  /** 瓒呮椂锛堟绉掞級 */
  timeout: number;
  /** 澶辫触閲嶈瘯娆℃暟 */
  retries: number;
}

/** 搴旂敤鍟嗗簵搴旂敤瀹氫箟锛?api/appstore 杩斿洖鐨勫簲鐢ㄧ洰褰曞瓧娈碉級 */
export interface AppStoreApp {
  /** 搴旂敤鍞竴 id */
  id: string;
  /** 搴旂敤鍚嶇О锛屽 'Nginx' */
  name: string;
  /** 搴旂敤鎻忚堪锛堜腑鏂囷級 */
  description: string;
  /** 搴旂敤鍒嗙被锛屽 '鏁版嵁搴? */
  category: string;
  /** 闀滃儚鍚嶇О锛屽 'nginx:latest' */
  image: string;
  /** 鍥炬爣鐨?emoji */
  icon: string;
  /** 绔彛鏄犲皠鍒楄〃 */
  ports?: Array<{ container: number; host?: number }>;
  /** 鐜鍙橀噺鍒楄〃 */
  env?: Array<{ key: string; value?: string; desc?: string }>;
  /** 鎸傝浇鍗峰垪琛?*/
  volumes?: Array<{ container: string; host?: string }>;
  /** 鏍囩 */
  tags?: string[];
  /** 鏄惁涓虹敤鎴疯嚜瀹氫箟搴旂敤锛坕d 浠?custom- 鍓嶇紑鐨勪负鑷畾涔夛紝true 鏃跺墠绔樉绀虹紪杈?鍒犻櫎鍏ュ彛锛?*/
  isCustom?: boolean;
}

/** 搴旂敤鍟嗗簵搴旂敤鍙婂叾瀹炴椂瀹夎鐘舵€侊紙/api/appstore 杩斿洖鐨勫崟涓簲鐢ㄩ」锛?*/
export interface AppStoreItem extends AppStoreApp {
  /** 鏄惁宸插畨瑁咃紙瀛樺湪瀵瑰簲瀹瑰櫒锛?*/
  installed: boolean;
  /** 瀵瑰簲瀹瑰櫒 id */
  containerId?: string;
  /** 瀹瑰櫒鏄惁杩愯涓?*/
  running?: boolean;
  /** 涓荤鍙ｆ槧灏勶紝褰㈠ "host:container"锛屾棤鏄犲皠鏃朵负 null */
  port?: string | null;
  /** 瀹夎妯″紡锛歴ingle=鍗曞鍣紝compose=澶氬鍣?Compose 濂椾欢 */
  mode?: 'single' | 'compose';
  /** Compose 濂椾欢鐨勬湇鍔″悕鍒楄〃锛坢ode=compose 鏃跺瓨鍦級 */
  services?: string[];
  /** 宸插畨瑁呭簲鐢ㄧ殑鐗堟湰鍙凤紙Compose 濂椾欢锛屾潵婧愪簬瀹夎/鍗囩骇璁板綍鎴栭粯璁ょ増鏈級 */
  version?: string;
}

/** 搴旂敤瀹夎鐘舵€佷俊鎭紙/api/appstore/status 杩斿洖鐨勫崟鏉＄洰缁撴瀯锛?*/
export interface AppStoreStatusInfo {
  /** 鏄惁宸插畨瑁?*/
  installed: boolean;
  /** 瀵瑰簲瀹瑰櫒 id */
  containerId?: string;
  /** 瀵瑰簲瀹瑰櫒鍚嶇О */
  containerName?: string;
  /** 瀹瑰櫒鏄惁杩愯涓?*/
  running?: boolean;
  /** 涓荤鍙ｆ槧灏勶紝鏃犳槧灏勬椂涓?null */
  port?: string | null;
}

/** ===================== 璁″垝浠诲姟 ===================== */

/** 璁″垝浠诲姟绫诲瀷 */
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
  | 'baselineScan';

/** 璁″垝浠诲姟锛?api/tasks 杩斿洖锛?*/
export interface CronTask {
  id: string;
  name: string;
  type: TaskType;
  cron: string;
  enabled: boolean;
  /** 浠诲姟鍙傛暟瀵硅薄锛堢被鍨嬩笉鍚屽瓧娈典笉鍚岋級 */
  config: Record<string, any>;
  lastRunAt: number | null;
  lastStatus: number | null;
  lastDetail: string | null;
  nextRunAt: number;
  createdAt: number;
  updatedAt: number;
  /** Webhook 瑙﹀彂 token锛堜粎 admin 鍙鏄庢枃锛?*/
  webhookToken?: string | null;
  /** Git 鍑瘉鎻忚堪锛堜笉鍚槑鏂囷級 */
  gitCred?: { type?: 'token' | 'ssh'; hasCred: boolean };
}

/** 浠诲姟鍒楄〃鍝嶅簲锛?api/tasks锛?*/
export interface CronTaskListResponse {
  tasks: CronTask[];
  projects: string[];
}

/** 浠诲姟鎵ц鍘嗗彶鏉＄洰锛?api/tasks/logs锛?*/
export interface CronTaskLogItem {
  id: number;
  taskId: string;
  name: string | null;
  type: string | null;
  runAt: number;
  status: number;
  detail: string | null;
}

/** 浠诲姟鎵ц鍘嗗彶鍒嗛〉鍝嶅簲 */
export interface CronTaskLogPage {
  items: CronTaskLogItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** cron 琛ㄨ揪寮忎笅娆℃墽琛屾椂闂撮瑙堬紙GET /api/tasks/cron-preview 杩斿洖锛?*/
export interface CronPreviewResponse {
  /** 杈撳叆鐨?cron 琛ㄨ揪寮?*/
  cron: string;
  /** 涓嬫鎵ц姣鏃堕棿鎴筹紱null 琛ㄧず闈炴硶/鏃犳硶璁＄畻 */
  nextRun: number | null;
}

/** ===================== 瀹瑰櫒鍐呮枃浠剁鐞?===================== */

/** 瀹瑰櫒鍐呮枃浠舵潯鐩紙/api/files/:id/ls 杩斿洖锛?*/
export interface ContainerFileItem {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
}

/** ===================== 鏁版嵁搴撶鐞?===================== */

/** 鏁版嵁搴撶被鍨?*/
export type DatabaseType = 'mysql' | 'postgres' | 'mariadb' | 'redis';

/** 宸茬櫥璁扮殑鏁版嵁搴撳疄渚嬶紙/api/databases 杩斿洖锛?*/
export interface DatabaseInstance {
  id: number;
  name: string;
  type: DatabaseType;
  containerRef?: string | null;
  host: string;
  port: number;
  user: string | null;
  /** 鏄惁宸茶缃彛浠わ紙涓嶈繑鍥炴槑鏂囷級 */
  hasPassword: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 鏁版嵁搴撳疄渚嬪垪琛ㄥ搷搴旓紙鍚嚜鍔ㄨ瘑鍒粨鏋滐級 */
export interface DatabaseListResponse {
  instances: DatabaseInstance[];
  recognizedInstances: Array<{
    containerId: string;
    containerName: string;
    image: string;
    type: DatabaseType;
  }>;
}

/** 鏁版嵁搴撳疄渚嬪垪琛ㄥ搷搴旓紙/api/databases 鐨?instances 椤癸級 */
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

/** SQL 鏌ヨ缁撴灉锛?api/databases/:id/query 杩斿洖锛?*/
export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
}

/** Redis 閿俊鎭紙/api/databases/:id/redis/keys 杩斿洖锛?*/
export interface RedisKeyItem {
  key: string;
  type?: string;
  size?: number;
}

/** Redis 鎸囨爣锛?api/databases/:id/redis/info 杩斿洖锛?*/
export interface RedisInfo {
  usedMemory?: string;
  usedMemoryHuman?: string;
  hitRate?: string;
  connectedClients?: string;
  uptime?: string;
  keyspace?: string;
  [key: string]: any;
}

/** ===================== 鍋ュ悍浣撴 ===================== */

/** 鍋ュ悍绾у埆锛歨ealthy 鍋ュ悍 / warning 璀﹀憡 / danger 鍗遍櫓 */
export type HealthLevel = 'healthy' | 'warning' | 'danger';

/** 浣撴鏉＄洰锛?api/health-check 杩斿洖鐨?items 椤癸級 */
export interface HealthItem {
  /** 鏉＄洰鍞竴鏍囪瘑锛堝 engine / cpu / disk / danglingImages 绛夛級 */
  key: string;
  /** 鏉＄洰鏍囬 */
  title: string;
  /** 鍋ュ悍绾у埆 */
  level: HealthLevel;
  /** 姒傝鎻忚堪 */
  message: string;
  /** 鏇磋缁嗙殑璇存槑锛堝彲閫夛級 */
  detail?: string;
}

/** 鍋ュ悍浣撴姹囨€荤粺璁★紙/api/health-check 杩斿洖鐨?summary锛?*/
export interface HealthCheckSummary {
  /** 瀹瑰櫒鎬绘暟 */
  containers: number;
  /** 闀滃儚鎬绘暟 */
  images: number;
  /** 鏁版嵁鍗锋€绘暟 */
  volumes: number;
  /** 缃戠粶鎬绘暟 */
  networks: number;
  /** 鍙洖鏀剁┖闂达紙瀛楄妭锛?*/
  reclaimable: number;
}

/** 鍋ュ悍浣撴缁撴灉锛?api/health-check 杩斿洖锛?*/
export interface HealthCheck {
  /** 鍋ュ悍璇勫垎锛?-100锛?*/
  score: number;
  /** 鎬讳綋鍋ュ悍绾у埆 */
  level: HealthLevel;
  /** 姹囨€荤粺璁?*/
  summary: HealthCheckSummary;
  /** 閫愰」浣撴缁撴灉 */
  items: HealthItem[];
}

/** Swarm 闆嗙兢鐘舵€侊紙/api/swarm/status锛?*/
export interface SwarmStatus {
  /** 鏄惁宸插惎鐢?swarm锛圠ocalNodeState === 'active'锛?*/
  enabled: boolean;
  /** 鑺傜偣鏈湴鐘舵€侊細inactive/pending/active/error/locked */
  localNodeState: string;
  /** 鏈妭鐐规槸鍚︿负 swarm 绠＄悊鍣?*/
  controlAvailable: boolean;
  /** 闆嗙兢鑺傜偣鏁?*/
  nodes?: number;
  /** 绠＄悊鍣ㄦ暟閲?*/
  managers?: number;
  /** 鏈妭鐐?ID */
  nodeID?: string;
}

/** Swarm 鏈嶅姟鍒楅」锛?api/swarm/services锛?*/
export interface SwarmServiceItem {
  /** 鏈嶅姟 id */
  id: string;
  /** 鏈嶅姟鍚?*/
  name: string;
  /** 闀滃儚 */
  image: string;
  /** 妯″紡锛歡lobal/replicated */
  mode: string;
  /** 褰撳墠杩愯鍓湰鏁?*/
  runningTasks: number;
  /** 鏈熸湜鍓湰鏁帮紙replicated 妯″紡锛?*/
  desired: number;
  /** 鏇存柊鏃堕棿锛堟绉掞級 */
  updatedAt: number;
}

/** 闀滃儚璺ㄥ紩鎿庤縼绉昏姹傦紙POST /api/transfer/images锛?*/
export interface TransferImageRequest {
  /** 婧愰暅鍍忓紩鐢?*/
  image: string;
  /** 婧愬紩鎿?id */
  sourceEngineId: string;
  /** 鐩爣寮曟搸 id */
  targetEngineId: string;
  /** 鐩爣 tag锛堝彲閫夛紝榛樿娌跨敤婧愶級 */
  tag?: string;
}

/** 闀滃儚璺ㄥ紩鎿庤縼绉荤粨鏋?*/
export interface TransferImageResult {
  ok: boolean;
  /** 鐩爣寮曟搸涓姞杞界殑闀滃儚淇℃伅 */
  loaded?: string;
  error?: string;
}

/** ===================== 璺ㄥ紩鎿庤仛鍚堟€昏 ===================== */

/** 鍗曚釜寮曟搸鐨勮祫婧愮粺璁?*/
export interface EngineResources {
  /** CPU 鏍告暟 */
  nCPU: number;
  /** 鍐呭瓨鎬婚噺锛堝瓧鑺傦級 */
  memTotal: number;
  /** 宸茬敤鍐呭瓨锛堝瓧鑺傦級 */
  memUsed: number;
  /** CPU 浣跨敤鐜囷紙鐧惧垎姣旓級 */
  cpuPercent: number;
}

/** 鍗曚釜寮曟搸鐨勫璞¤鏁?*/
export interface EngineCounts {
  /** 瀹瑰櫒鎬绘暟 */
  containers: number;
  /** 杩愯涓鍣ㄦ暟 */
  running: number;
  /** 闀滃儚鏁?*/
  images: number;
  /** 鏁版嵁鍗锋暟 */
  volumes: number;
  /** 缃戠粶鏁?*/
  networks: number;
}

/** 鍗曚釜寮曟搸鐨勭増鏈俊鎭?*/
export interface EngineVersion {
  /** Docker 鐗堟湰鍙?*/
  version?: string;
  /** API 鐗堟湰鍙?*/
  apiVersion?: string;
  /** 鎿嶄綔绯荤粺 */
  os?: string;
  /** 鏋舵瀯 */
  arch?: string;
  /** 鍐呮牳鐗堟湰 */
  kernel?: string;
}

/** 鑱氬悎鎬昏涓殑鍗曚釜寮曟搸 */
export interface EngineAggregate {
  /** 寮曟搸 id */
  id: string;
  /** 寮曟搸鍚嶇О */
  name: string;
  /** 寮曟搸绔偣 */
  endpoint: string;
  /** 鏄惁涓哄綋鍓嶅紩鎿?*/
  isCurrent: boolean;
  /** 鏄惁鍦ㄧ嚎 */
  online: boolean;
  /** 绂荤嚎鎴栨帰娴嬪け璐ユ椂鐨勯敊璇俊鎭?*/
  error?: string;
  /** 鐗堟湰淇℃伅 */
  version?: EngineVersion;
  /** 璧勬簮缁熻 */
  resources?: EngineResources;
  /** 瀵硅薄璁℃暟 */
  counts?: EngineCounts;
}

/** 鍏ㄩ儴寮曟搸鑱氬悎鍚庣殑姹囨€荤粺璁?*/
export interface EngineAggregateSummary {
  /** 瀹瑰櫒鎬绘暟 */
  containers: number;
  /** 杩愯涓鍣ㄦ暟 */
  running: number;
  /** 闀滃儚鏁?*/
  images: number;
  /** 鏁版嵁鍗锋暟 */
  volumes: number;
  /** 缃戠粶鏁?*/
  networks: number;
  /** CPU 鎬绘牳鏁?*/
  nCPU: number;
  /** 鍐呭瓨鎬婚噺锛堝瓧鑺傦級 */
  memTotal: number;
}

/** GET /api/aggregate/engines 杩斿洖 */
export interface EngineAggregateResponse {
  /** 鍚勫紩鎿庤仛鍚堜俊鎭?*/
  engines: EngineAggregate[];
  /** 姹囨€荤粺璁?*/
  totals: EngineAggregateSummary;
  /** 寮曟搸鎬绘暟 */
  engineCount: number;
  /** 鍦ㄧ嚎寮曟搸鏁?*/
  onlineCount: number;
}

/** ===================== 鎵归噺闀滃儚鍒嗗彂 ===================== */

/** ===================== 璺ㄥ紩鎿庡鍣ㄨ縼绉?===================== */

/** 寮曟搸鍒楄〃椤癸紙GET /api/engines 杩斿洖锛?*/
export interface EngineListItem {
  /** 寮曟搸 id */
  id: string;
  /** 寮曟搸鍚嶇О */
  name: string;
  /** 寮曟搸绔偣 */
  endpoint: string;
  /** 鏄惁涓哄綋鍓嶅紩鎿?*/
  isCurrent: boolean;
}

/** 寮曟搸鍒楄〃鍝嶅簲锛圙ET /api/engines锛?*/
export interface EngineListResponse {
  engines: EngineListItem[];
}

/** 瀹瑰櫒璺ㄥ紩鎿庤縼绉荤粨鏋滐紙POST /api/transfer/container 杩斿洖锛?*/
export interface ContainerTransferResult {
  /** 鏄惁鏁翠綋鎴愬姛 */
  ok: boolean;
  /** 澶辫触鏃惰繑鍥炵殑閿欒淇℃伅 */
  error?: string;
  /** 鐩爣瀹瑰櫒 id */
  id?: string;
  /** 鐩爣瀹瑰櫒鍚?*/
  name?: string;
  /** 闀滃儚鏄惁宸蹭紶杈撳埌浣嶏紙false 琛ㄧず鐩爣鏈垱寤烘垚鍔熸椂琚烦杩囷紝鎴栨簮闀滃儚涓嶅瓨鍦級 */
  imageTransferred?: boolean;
  /** 鏄惁宸插惎鍔ㄧ洰鏍囧鍣?*/
  started?: boolean;
  /** 鐩爣瀹瑰櫒鍚姩澶辫触鐨勯敊璇俊鎭?*/
  startError?: string;
  /** 杩佺Щ杩囩▼涓殑璀﹀憡淇℃伅锛堝鍛藉悕鍗蜂负绌哄嵎鎻愮ず锛?*/
  warning?: string;
  /** 杩佺Щ娉ㄦ剰浜嬮」锛堝 networkWarning 绛夛級 */
  note?: string;
}

/** ===================== 鎵归噺闀滃儚鍒嗗彂 ===================== */

/** 鎵归噺鍒嗗彂涓崟涓洰鏍囧紩鎿庣殑缁撴灉 */
export interface TransferBatchResult {
  /** 鐩爣寮曟搸 id */
  engineId: string;
  /** 鐩爣寮曟搸鍚嶇О */
  name: string;
  /** 鏄惁鎴愬姛 */
  ok: boolean;
  /** 鎴愬姛鏃跺姞杞界殑闀滃儚淇℃伅 */
  loaded?: string;
  /** 澶辫触鍘熷洜 */
  error?: string;
}

/** POST /api/transfer/batch 杩斿洖 */
export interface TransferBatchResponse {
  /** 鏄惁鏁翠綋鎴愬姛 */
  ok: boolean;
  /** 鐩爣寮曟搸鎬绘暟 */
  total: number;
  /** 鎴愬姛鏁?*/
  okCount: number;
  /** 澶辫触鏁?*/
  failedCount: number;
  /** 閫愮洰鏍囩粨鏋?*/
  results: TransferBatchResult[];
}

/** ===================== Compose 缁撴瀯瑙嗗浘 ===================== */

/** Compose 绔彛鏄犲皠锛?api/compose/:name/structure 杩斿洖锛?*/
export interface ComposePort {
  /** 瀹夸富鏈虹鍙ｏ紙鏈槧灏勬椂鐪佺暐锛?*/
  published?: string;
  /** 瀹瑰櫒鍐呯鍙?*/
  target: string;
  /** 鍗忚锛堥粯璁?tcp锛?*/
  protocol: string;
}

/** Compose 鍗锋寕杞斤紙/api/compose/:name/structure 杩斿洖锛?*/
export interface ComposeVolumeMount {
  /** 鎸傝浇绫诲瀷锛歜ind / volume */
  type: string;
  /** 婧愶紙named volume 鎴栧涓昏矾寰勶級 */
  source?: string;
  /** 瀹瑰櫒鍐呮寕杞界洰鏍?*/
  target: string;
  /** 鏄惁鍙 */
  readOnly: boolean;
}

/** Compose 鏈嶅姟鑺傜偣锛?api/compose/:name/structure 杩斿洖鐨?services 椤癸級 */
export interface ComposeServiceNode {
  /** 鏈嶅姟鍚?*/
  name: string;
  /** 闀滃儚鍚嶏紙build 鏈嶅姟鍙兘缂哄け锛?*/
  image?: string;
  /** 绔彛鏄犲皠鍒楄〃 */
  ports: ComposePort[];
  /** 鍗锋寕杞藉垪琛?*/
  volumes: ComposeVolumeMount[];
  /** 渚濊禆鐨勬湇鍔″悕鍒楄〃 */
  depends_on: string[];
  /** 鐜鍙橀噺锛圼"K=V"] 褰㈠紡锛?*/
  environment: string[];
}

/** Compose 缁撴瀯瑙嗗浘锛圙ET /api/compose/:name/structure 杩斿洖锛?*/
export interface ComposeStructure {
  /** 椤圭洰鍚?*/
  name: string;
  /** 鏈嶅姟鍒楄〃 */
  services: ComposeServiceNode[];
  /** 鍛藉悕鍗峰悕鍒楄〃 */
  volumes: string[];
  /** 缃戠粶鍚嶅垪琛?*/
  networks: string[];
}

/** ===================== 鍛婅涓績 ===================== */

/** 瀹瑰櫒绾у憡璀︾洃鎺х被鍨?*/
export type ContainerRuleWatchType = 'exited' | 'health' | 'port' | 'cpu' | 'mem';

/** 瀹瑰櫒绾у憡璀﹁鍒欙紙/api/notifications/container-rules 杩斿洖鐨勫崟鏉¤鍒欙級 */
export interface ContainerRule {
  /** 瑙勫垯 id */
  id: number;
  /** 鐩爣瀹瑰櫒 id */
  containerId: string;
  /** 鐩爣瀹瑰櫒鍚嶏紙鍚庣琛ュ厖锛屽彲鑳界己澶憋級 */
  containerName?: string;
  /** 鐩戞帶绫诲瀷锛歟xited=瀹瑰櫒閫€鍑?/ health=鍋ュ悍妫€鏌ュけ璐?/ port=绔彛涓嶅彲杈?/ cpu=CPU 浣跨敤鐜?/ mem=鍐呭瓨浣跨敤鐜?*/
  watchType: ContainerRuleWatchType;
  /** 鏄惁鍚敤 */
  enabled: boolean;
  /** CPU/鍐呭瓨闃堝€硷紙watchType=cpu/mem 鏃朵娇鐢級锛氳鍛婇槇鍊硷紙0-100锛?*/
  warnThreshold: number;
  /** CPU/鍐呭瓨闃堝€硷紙watchType=cpu/mem 鏃朵娇鐢級锛氬嵄闄╅槇鍊硷紙0-100锛?*/
  dangerThreshold: number;
  /** 褰撳墠浣跨敤鐜囷紙鍚庣涓?cpu/mem 琛岃ˉ鍏咃紝鍙€夛級 */
  currentValue?: number | null;
  /** 鎺㈡祴绔彛锛坵atchType=port 鏃朵娇鐢紝鍏朵綑涓?null锛?*/
  port: number | null;
  /** 闈欓粯鏃舵寮€濮嬶紙HH:mm锛?*/
  silentStart: string | null;
  /** 闈欓粯鏃舵缁撴潫锛圚H:mm锛?*/
  silentEnd: string | null;
  /** 鏄惁浠呭伐浣滄棩鍛婅 */
  workdaysOnly: boolean;
  /** 宸ヤ綔鏃舵寮€濮嬶紙HH:mm锛?*/
  workStart: string | null;
  /** 宸ヤ綔鏃舵缁撴潫锛圚H:mm锛?*/
  workEnd: string | null;
}

/** 瀹瑰櫒绾у憡璀﹁鍒欏垪琛ㄥ搷搴旓紙GET /api/notifications/container-rules锛?*/
export interface ContainerRuleListResponse {
  rules: ContainerRule[];
}

/** 瀹瑰櫒绾у憡璀﹁鍒欐柊澧?缂栬緫鍝嶅簲锛圥OST/PUT /api/notifications/container-rules锛?*/
export interface ContainerRuleSaveResponse {
  ok: boolean;
  rule: ContainerRule;
}

/** ===================== 闈㈡澘閰嶇疆瀵煎叆/瀵煎嚭 ===================== */

/** 鍐茬獊澶勭悊绛栫暐锛歴kip=璺宠繃宸插瓨鍦?/ overwrite=瑕嗙洊 / error=鍑洪敊鍗冲洖婊?*/
export type ConfigImportConflict = 'skip' | 'overwrite' | 'error';

/** 閰嶇疆瀵煎嚭涓?data 瀛愬璞＄殑鍗曚釜鍏冪礌锛堥€氱敤瀹芥澗缁撴瀯锛屽瓧娈靛潎涓?camelCase锛?*/
export interface ConfigDataItem {
  [key: string]: any;
}

/** 闈㈡澘閰嶇疆瀵煎嚭锛圙ET /api/system/config/export 杩斿洖鐨?JSON 瀵硅薄锛?*/
export interface SystemConfigExport {
  /** 瀵煎嚭鏍煎紡鐗堟湰 */
  version: number;
  /** 瀵煎嚭鏃堕棿锛圛SO 瀛楃涓诧級 */
  exportedAt: string;
  /** 鏄惁鍖呭惈鏁忔劅瀛楁锛堥€氱煡娓犻亾 / 浜戠 / 鏁版嵁搴撳彛浠ゆ槑鏂囷級 */
  includeSecrets: boolean;
  /** 鍚勫疄浣撴暟鎹?*/
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

/** 閰嶇疆瀵煎叆鍝嶅簲锛圥OST /api/system/config/import 杩斿洖锛?*/
export interface SystemConfigImportResponse {
  ok: boolean;
  /** 瀹為檯閲囩敤鐨勫啿绐佺瓥鐣?*/
  conflict: ConfigImportConflict;
  /** 鍚勫疄浣撳鍏ユ暟閲?*/
  imported: Record<string, number>;
  note?: string;
}

// ---- AI 鍔╂墜锛?api/ai锛?----
export interface AiSettings {
  enabled: boolean;
  /** 鏄惁宸查厤缃笖鍙敤 */
  available: boolean;
  /** 褰撳墠榛樿 profile锛坣ull 琛ㄧず鏈缃級 */
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

// ---- Compose 閫嗗悜锛?api/compose/infer锛?----
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

// ---- 鏃ュ織鑱氬悎锛?api/logs锛?----
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

// ---- 闀滃儚 GC 绛栫暐锛?api/gc锛?----
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

// ---- 缃戠粶鎷撴墤锛?api/topology锛?----
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

/** AI Prompt 妯℃澘 */
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

// Action 瀹℃壒
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

// 鏈湴妯″瀷鐘舵€?
export interface AiLocalModelStatus {
  ok: boolean;
  message: string;
  models: Array<{ id: string; name: string; size?: number }>;
  serviceInfo?: Record<string, unknown>;
}

// 鏂囦欢鍒嗘瀽
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

// Ollama 妯″瀷绠＄悊
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

// 鐭ヨ瘑搴?
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

// AI 鐢ㄩ噺浠〃鐩?
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
