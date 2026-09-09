/**
 * docker run 命令 → Compose 服务（纯函数，零第三方依赖）
 *
 * 解析 docker run 的常用选项并映射为 composeInfer 的 InferService，
 * 复用 renderComposeYaml 渲染。不支持的选项折进 warnings 提示手动处理。
 *
 * 用法：parseRunCommand('docker run -d --name web -p 8080:80 nginx:latest')
 */
import { renderComposeYaml, type InferService } from './composeInfer';

export interface Run2ComposeResult {
  service: InferService;
  /** 顶层命名卷声明（服务内引用到的命名卷） */
  volumes: string[];
  /** 顶层自定义网络声明 */
  networks: string[];
  yaml: string;
  warnings: string[];
}

/** 宿主网络等特殊取值 */
const SKIP_NETWORKS = new Set(['bridge', 'none', 'default']);

/** 已知布尔型选项（不带值），用于未知选项兜底判断 */
const BOOLEAN_FLAGS = new Set([
  '-d', '--detach', '-i', '-t', '--tty', '--interactive', '-it', '--rm', '-q', '--quiet',
  '--privileged', '--init', '--sig-proxy', '--oom-kill-disable', '--read-only', '--no-healthcheck',
]);

/** 解析 shell 词法（支持单双引号与反斜杠转义） */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === '\\' || next === '$') {
          cur += next;
          i++;
          continue;
        }
      }
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '\\' && i + 1 < input.length) {
      // 未加引号上下文：反斜杠转义下一字符（如 \" 表示字面双引号）
      cur += input[i + 1];
      has = true;
      i++;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (cur || has) {
        tokens.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
    }
  }
  if (cur || has) tokens.push(cur);
  return tokens;
}

/** 服务名清洗（compose 服务名约束） */
function safeName(name: string, used: Set<string>): string {
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

/** 时长字符串（如 30s / 1m30s / 500ms）→ 秒数（向下取整） */
function parseDurationSeconds(raw: string): number | undefined {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)?/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2] || 's';
    if (unit === 'ms') total += n / 1000;
    else if (unit === 's') total += n;
    else if (unit === 'm') total += n * 60;
    else if (unit === 'h') total += n * 3600;
  }
  if (!matched) return undefined;
  return Math.floor(total);
}

/** 判断卷源是否为命名卷（非路径） */
function isNamedVolumeSource(src: string): boolean {
  return !src.startsWith('/') && !src.startsWith('~') && !src.startsWith('.');
}

/** 解析 --mount type=bind,source=...,target=...[,readonly] */
export function parseMount(value: string, namedVolumes: Set<string>): { spec?: string; warning?: string } {
  const parts: Record<string, string> = {};
  let readonly = false;
  for (const seg of String(value || '').split(',')) {
    const [k, v] = seg.split('=', 2);
    if (v === undefined) {
      if (k === 'readonly' || k === 'ro') readonly = true;
      continue;
    }
    parts[k.trim()] = v.trim();
  }
  const src = parts.source || parts.src || '';
  const dst = parts.target || parts.dst || parts.destination || '';
  if (!dst) return { warning: `--mount 缺少 target，已忽略: ${value}` };
  if (!src) return { spec: dst }; // 匿名卷
  if (parts.type === 'volume' || !parts.type) {
    if (isNamedVolumeSource(src)) namedVolumes.add(src);
    return { spec: `${src}:${dst}${readonly ? ':ro' : ''}` };
  }
  return { spec: `${src}:${dst}${readonly ? ':ro' : ''}` };
}

/**
 * docker run 命令 → Compose
 * @param input 完整命令（可含或不含 docker 前缀）
 */
