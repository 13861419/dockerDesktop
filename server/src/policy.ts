/**
 * 安全基线策略引擎
 *
 * 对存量容器执行一组安全基线规则检查，输出违规清单（容器 + 规则 + 严重度）。
 * 规则参考 CIS Docker Benchmark 与常见加固实践：
 * - 禁止 privileged 特权模式
 * - 禁止挂载 Docker Socket / 宿主机根目录等敏感路径
 * - 建议设置内存 / CPU 资源限制
 * - 建议定义重启策略
 * - 建议携带 owner 标签便于责任归属
 *
 * 高危操作写入 approvals 表走审批流后执行（二期已实现）。
 * 定时扫描（三期）：baselineScan 任务类型 + 违规变更告警推送通知渠道。
 */
import { getDockerClient } from './docker/client';
import { getDb } from './storage';
import { listChannels, sendAlert } from './notify';
import { registerTaskHandler, type CronTaskRow, type TaskRunResult } from './scheduler';

/** 违规严重度 */
export type ViolationSeverity = 'danger' | 'warn' | 'info';

/** 单个安全基线规则 */
export interface PolicyRule {
  /** 规则 ID（稳定，供前端定位） */
  id: string;
  /** 规则名称 */
  name: string;
  /** 严重度 */
  severity: ViolationSeverity;
  /** 说明 */
  description: string;
  /** 加固建议 */
  advice: string;
  /** 是否支持在线自动修复（container.update 可达；需重建容器的规则不支持） */
  fixable?: boolean;
}

/** 单条违规记录 */
export interface PolicyViolation {
  containerId: string;
  containerName: string;
  image: string;
  rule: PolicyRule;
  /** 违规明细（如命中的挂载路径） */
  detail: string;
}

/** 全部安全基线规则（与下方检查逻辑一一对应） */
export const POLICY_RULES: PolicyRule[] = [
  {
    id: 'no-privileged',
    name: '禁止特权模式',
    severity: 'danger',
    description: '容器以 privileged 模式运行时拥有宿主机几乎全部能力',
    advice: '按需授予具体能力（--cap-add），移除 privileged',
  },
  {
    id: 'no-sensitive-mount',
    name: '禁止挂载敏感宿主路径',
    severity: 'danger',
    description: '挂载 /、/etc、/proc、/sys 或 /var/run/docker.sock 会带来逃逸风险',
    advice: '移除敏感路径挂载；需要操作 Docker API 时使用代理或最小化方案',
  },
  {
    id: 'mem-limit',
    name: '内存限制',
    severity: 'warn',
    description: '未设置内存限制的容器可能耗尽宿主机内存',
    advice: '创建时通过 --memory 设置内存上限',
    fixable: true,
  },
  {
    id: 'cpu-limit',
    name: 'CPU 限制',
    severity: 'warn',
    description: '未设置 CPU 限制的容器可能挤占宿主机算力',
    advice: '创建时通过 --cpus 或 --cpu-quota 限制 CPU',
    fixable: true,
  },
  {
    id: 'restart-policy',
    name: '重启策略',
    severity: 'info',
    description: '未定义重启策略的容器在宿主机重启后不会自动拉起',
    advice: '按需设置 unless-stopped / always 重启策略',
    fixable: true,
  },
  {
    id: 'owner-label',
    name: 'owner 标签',
    severity: 'info',
    description: '缺少 owner 标签，责任归属与批量管理不便',
    advice: '为容器添加 com.docker.compose.project 或 owner 标签',
  },
];

/** 扫描结果行 */
export interface PolicyScanRow {
  containerId: string;
  containerName: string;
  image: string;
  state: string;
  /** 该容器命中的违规项 */
  violations: Array<{ ruleId: string; detail: string }>;
}

/** 完整扫描报告 */
export interface PolicyScanReport {
  scannedAt: number;
  containerCount: number;
  /** 合规容器数（零违规） */
  passCount: number;
  rules: PolicyRule[];
  rows: PolicyScanRow[];
  /** 按严重度统计违规数 */
  summary: Record<ViolationSeverity, number>;
}

/**
 * 检查单个容器 inspect 结果，返回命中的违规项
 * @param inspected container.inspect() 结果
 */
