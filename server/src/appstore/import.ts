/**
 * 应用商店第三方格式导入（1.93.0）
 *
 * 支持把 CasaOS 应用商店的应用清单 JSON 与 1Panel 应用（data.yml + docker-compose.yml）
 * 转换为面板自定义应用（appstore_custom_apps），格式自动识别：
 *
 * 1. CasaOS：单个对象或对象数组（title/tagline/description/category/icons +
 *    container{image,port_mapping,volumes,environments} 或 compose 文本）
 * 2. 1Panel：data.yml（name/tagline/description/category）+ docker-compose.yml
 *    （{{ .Values.x }} 模板占位符转为 ${X}）
 * 3. 通用 docker-compose.yml：服务 ≥1 即可导入为 Compose 套件应用
 */
import { parse as parseYaml } from 'yaml';

/** 导入产出的自定义应用字段（与 pickCustomAppFields / appstore_custom_apps 列对齐） */
export interface ImportedApp {
  name: string;
  description: string;
  category: string;
  image: string;
  icon: string;
  ports: Array<{ container: number; host?: number }>;
  env: Array<{ key: string; value?: string; desc?: string }>;
  volumes: Array<{ container: string; host?: string }>;
  tags: string[];
  compose?: { compose: string; services: string[]; ports: any[]; env: any[]; volumes: any[]; defaultVersion?: string } | null;
}

/** 导入单条失败原因 */
export interface ImportFailure {
  index: number;
  name: string;
  reason: string;
}

/** 识别结果 */
export interface ImportResult {
  format: 'casaos' | '1panel' | 'compose';
  apps: ImportedApp[];
  failures: ImportFailure[];
}

/**
 * 1Panel compose 模板占位符转换：
 *   {{ .Values.x }} → ${X}
 *   {{ .Values.x | default "y" }} → ${X:-y}
 *   {{- .Values.x }} 等空白控制符一并清理
 */