export function parseRunCommand(input: string): Run2ComposeResult {
  const warnings: string[] = [];
  const tokens = tokenizeCommand(input);
  // 跳过可选的 docker [container] run 前缀
  let i = 0;
  if (tokens[i] === 'docker') i++;
  if (tokens[i] === 'container') i++;
  if ((tokens[i] || '') !== 'run') {
    throw new Error('仅支持 docker run 命令转换（示例：docker run -d --name web -p 8080:80 nginx:latest）');
  }
  i++;

  const used = new Set<string>();
  let name = '';
  let image = '';
  const ports: string[] = [];
  const volumes: string[] = [];
  const environment: string[] = [];
  const networks: string[] = [];
  const labels: Record<string, string> = {};
  const capAdd: string[] = [];
  const capDrop: string[] = [];
  const devices: string[] = [];
  const namedVolumes = new Set<string>();
  const customNetworks = new Set<string>();
  let restart = '';
  let user = '';
  let workingDir = '';
  let privileged = false;
  let entrypoint = '';
  let healthCmd = '';
  let healthInterval: number | undefined;
  let healthTimeout: number | undefined;
  let healthRetries: number | undefined;
  let cpus = '';
  let memory = '';
  let hostNetwork = false;
  let command: string[] = [];

  const isImageToken = (t: string) => !t.startsWith('-');

  while (i < tokens.length) {
    const tok = tokens[i];
    if (!isImageToken(tok)) {
      // 选项
      let key = tok;
      let inlineValue = '';
      const eq = tok.indexOf('=');
      if (eq > 0 && tok.startsWith('--')) {
        key = tok.slice(0, eq);
        inlineValue = tok.slice(eq + 1);
      }
      const next = () => {
        if (inlineValue) {
          const v = inlineValue;
          inlineValue = '';
          return v;
        }
        i++;
        return tokens[i] ?? '';
      };

      switch (key) {
        case '-p':
        case '--publish':
          ports.push(next());
          break;
        case '-v':
        case '--volume': {
          const v = next();
          const segs = v.split(':');
          if (segs.length === 1) {
            volumes.push(v); // 匿名卷
          } else {
            const src = segs[0];
            if (isNamedVolumeSource(src) && src !== '') namedVolumes.add(src);
            volumes.push(v);
          }
          break;
        }
        case '--mount': {
          const r = parseMount(next(), namedVolumes);
          if (r.spec) volumes.push(r.spec);
          if (r.warning) warnings.push(r.warning);
          break;
        }
        case '-e':
        case '--env':
          environment.push(next());
          break;
        case '--env-file':
          next();
          warnings.push('--env-file 无法自动转换，请手动合并环境变量到 environment');
          break;
        case '--name':
          name = next();
          break;
        case '--restart': {
          const v = next();
          if (v && v !== 'no') restart = v;
          break;
        }
        case '--network':
        case '--net': {
          const v = next();
          const netName = v.split(':', 1)[0] || v; // 去掉 network-alias 后缀
          if (SKIP_NETWORKS.has(netName)) {
            // 默认网络，忽略
          } else if (netName === 'host') {
            hostNetwork = true;
            warnings.push('host 网络需在 Compose 中使用 network_mode: "host"，请手动调整');
          } else {
            networks.push(netName);
            customNetworks.add(netName);
          }
          break;
        }
        case '--network-alias':
          next();
          warnings.push('--network-alias 需在 Compose 网络配置中手动设置 aliases');
          break;
        case '-l':
        case '--label': {
          const v = next();
          const eq2 = v.indexOf('=');
          if (eq2 > 0) labels[v.slice(0, eq2)] = v.slice(eq2 + 1);
          break;
        }
        case '--hostname':
          next();
          warnings.push('hostname 需在 Compose 中使用 hostname 字段（已省略）');
          break;
        case '-u':
        case '--user':
          user = next();
          break;
        case '-w':
        case '--workdir':
          workingDir = next();
          break;
        case '--privileged':
          privileged = true;
          break;
        case '--cap-add':
          capAdd.push(next());
          break;
        case '--cap-drop':
          capDrop.push(next());
          break;
        case '--device':
          devices.push(next());
          break;
        case '--gpus':
          next();
          warnings.push('--gpus 需在 Compose 中使用 deploy.resources.reservations.devices，请手动配置');
          break;
        case '-m':
        case '--memory':
          memory = next();
          break;
        case '--cpus':
          cpus = next();
          break;
        case '--entrypoint':
          entrypoint = next();
          break;
        case '--health-cmd':
          healthCmd = next();
          break;
        case '--health-interval':
          healthInterval = parseDurationSeconds(next());
          break;
        case '--health-timeout':
          healthTimeout = parseDurationSeconds(next());
          break;
        case '--health-retries':
          healthRetries = Number(next()) || undefined;
          break;
        case '--pull':
        case '--log-driver':
        case '--log-opt':
        case '--sysctl':
        case '--ulimit':
        case '--shm-size':
        case '--pid':
        case '--ipc':
        case '--security-opt':
        case '--dns':
        case '--add-host':
        case '--platform':
        case '--cpuset-cpus':
        case '--cpu-shares':
        case '--memory-swap':
        case '--stop-signal':
        case '--stop-timeout':
        case '--tmpfs':
        case '--userns':
        case '--volume-from':
        case '--volumes-from':
        case '--link':
        case '--expose':
        case '--group-add':
        case '--isolation':
        case '--kernel-memory':
        case '--memory-reservation':
        case '--cidfile':
        case '--detach-keys':
        case '--domainname':
          if (BOOLEAN_FLAGS.has(key)) break;
          if (!inlineValue) i++;
          warnings.push(`已忽略选项 ${key}（如需保留请在 Compose 中手动补充）`);
          break;
        default:
          if (BOOLEAN_FLAGS.has(key)) {
            if (key === '--rm') warnings.push('Compose 无 --rm 等价项，服务重启策略可按需设置');
            if (key === '--init') warnings.push('Compose 中可用 init: true，请手动补充');
          } else if (key.startsWith('-') && !inlineValue) {
            // 未知选项：假定无值（其值可能是选项本身）
            warnings.push(`已忽略未知选项 ${key}`);
          } else if (!key.startsWith('-')) {
            // 非 option token（理论上走不到，防御）
            if (!image) image = tok;
          }
      }
      i++;
    } else {
      // 首个非选项 token = 镜像，其余为命令
      image = tok;
      command = tokens.slice(i + 1);
      break;
    }
  }

  if (!image) throw new Error('未识别到镜像名（示例：docker run -d nginx:latest）');
  if (hostNetwork) networks.length = 0;

  const svcName = safeName(name || image.split('/').pop()?.split(':')[0] || 'svc', used);
  const service: InferService = {
    name: svcName,
    image,
    ports,
    volumes,
    environment,
    networks,
    labels,
    restart: restart || undefined,
    user: user || undefined,
    working_dir: workingDir || undefined,
    privileged: privileged || undefined,
    cap_add: capAdd.length ? capAdd : undefined,
    cap_drop: capDrop.length ? capDrop : undefined,
    devices: devices.length ? devices : undefined,
    command: command.length ? command : undefined,
    entrypoint: entrypoint ? [entrypoint] : undefined,
    deployResources: cpus || memory ? { cpus: cpus || undefined, memory: memory || undefined } : undefined,
    healthcheck: healthCmd
      ? {
          test: ['CMD-SHELL', healthCmd],
          interval: healthInterval,
          timeout: healthTimeout,
          retries: healthRetries,
        }
      : undefined,
  };

  const yaml = renderComposeYaml(
    [service],
    [...namedVolumes],
    [...customNetworks],
  );
  return { service, volumes: [...namedVolumes], networks: [...customNetworks], yaml, warnings };
}