export function checkContainer(inspected: any): Array<{ ruleId: string; detail: string }> {
  const violations: Array<{ ruleId: string; detail: string }> = [];
  const host = inspected?.HostConfig || {};
  const name = (inspected?.Name || '').replace(/^\//, '');

  // 1. 特权模式
  if (host.Privileged === true) {
    violations.push({ ruleId: 'no-privileged', detail: 'HostConfig.Privileged = true' });
  }

  // 2. 敏感路径挂载（Binds/Mounts 双来源归一化检查）
  const sensitive = [/^\/$/, /^\/etc(\/|$)/, /^\/proc(\/|$)/, /^\/sys(\/|$)/, /^\/var\/run\/docker\.sock$/];
  const binds: string[] = [...(host.Binds || [])];
  for (const m of host.Mounts || []) {
    const src = m.Source || '';
    const dst = m.Destination || m.Target || '';
    if (src) binds.push(`${src}:${dst}`);
  }
  for (const bind of binds) {
    const hostPath = (bind.split(':')[0] || '').trim();
    if (sensitive.some((re) => re.test(hostPath))) {
      violations.push({ ruleId: 'no-sensitive-mount', detail: `挂载宿主路径 ${hostPath}` });
    }
  }

  // 3. 内存限制
  if (!Number(host.Memory) || Number(host.Memory) <= 0) {
    violations.push({ ruleId: 'mem-limit', detail: '未设置内存限制' });
  }

  // 4. CPU 限制（NanoCpus 或 CpuQuota 二者其一即可）
  const nano = Number(host.NanoCpus) || 0;
  const quota = Number(host.CpuQuota) || 0;
  if (nano <= 0 && quota <= 0) {
    violations.push({ ruleId: 'cpu-limit', detail: '未设置 CPU 限制' });
  }

  // 5. 重启策略
  const restart = host.RestartPolicy?.Name || '';
  if (!restartPolicyValid(restart)) {
    violations.push({ ruleId: 'restart-policy', detail: `重启策略为 ${restart || '未设置（no）'}` });
  }

  // 6. owner 标签
  const labels = inspected?.Config?.Labels || {};
  if (!labels.owner && !labels['com.docker.compose.project']) {
    violations.push({ ruleId: 'owner-label', detail: `容器 ${name} 未携带 owner 或 compose 项目标签` });
  }

  return violations;
}

/** 重启策略是否合规（除 no/空 外均视为已定义） */
function restartPolicyValid(name: string): boolean {
  return name === 'always' || name === 'unless-stopped' || name === 'on-failure';
}

/**
 * 扫描全部存量容器，生成安全基线报告
 */
export async function scanPolicy(): Promise<PolicyScanReport> {
  const docker = await getDockerClient();
  const containers = (await docker.listContainers({ all: true }).catch(() => [])) as any[];

  const rows: PolicyScanRow[] = [];
  await Promise.all(
    containers.map(async (c) => {
      try {
        const inspected = await docker.getContainer(c.Id).inspect();
        const found = checkContainer(inspected);
        rows.push({
          containerId: c.Id.slice(0, 12),
          containerName: (c.Names?.[0] || '').replace(/^\//, '') || c.Id.slice(0, 12),
          image: c.Image || '',
          state: c.State || '',
          violations: found,
        });
      } catch {
        // 单容器 inspect 失败时跳过，不影响整体扫描
      }
    }),
  );

  rows.sort((a, b) => a.containerName.localeCompare(b.containerName));

  return {
    scannedAt: Date.now(),
    containerCount: rows.length,
    passCount: rows.filter((r) => r.violations.length === 0).length,
    rules: POLICY_RULES,
    rows,
    summary: summaryCount(rows),
  };
}

/** 按严重度统计违规总数 */
function summaryCount(rows: PolicyScanRow[]): Record<ViolationSeverity, number> {
  const ruleMap = new Map(POLICY_RULES.map((r) => [r.id, r]));
  const out: Record<ViolationSeverity, number> = { danger: 0, warn: 0, info: 0 };
  for (const row of rows) {
    for (const v of row.violations) {
      const sev = ruleMap.get(v.ruleId)?.severity || 'info';
      out[sev] += 1;
    }
  }
  return out;
}

// ==================== 定时扫描任务（baselineScan） ====================

/** 上次扫描快照在 setting 表中的隐藏键（不进设置注册中心，不暴露到设置接口） */
const SNAPSHOT_KEY = 'baseline.lastScan';

/** 违规快照：用于跨次扫描的"新增违规"对比 */
interface BaselineSnapshot {
  scannedAt: number;
  /** 违规键列表，格式 `${containerId}:${ruleId}` */
  keys: string[];
  summary: Record<ViolationSeverity, number>;
}

/** 严重度排序：info < warn < danger */
const SEVERITY_ORDER: Record<ViolationSeverity, number> = { info: 0, warn: 1, danger: 2 };

function readSnapshot(): BaselineSnapshot | null {
  try {
    const row = getDb()
      .prepare('SELECT value FROM setting WHERE key = ?')
      .get(SNAPSHOT_KEY) as { value: string } | undefined;
    if (!row?.value) return null;
    return JSON.parse(row.value) as BaselineSnapshot;
  } catch {
    return null;
  }
}

function saveSnapshot(s: BaselineSnapshot): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)')
    .run(SNAPSHOT_KEY, JSON.stringify(s));
}

