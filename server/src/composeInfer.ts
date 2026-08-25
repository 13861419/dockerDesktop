/**
 * docker run → Compose 逆向（纯函数模块，零依赖）
 *
 * 从 dockerode `inspect()` 返回的结构逆向出 docker-compose YAML 文本。
 * 全模块为纯函数（不触 Docker、不读文件、不写盘），便于单元测试。
 *
 * 关键设计：
 *  - 只读语义：绝不执行任何 Docker 写操作。
 *  - 命名卷归集到顶层 `volumes:`，自定义网络归集到顶层 `networks:`。
 *  - 无法在 Compose 稳定表达的字段（匿名卷、置于 Binds 的未命名卷、--rm）输出 warning 而不报错。
 *  - YAML 序列化手写缩进（2 空格），输出稳定、可被 `validateComposeYaml` 解析。
 */

/** 单个容器 inspect 的子集（只取逆向需要的字段） */
export interface InferInput {
  id?: string;
  Name?: string | string[];
  Config?: {
    Image?: string;
    Cmd?: string[];
    Entrypoint?: string[];
    Env?: string[];
    Labels?: Record<string, string>;
    User?: string;
    WorkingDir?: string;
    Hostname?: string;
    Tty?: boolean;
    Healthcheck?: {
      Test?: string[];
      Interval?: number;
      Timeout?: number;
      Retries?: number;
    };
  };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
    Binds?: string[];
    RestartPolicy?: { Name?: string };
    NetworkMode?: string;
    Privileged?: boolean;
    AutoRemove?: boolean;
    NanoCpus?: number;
    Memory?: number;
    CpusetCpus?: string;
    CpuShares?: number;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Target?: string; RW?: boolean }>;
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID?: string; Aliases?: string[] }>;
  };
}

/** 逆向产出的单个服务 */
export interface InferService {
  name: string;
  image: string;
  ports: string[];            // 形如 "8080:80" 或 "53:53/udp"
  volumes: string[];          // 形如 "volname:/data" 或 "/host:/cont:ro"
  environment: string[];
  networks: string[];         // 自定义网络名
  labels: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  user?: string;
  working_dir?: string;
  restart?: string;
  privileged?: boolean;
  deployResources?: { cpus?: string; memory?: string };
  healthcheck?: {
    test: string[];
    interval?: number;
    timeout?: number;
    retries?: number;
  };
}

/** 逆向结果 */
export interface InferResult {
  projectName: string;
  services: InferService[];
  /** 顶层命名卷 */
  volumes: string[];
  /** 顶层自定义网络 */
  networks: string[];
  yaml: string;
  warnings: string[];
}

/** docker compose 自动注入 / 无意义的默认环境变量（过滤噪音） */
const NOISE_ENV = new Set(['PATH', 'HOSTNAME', 'HOME', 'TERM', 'PWD', 'SHLVL']);

/** compose 自动写入的标签前缀（过滤，避免把 compose 自身管理标签写进 labels） */
const COMPOSE_LABEL_PREFIX = 'com.docker.compose.';
const FILTER_LABEL_KEYS = ['org.opencontainers.image.title', 'org.opencontainers.image.description', 'org.opencontainers.image.source', 'org.opencontainers.image.url'];

function safeServiceName(name: string, used: Set<string>): string {
  let base = String(name || '')
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_');
  if (!base) base = 'svc';
  if (/^[^A-Za-z]/.test(base)) base = 'svc_' + base;
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${i}`;
    i++;
  }
  used.add(candidate);
  return candidate;
}

/** 字节 → 人类可读（memory 限制） */
function fmtMemory(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes % (1024 * 1024 * 1024) === 0) return `${bytes / (1024 * 1024 * 1024)}g`;
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}m`;
  return `${Math.round(bytes / (1024 * 1024))}m`;
}

function yamlKey(key: string): string {
  // 若含特殊字符则用引号包裹
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : `"${key.replace(/"/g, '\\"')}"`;
}

/**
 * 单容器 inspect → InferService（纯函数）
 * @param input inspect 结构
 * @returns 服务定义（含命名卷/网络占位，卷引用形如 vol_<name>）
 */