export function convert1PanelTemplate(text: string): { converted: string; params: string[] } {
  const params = new Set<string>();
  const converted = String(text || '').replace(
    /\{\{-?\s*\.Values\.([a-zA-Z0-9_]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g,
    (_m, key: string, rest: string) => {
      params.add(key);
      // 清理 YAML 转义残留（\" 等）后提取 default 值
      const clean = String(rest || '').replace(/\\/g, '').trim();
      const dm = clean.match(/default\s+["']?([^"'\s}]+)["']?/);
      return dm ? '${' + key.toUpperCase() + ':-' + dm[1] + '}' : '${' + key.toUpperCase() + '}';
    },
  );
  return { converted, params: Array.from(params) };
}

/** 从 compose 文本提取镜像标签版本（首个服务的 image tag） */
function firstImageVersion(composeText: string): string | undefined {
  const m = /image:\s*[^\s:]+\/?([^\s:]+):([^\s{]+)/.exec(composeText) || /image:\s*[^\s:]+:([^\s{]+)/.exec(composeText);
  return m ? m[2] : undefined;
}

/** 从解析后的 compose 文档汇总 services / ports / env / volumes */
function summarizeCompose(doc: any, composeText: string, params: string[]): ImportedApp['compose'] {
  const servicesMap = (doc && typeof doc === 'object' && (doc as any).services) || {};
  const services = Object.keys(servicesMap || {});
  const ports: Array<{ container: number; host?: number }> = [];
  const env: Array<{ key: string; value?: string }> = [];
  const volumes: Array<{ container: string; host?: string }> = [];
  for (const s of services) {
    const svc = servicesMap[s] || {};
    for (const p of svc.ports || []) {
      const str = String(p).trim();
      // 支持 "host:container"、"ip:host:container"、"container"、"container/udp"
      const segs = str.replace(/\/\w+$/, '').split(':');
      const c = Number(segs[segs.length - 1]);
      const h = segs.length >= 2 ? Number(segs[segs.length - 2]) : NaN;
      if (Number.isFinite(c) && c > 0) ports.push({ container: c, host: Number.isFinite(h) ? h : undefined });
    }
    const envRaw = svc.environment || svc.env || [];
    if (Array.isArray(envRaw)) {
      for (const e of envRaw) {
        if (typeof e !== 'string') continue;
        const [k, ...rest] = e.split('=');
        if (k) env.push({ key: k.trim(), value: rest.join('=').trim() || undefined });
      }
    } else if (envRaw && typeof envRaw === 'object') {
      for (const [k, v] of Object.entries(envRaw)) env.push({ key: k, value: String(v ?? '') });
    }
    for (const v of svc.volumes || []) {
      const str = typeof v === 'string' ? v : String(v?.target || '');
      const parts = str.split(':').map((x) => x.trim());
      if (parts.length >= 2) volumes.push({ container: parts[1], host: parts[0] });
    }
  }
  for (const p of params) {
    if (!env.some((e) => e.key.toUpperCase() === p.toUpperCase())) env.push({ key: p.toUpperCase(), value: '' });
  }
  return { compose: composeText, services, ports, env, volumes, defaultVersion: firstImageVersion(composeText) };
}

/** 安全解析 YAML 文本，失败返回 null */
function tryYaml(text: string): any {
  try {
    return parseYaml(text);
  } catch {
    return null;
  }
}

/** 尝试 JSON 解析，失败返回 null */
function tryJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** CasaOS 单条清单 → 自定义应用字段；不合法返回 null */
function fromCasaOS(obj: any, sourceTag: string): ImportedApp | null {
  if (!obj || typeof obj !== 'object') return null;
  const title = String(obj.title || obj.name || '').trim();
  const container = obj.container && typeof obj.container === 'object' ? obj.container : obj;
  const image = String(container?.image || obj.image || '').trim();
  const composeText = typeof obj.compose === 'string' ? obj.compose : '';
  // 纯 compose 应用（无单容器 image）也允许导入
  if (!title || (!image && !composeText)) return null;

  const ports = (container?.port_mapping || obj.port_mapping || [])
    .map((p: any) => ({
      container: Number(p?.container_port ?? p?.container ?? 0),
      host: p?.host_port !== undefined && p?.host_port !== null ? Number(p.host_port) : undefined,
    }))
    .filter((p: any) => p.container > 0);
  const env = (container?.environments || obj.environments || [])
    .filter((e: any) => e?.key)
    .map((e: any) => ({ key: String(e.key), value: e.value === undefined || e.value === null ? '' : String(e.value) }));
  const volumes = (container?.volumes || obj.volumes || [])
    .map((v: any) => ({ container: String(v?.container_path ?? v?.container ?? ''), host: v?.host_path ?? v?.host ?? undefined }))
    .filter((v: any) => v.container);

  const category = Array.isArray(obj.category) ? String(obj.category[0] || '') : String(obj.category || '');
  const app: ImportedApp = {
    name: title,
    description: String(obj.description || obj.tagline || ''),
    category: category || '导入',
    image,
    icon: '📦',
    ports,
    env,
    volumes,
    tags: ['imported', sourceTag],
  };
  // compose 文本（多容器 CasaOS 应用）：统一转 ${} 占位并汇总服务
  if (composeText) {
    const doc = tryYaml(composeText);
    if (doc) app.compose = summarizeCompose(doc, composeText, []);
  } else {
    app.compose = null;
  }
  return app;
}

/** 解析 CasaOS 清单（对象 / 数组 / {"apps": [...]} 均可） */
function parseCasaOS(json: any, sourceTag: string): { apps: ImportedApp[]; failures: ImportFailure[] } {
  const list: any[] = Array.isArray(json) ? json : json && Array.isArray(json.apps) ? json.apps : [json];
  const apps: ImportedApp[] = [];
  const failures: ImportFailure[] = [];
  list.forEach((item, i) => {
    const app = fromCasaOS(item, sourceTag);
    if (app) apps.push(app);
    else failures.push({ index: i, name: String(item?.title || item?.name || ''), reason: '缺少 title/name 或 image 字段' });
  });
  return { apps, failures };
}

/** 解析 1Panel 应用：data.yml 元数据 + docker-compose.yml 模板 */
function parse1Panel(dataYml: string, composeYml: string): { apps: ImportedApp[]; failures: ImportFailure[] } {
  const failures: ImportFailure[] = [];
  const meta = dataYml ? tryYaml(dataYml) : null;
  if (dataYml && !meta) failures.push({ index: 0, name: 'data.yml', reason: 'data.yml 解析失败' });
  if (!composeYml || !composeYml.trim()) {
    if (failures.length) return { apps: [], failures };
    failures.push({ index: 0, name: '', reason: '缺少 docker-compose.yml 内容' });
    return { apps: [], failures };
  }
  const doc = tryYaml(composeYml);
  if (!doc || !doc.services || typeof doc.services !== 'object' || !Object.keys(doc.services).length) {
    failures.push({ index: 0, name: String(meta?.name || ''), reason: 'docker-compose.yml 解析失败或无 services' });
    return { apps: [], failures };
  }
  const { converted, params } = convert1PanelTemplate(composeYml);
  const app: ImportedApp = {
    name: String(meta?.name || '1Panel 应用'),
    description: String(meta?.description || meta?.tagline || ''),
    category: String(meta?.category || '导入'),
    image: '',
    icon: '📦',
    ports: [],
    env: [],
    volumes: [],
    tags: ['imported', '1panel'],
    compose: summarizeCompose(doc, converted, params),
  };
  return { apps: [app], failures };
}

/** 解析通用 docker-compose.yml 为 Compose 套件应用 */
function parseGenericCompose(composeYml: string): { apps: ImportedApp[]; failures: ImportFailure[] } {
  const doc = tryYaml(composeYml);
  if (!doc || !doc.services || typeof doc.services !== 'object' || !Object.keys(doc.services).length) {
    return { apps: [], failures: [{ index: 0, name: '', reason: 'docker-compose.yml 解析失败或无 services' }] };
  }
  const nameGuess = Object.keys(doc.services)[0] || 'Compose 应用';
  return {
    apps: [
      {
        name: nameGuess,
        description: '',
        category: '导入',
        image: '',
        icon: '📦',
        ports: [],
        env: [],
        volumes: [],
        tags: ['imported', 'compose'],
        compose: summarizeCompose(doc, composeYml, []),
      },
    ],
    failures: [],
  };
}

/**
 * 自动识别并解析导入文本
 * @param text 粘贴的清单内容（CasaOS JSON / 1Panel data.yml+compose / 通用 compose）
 * @param dataYml 1Panel 的 data.yml（可选，与 composeYml 配合）
 * @param composeYml 1Panel 的 docker-compose.yml（可选）
 */
export function parseImportPayload(text: string, dataYml?: string, composeYml?: string): ImportResult {
  const trimmed = String(text || '').trim();
  if (!trimmed && !(dataYml || composeYml)) {
    return { format: 'compose', apps: [], failures: [{ index: 0, name: '', reason: '导入内容为空' }] };
  }

  // 1. 显式给了 composeYml 或内容看起来像 YAML compose → 1Panel / 通用 compose
  const looksLikeCompose =
    (composeYml && composeYml.trim()) ||
    (/^services\s*:/m.test(trimmed) && !trimmed.startsWith('{'));
  if (looksLikeCompose) {
    const composeText = (composeYml || trimmed).trim();
    const is1Panel = /\{\{\.? ?Values\./.test(composeText) || (dataYml && dataYml.trim());
    const r = is1Panel ? parse1Panel(dataYml || '', composeText) : parseGenericCompose(composeText);
    return { format: is1Panel ? '1panel' : 'compose', ...r };
  }

  // 2. JSON → CasaOS
  const json = tryJson(trimmed);
  if (json) {
    return { format: 'casaos', ...parseCasaOS(json, 'casaos') };
  }

  // 3. 整段 YAML 且含 services → 通用 compose
  const doc = tryYaml(trimmed);
  if (doc && doc.services) {
    return { format: 'compose', ...parseGenericCompose(trimmed) };
  }

  return { format: 'compose', apps: [], failures: [{ index: 0, name: '', reason: '无法识别格式：请粘贴 CasaOS JSON 或 docker-compose.yml' }] };
}