/** 推送文本到所有启用的通知渠道（单渠道失败不影响整体，与巡检推送同风格） */
async function notifyAllChannels(text: string): Promise<void> {
  for (const ch of listChannels()) {
    if (!ch.enabled) continue;
    try {
      await sendAlert(ch.id, text);
    } catch {
      // 单渠道失败不影响整体
    }
  }
}

/**
 * 执行一次基线扫描，按配置决定是否推送违规告警。
 *
 * 每次扫描都会更新违规快照；告警规则：
 *  - onlyOnNew=true（默认）：仅当出现上次快照中不存在的违规键时推送（首扫视为全部新增）
 *  - severityMin（默认 warn）：仅统计达到该级别的违规
 *
 * @returns 供任务历史记录的摘要文本
 */
export async function runBaselineScan(
  config: { severityMin?: string; onlyOnNew?: boolean; notify?: boolean } = {},
): Promise<string> {
  const report = await scanPolicy();
  const ruleMap = new Map(POLICY_RULES.map((r) => [r.id, r]));
  const min = SEVERITY_ORDER[(config.severityMin as ViolationSeverity)] ?? SEVERITY_ORDER.warn;

  // 汇总违规键（containerId:ruleId），并按 severityMin 过滤出"关注级"违规
  const allKeys: string[] = [];
  const relevantKeys: string[] = [];
  const keyLabel = new Map<string, string>();
  for (const row of report.rows) {
    for (const v of row.violations) {
      const key = `${row.containerId}:${v.ruleId}`;
      allKeys.push(key);
      if ((SEVERITY_ORDER[ruleMap.get(v.ruleId)?.severity || 'info'] ?? 0) >= min) {
        relevantKeys.push(key);
        keyLabel.set(key, `${row.containerName}（${ruleMap.get(v.ruleId)?.name || v.ruleId}）`);
      }
    }
  }

  const prev = readSnapshot();
  const prevSet = new Set(prev?.keys || []);
  const onlyOnNew = config.onlyOnNew !== false;
  const newRelevant = relevantKeys.filter((k) => !prevSet.has(k));

  saveSnapshot({ scannedAt: report.scannedAt, keys: allKeys, summary: report.summary });

  const shouldAlert = config.notify !== false && (onlyOnNew ? newRelevant.length > 0 : relevantKeys.length > 0);
  if (shouldAlert) {
    const listKeys = onlyOnNew ? newRelevant : relevantKeys;
    const list = listKeys
      .slice(0, 8)
      .map((k) => `- ${keyLabel.get(k) || k}`)
      .join('\n');
    const head = onlyOnNew
      ? `较上次新增 ${newRelevant.length} 项违规`
      : `关注级违规共 ${relevantKeys.length} 项`;
    const more = listKeys.length > 8 ? `\n- …等共 ${listKeys.length} 项` : '';
    await notifyAllChannels(
      `【安全基线扫描告警】\n扫描容器 ${report.containerCount} 个：danger ${report.summary.danger} / warn ${report.summary.warn} / info ${report.summary.info}\n${head}${listKeys.length ? `：\n${list}${more}` : ''}`,
    );
  }

  return (
    `扫描 ${report.containerCount} 个容器，违规 danger ${report.summary.danger} / warn ${report.summary.warn} / info ${report.summary.info}` +
    (onlyOnNew ? `，新增 ${newRelevant.length} 项` : '')
  );
}