export function inferService(input: InferInput): { service: InferService; warnings: string[] } {
  const warnings: string[] = [];
  const cfg = input.Config || {};
  const hc = input.HostConfig || {};
  const labels: Record<string, string> = {};

  if (cfg.Labels && typeof cfg.Labels === 'object') {
    for (const [k, v] of Object.entries(cfg.Labels)) {
      if (!k) continue;
      if (k.startsWith(COMPOSE_LABEL_PREFIX)) continue;
      if (FILTER_LABEL_KEYS.includes(k)) continue;
      labels[k] = String(v);
    }
  }

  // 端口：遍历 PortBindings -> "8080:80[/udp]" 或 "80[/udp]"
  const finalPorts: string[] = [];
  const portBindings = hc.PortBindings || {};
  for (const [key, bindings] of Object.entries(portBindings)) {
    const m = key.match(/^(\d+)\/(\w+)$/);
    const target = m ? m[1] : key.split('/')[0];
    const protocol = m ? m[2] : 'tcp';
    const binding = Array.isArray(bindings) && bindings[0] ? bindings[0] : null;
    const hostPort = binding?.HostPort;
    if (hostPort) {
      finalPorts.push(`${hostPort}:${target}${protocol && protocol !== 'tcp' ? '/' + protocol : ''}`);
    } else {
      finalPorts.push(`${target}${protocol && protocol !== 'tcp' ? '/' + protocol : ''}`);
    }
  }

  // 卷：以 Mounts 为主
  const warnings2: string[] = [];
  const volumes: string[] = [];
  const namedVolumes: string[] = [];
  const bindVolumes: string[] = [];
  const mounts = Array.isArray(input.Mounts) ? input.Mounts : [];
  const seenTargets = new Set<string>();
  for (const m of mounts) {
    const target = m?.Target;
    if (!target || seenTargets.has(target)) continue;
    const ro = m?.RW === false ? ':ro' : '';
    if (m?.Type === 'volume' && m?.Source) {
      // 命名卷：归集到顶层
      namedVolumes.push(m.Source);
      volumes.push(`${m.Source}:${target}${ro}`);
    } else if (m?.Type === 'bind' && m?.Source) {
      bindVolumes.push(`${m.Source}:${target}${ro}`);
      volumes.push(`${m.Source}:${target}${ro}`);
    } else {
      // 匿名卷（Source 为空的长 hash）或 tmpfs 等 → warning
      warnings2.push(`容器存在不可逆的匿名卷/临时卷（目标 ${target}），已在 Compose 中省略`);
    }
    seenTargets.add(target);
  }
  // 兜底：若 Mounts 为空则用 HostConfig.Binds
  if (mounts.length === 0 && Array.isArray(hc.Binds)) {
    for (const bind of hc.Binds) {
      const parts = bind.split(':');
      if (parts.length >= 2) {
        const source = parts[0];
        const target = parts[1];
        const ro = parts.length > 2 && parts[2].split(',').includes('ro') ? ':ro' : '';
        if (!source.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(source)) {
          namedVolumes.push(source);
        } else {
          bindVolumes.push(`${source}:${target}${ro}`);
        }
        volumes.push(`${source}:${target}${ro}`);
      }
    }
  }

  // 环境变量（过滤噪音）
  const environment: string[] = [];
  for (const e of Array.isArray(cfg.Env) ? cfg.Env : []) {
    const eq = e.indexOf('=');
    const key = eq >= 0 ? e.slice(0, eq) : e;
    if (!key || NOISE_ENV.has(key)) continue;
    if (key.startsWith('com.docker.compose.')) continue;
    environment.push(e);
  }

  // 网络：识别自定义网络（非 bridge/host/none/default/null）
  const networks: string[] = [];
  let networkMode = hc.NetworkMode || 'default';
  const netSettings = input.NetworkSettings?.Networks;
  if (netSettings && typeof netSettings === 'object') {
    for (const n of Object.keys(netSettings)) {
      if (['bridge', 'host', 'none', 'default', 'null', 'container'].includes(n)) continue;
      networks.push(n);
    }
    // 若 NetworkMode 指向容器网络或自定义未列出，则用 NetworkMode
    if (!['bridge', 'host', 'none', 'default', 'null'].includes(networkMode)) {
      if (!networks.includes(networkMode)) networks.push(networkMode);
    }
  }

  // 资源限制
  let deployResources: { cpus?: string; memory?: string } | undefined;
  if (hc.NanoCpus || hc.Memory) {
    deployResources = {};
    if (hc.NanoCpus) deployResources.cpus = String(Number(hc.NanoCpus) / 1e9).replace(/\.0+$/, '');
    if (hc.Memory) deployResources.memory = fmtMemory(hc.Memory);
  }

  // 重启策略
  let restart: string | undefined;
  const rpName = hc.RestartPolicy?.Name;
  if (rpName && rpName !== 'no') restart = rpName;

  // 健康检查
  let healthcheck: InferService['healthcheck'];
  if (cfg.Healthcheck && Array.isArray(cfg.Healthcheck.Test) && cfg.Healthcheck.Test.length) {
    healthcheck = {
      test: cfg.Healthcheck.Test,
      interval: cfg.Healthcheck.Interval ? Math.round(cfg.Healthcheck.Interval / 1e9) : undefined,
      timeout: cfg.Healthcheck.Timeout ? Math.round(cfg.Healthcheck.Timeout / 1e9) : undefined,
      retries: cfg.Healthcheck.Retries ?? 0,
    };
  }

  const warnings3: string[] = [];
  if (hc.AutoRemove) warnings3.push('该容器启用了 --rm（AutoRemove），Compose 无对应语义，重建后需手动管理生命周期');

  const service: InferService = {
    name: '',
    image: cfg.Image || '',
    ports: finalPorts,
    volumes,
    environment,
    networks: Array.from(new Set(networks)),
    labels,
    restart,
    privileged: hc.Privileged || undefined,
    deployResources,
    healthcheck,
  };
  if (cfg.User) service.user = cfg.User;
  if (cfg.WorkingDir) service.working_dir = cfg.WorkingDir;
  if (Array.isArray(cfg.Entrypoint) && cfg.Entrypoint.length) service.entrypoint = cfg.Entrypoint;
  if (Array.isArray(cfg.Cmd) && cfg.Cmd.length) service.command = cfg.Cmd;

  return { service, warnings: [...warnUniq([...warnings, ...warnings2, ...warnings3])] };
}

function warnUniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * 生成 Compose 顶层 volumes 的命名（如果命名卷与容器名冲突则加后缀）
 */
function nameVol(namedVolumes: string[], usedNames: Set<string>): Array<{ src: string; name: string }> {
  const out: Array<{ src: string; name: string }> = [];
  const used = new Set<string>(usedNames);
  for (const src of namedVolumes) {
    const base = String(src).replace(/[^A-Za-z0-9_.-]/g, '_');
    let name = base || 'vol';
    if (/^[^A-Za-z]/.test(name)) name = 'vol_' + name;
    let candidate = name;
    let i = 2;
    while (used.has(candidate)) {
      candidate = `${name}_${i}`;
      i++;
    }
    used.add(candidate);
    out.push({ src, name: candidate });
  }
  return out;
}

/**
 * 多容器 inspect → Compose 对象 + YAML（核心入口，纯函数）
 * @param inputs 容器 inspect 数组
 * @param opts 可选项
 */
export function inferCompose(inputs: InferInput[], opts: { projectName?: string } = {}): InferResult {
  const warnings: string[] = [];
  const usedServiceNames = new Set<string>();
  const allNamedVolumes = new Set<string>();
  const allNetworks = new Set<string>();

  const services: InferService[] = [];
  for (const input of inputs) {
    const rawName = Array.isArray(input.Name) ? input.Name[0]?.replace(/^\//, '') || '' : String(input.Name || '').replace(/^\//, '');
    const svc = inferService(input);
    warnings.push(...svc.warnings);
    if (!svc.service.image) {
      const id = (input.id || '').slice(0, 12);
      warnings.push(`容器 ${rawName || id} 缺少 image，已跳过`);
      continue;
    }
    svc.service.name = safeServiceName(rawName || svc.service.image.split(':')[0] || 'svc', usedServiceNames);
    services.push(svc.service);
    for (const v of svc.service.volumes) {
      const src = v.split(':')[0];
      if (src && !src.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(src)) allNamedVolumes.add(src);
    }
    for (const n of svc.service.networks) allNetworks.add(n);
  }

  // 命名卷重映射
  const usedNames = new Set<string>(['data', 'config']);
  const volMap = nameVol(Array.from(allNamedVolumes), usedNames);
  const remapped: Record<string, string> = {};
  for (const v of volMap) remapped[v.src] = v.name;
  for (const s of services) {
    // 只重映射命名卷形式的挂载（前段不为绝对路径）
    s.volumes = s.volumes.map((v: string) => {
      const parts = v.split(':');
      const src = parts[0];
      if (src && !src.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(src) && remapped[src]) {
        parts[0] = remapped[src];
        return parts.join(':');
      }
      return v;
    });
  }
  const topVolumes = volMap.map((v) => v.name);
  const topNetworks = Array.from(allNetworks);

  const projectName = opts.projectName || `inferred-${new Date().getTime().toString(36)}`;
  const yaml = renderComposeYaml(services, topVolumes, topNetworks);

  return { projectName, services, volumes: topVolumes, networks: topNetworks, yaml, warnings: warnUniq(warnings) };
}

/**
 * 渲染 compose yaml（手写缩进，纯函数）
 * @param services 服务列表
 * @param volumes 顶层命名卷
 * @param networks 顶层自定义网络
 */
export function renderComposeYaml(services: InferService[], volumes: string[] = [], networks: string[] = []): string {
  const lines: string[] = [];
  lines.push('services:');
  for (const s of services) {
    lines.push(`  ${yamlKey(s.name)}:`);
    if (s.image) lines.push(`    image: ${s.image}`);
    if (s.command && s.command.length) lines.push(`    command: ${JSON.stringify(s.command)}`);
    if (s.entrypoint && s.entrypoint.length) lines.push(`    entrypoint: ${JSON.stringify(s.entrypoint)}`);
    if (s.environment && s.environment.length) {
      lines.push('    environment:');
      for (const e of s.environment) lines.push(`      - "${e.replace(/"/g, '\\"')}"`);
    }
    if (s.ports && s.ports.length) {
      lines.push('    ports:');
      for (const p of s.ports) lines.push(`      - ${p}`);
    }
    if (s.volumes && s.volumes.length) {
      lines.push('    volumes:');
      for (const v of s.volumes) lines.push(`      - ${v}`);
    }
    if (s.networks && s.networks.length) {
      lines.push('    networks:');
      for (const n of s.networks) lines.push(`      - ${yamlKey(n)}`);
    }
    if (s.labels && Object.keys(s.labels).length) {
      lines.push('    labels:');
      for (const [k, v] of Object.entries(s.labels)) lines.push(`      ${yamlKey(k)}: ${JSON.stringify(String(v))}`);
    }
    if (s.user) lines.push(`    user: ${s.user}`);
    if (s.working_dir) lines.push(`    working_dir: ${s.working_dir}`);
    if (s.restart) lines.push(`    restart: ${s.restart}`);
    if (s.privileged) lines.push('    privileged: true');
    if (s.healthcheck && s.healthcheck.test) {
      lines.push('    healthcheck:');
      lines.push(`      test: ${JSON.stringify(s.healthcheck.test)}`);
      if (s.healthcheck.interval) lines.push(`      interval: ${s.healthcheck.interval}s`);
      if (s.healthcheck.timeout) lines.push(`      timeout: ${s.healthcheck.timeout}s`);
      if (s.healthcheck.retries) lines.push(`      retries: ${s.healthcheck.retries}`);
    }
    if (s.deployResources && (s.deployResources.cpus || s.deployResources.memory)) {
      lines.push('    deploy:');
      lines.push('      resources:');
      lines.push('        limits:');
      if (s.deployResources.cpus) lines.push(`          cpus: ${s.deployResources.cpus}`);
      if (s.deployResources.memory) lines.push(`          memory: ${s.deployResources.memory}`);
    }
  }
  if (volumes.length) {
    lines.push('volumes:');
    for (const v of volumes) lines.push(`  ${yamlKey(v)}:`);
  }
  if (networks.length) {
    lines.push('networks:');
    for (const n of networks) lines.push(`  ${yamlKey(n)}:`);
  }
  return lines.join('\n') || 'services: {}';
}