/** 调度器 handler：安全基线定时扫描（config: { severityMin?, onlyOnNew?, notify? }） */
async function runBaselineScanHandler(_task: CronTaskRow, config: Record<string, any>): Promise<TaskRunResult> {
  const detail = await runBaselineScan(config || {});
  return { ok: true, detail };
}

// 注册到调度器（模块加载即注册）

// ==================== 违规在线修复（三期） ====================

/** 修复结果 */
export interface PolicyFixResult {
  ok: boolean;
  message: string;
}

/** 各可修复规则的默认修复参数 */
export const POLICY_FIX_DEFAULTS: Record<string, Record<string, unknown>> = {
  'mem-limit': { memoryBytes: 536870912 },
  'cpu-limit': { cpus: 1 },
  'restart-policy': { policy: 'unless-stopped' },
};

/** 规则是否支持在线自动修复 */
export function isFixableRule(ruleId: string): boolean {
  return ruleId in POLICY_FIX_DEFAULTS;
}

/**
 * 对单个容器执行基线违规在线修复（仅 fixable 规则）
 *
 * 通过 Docker Container Update API 在线生效（无需重建容器）：
 * - mem-limit：设置内存上限（默认 512MB，Docker 引擎最小 6MB）
 * - cpu-limit：设置 CPU 上限（默认 1 核，NanoCpus）
 * - restart-policy：设置重启策略（默认 unless-stopped）
 *
 * 修复后自动复检（重新 inspect + checkContainer），违规仍在则返回 ok=false。
 * 非管理员调用时由路由层走审批门禁（GATE_ACTIONS 'container.fix'）。
 *
 * @throws 规则不可修复(400) / 容器不存在(404) / 参数非法(400)
 */
export async function applyPolicyFix(
  containerId: string,
  ruleId: string,
  params: Record<string, unknown> = {},
): Promise<PolicyFixResult> {
  if (!isFixableRule(ruleId)) {
    throw Object.assign(new Error(`规则 ${ruleId} 不支持自动修复（需重建容器）`), { statusCode: 400 });
  }
  const docker = await getDockerClient();
  const container = docker.getContainer(containerId);
  let inspected: any;
  try {
    inspected = await container.inspect();
  } catch {
    throw Object.assign(new Error('容器不存在或无法访问'), { statusCode: 404 });
  }

  let update: Record<string, unknown> = {};
  let describe = '';
  if (ruleId === 'mem-limit') {
    // Docker 引擎要求内存下限 6MB；未提供参数时默认 512MB。
    // 必须同时设置 MemorySwap（= 2×Memory，与 docker run --memory 的默认语义一致），
    // 否则已设置 memoryswap 的容器会报 409（Memory limit should be smaller than memoryswap）。
    const bytes = Math.max(Number(params.memoryBytes) || 536870912, 6 * 1024 * 1024);
    update = { Memory: Math.round(bytes), MemorySwap: Math.round(bytes) * 2 };
    describe = `已设置内存上限 ${(bytes / 1024 / 1024).toFixed(0)}MB`;
  } else if (ruleId === 'cpu-limit') {
    const cpus = Number(params.cpus) || 1;
    if (cpus <= 0) throw Object.assign(new Error('CPU 上限需为正数'), { statusCode: 400 });
    update = { NanoCpus: Math.round(cpus * 1e9) };
    describe = `已设置 CPU 上限 ${cpus} 核`;
  } else if (ruleId === 'restart-policy') {
    const policy = String(params.policy || 'unless-stopped');
    if (!['no', 'on-failure', 'always', 'unless-stopped'].includes(policy)) {
      throw Object.assign(new Error('不支持的重启策略'), { statusCode: 400 });
    }
    const retry = policy === 'on-failure' ? Math.max(Number(params.maximumRetryCount) || 0, 0) : 0;
    update = { RestartPolicy: { Name: policy, MaximumRetryCount: retry } };
    describe = `重启策略已设置为 ${policy}`;
  }

  await container.update(update);

  // 复检：违规仍在视为修复未生效
  const reInspected = await container.inspect();
  const still = checkContainer(reInspected).find((v) => v.ruleId === ruleId);
  if (still) {
    return { ok: false, message: `修复命令已执行，但复检仍存在违规：${still.detail}` };
  }
  return { ok: true, message: `${describe}，复检通过` };
}
registerTaskHandler('baselineScan', runBaselineScanHandler);
