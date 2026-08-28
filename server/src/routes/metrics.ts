/**
 * Prometheus 指标暴露路由（挂载于顶层 /metrics，非 /api 前缀）
 *
 * 以 Prometheus 文本格式输出面板所在 Docker 引擎与各容器的基础指标，
 * 命名遵循项目 dm_ 前缀族。供 Prometheus 抓取器拉取，配套可导入的
 * Grafana Dashboard 由 GET /api/system/grafana-dashboard 导出。
 *
 * 鉴权：默认开放本机抓取；若在设置中心配置了 metrics.token（secret 类型），
 * 则要求请求携带 ?token= 或 Authorization: Bearer <token>，否则 401。
 *
 * 指标清单：
 * - dm_up                          面板后端存活
 * - dm_engine_info                 引擎信息（版本/OS/架构）
 * - dm_engine_cpu_count            引擎 CPU 逻辑核数
 * - dm_engine_mem_total_bytes      引擎内存总量
 * - dm_engine_containers{state}    按状态统计的容器数
 * - dm_container_cpu_percent       容器 CPU 使用率（%）
 * - dm_container_mem_usage_bytes   容器内存使用（字节）
 * - dm_container_mem_limit_bytes   容器内存上限（字节）
 * - dm_container_mem_percent       容器内存使用率（%）
 * - dm_container_pids              容器进程数
 * - dm_container_network_rx_bytes_total / tx  容器网络累计收发字节
 */
import { Router, Request, Response } from 'express';
import { getDockerClient } from '../docker/client';
import { parseStats } from '../docker/stats';
import { getSetting } from '../settings';

const router = Router();

/**
 * Prometheus 文本转义（label 值中的特殊字符）
 * @param v 原始字符串
 */
export function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 行构造器：自动追加换行 */
class TextBuilder {
  private buf = '';
  /** 追加一行 */
  line(s: string): void {
    this.buf += s + '\n';
  }
  /** 输出 HELP/TYPE 与样本行 */
  metric(name: string, type: 'gauge' | 'counter', help: string, samples: Array<{ labels?: Record<string, string | number>; value: number | string }>): void {
    this.line(`# HELP ${name} ${help}`);
    this.line(`# TYPE ${name} ${type}`);
    for (const s of samples) {
      const labelStr = s.labels
        ? `{${Object.entries(s.labels)
            .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`)
            .join(',')}}`
        : '';
      this.line(`${name}${labelStr} ${s.value}`);
    }
  }
  toString(): string {
    return this.buf;
  }
}

/**
 * 校验抓取请求的 token（metrics.token 未配置时放行）
 * @param req 请求
 * @returns 校验通过返回 true
 */
function authOk(req: Request): boolean {
  const token = getSetting<string>('metrics.token');
  if (!token) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const query = String(req.query.token || '');
  return bearer === token || query === token;
}

/**
 * GET /metrics
 * 输出 Prometheus 文本格式指标
 */
router.get('/', async (req: Request, res: Response) => {
  if (!authOk(req)) {
    res.status(401).type('text/plain').send('Unauthorized: metrics token required');
    return;
  }

  const out = new TextBuilder();
  const docker = await getDockerClient();

  // 引擎层信息（info 失败时引擎层指标留空，容器层继续尝试）
  let versionInfo: any = null;
  let engineInfo: any = null;
  try {
    versionInfo = await docker.version();
    engineInfo = await docker.info();
  } catch {
    // 引擎不可达：输出 up=0 并结束
  }

  out.metric('dm_up', 'gauge', 'Docker Manager 面板后端是否存活', [{ value: 1 }]);

  if (versionInfo && engineInfo) {
    out.metric('dm_engine_info', 'gauge', 'Docker 引擎信息', [
      {
        labels: { version: versionInfo.Version, api: versionInfo.ApiVersion, os: engineInfo.OperatingSystem, arch: engineInfo.Architecture },
        value: 1,
      },
    ]);
    out.metric('dm_engine_cpu_count', 'gauge', '引擎 CPU 逻辑核数', [{ value: Number(engineInfo.NCPU) || 0 }]);
    out.metric('dm_engine_mem_total_bytes', 'gauge', '引擎内存总量（字节）', [{ value: Number(engineInfo.MemTotal) || 0 }]);
  }

  // 容器层：仅统计运行中容器（与监控采集口径一致）
  const containers = (await docker.listContainers().catch(() => [])) as any[];
  const byState = new Map<string, number>();
  for (const c of containers) {
    byState.set(c.State, (byState.get(c.State) || 0) + 1);
  }
  out.metric(
    'dm_engine_containers',
    'gauge',
    '按状态统计的容器数量',
    [...byState.entries()].map(([state, n]) => ({ labels: { state }, value: n })),
  );

  // 并行抓取各容器 stats，单个失败跳过
  const running = containers.filter((c) => c.State === 'running');
  const statResults = await Promise.all(
    running.map(async (c) => {
      try {
        const stats = await docker.getContainer(c.Id).stats({ stream: false });
        return { c, parsed: parseStats(stats) };
      } catch {
        return null;
      }
    }),
  );

  const cpuSamples: Array<{ labels: Record<string, string>; value: number }> = [];
  const memUsageSamples: Array<{ labels: Record<string, string>; value: number }> = [];
  const memLimitSamples: Array<{ labels: Record<string, string>; value: number }> = [];
  const memPctSamples: Array<{ labels: Record<string, string>; value: number }> = [];
  const pidsSamples: Array<{ labels: Record<string, string>; value: number }> = [];
  const rxSamples: Array<{ labels: Record<string, string>; value: number }> = [];
  const txSamples: Array<{ labels: Record<string, string>; value: number }> = [];

  for (const r of statResults) {
    if (!r) continue;
    const name = (r.c.Names?.[0] || '').replace(/^\//, '') || r.c.Id.slice(0, 12);
    const labels = { container: name, image: r.c.Image || '' };
    cpuSamples.push({ labels, value: r.parsed.cpuPercent });
    memUsageSamples.push({ labels, value: r.parsed.memory.usage });
    memLimitSamples.push({ labels, value: r.parsed.memory.limit });
    memPctSamples.push({ labels, value: r.parsed.memory.percent });
    pidsSamples.push({ labels, value: r.parsed.pids });
    rxSamples.push({ labels, value: r.parsed.network.rx });
    txSamples.push({ labels, value: r.parsed.network.tx });
  }

  out.metric('dm_container_cpu_percent', 'gauge', '容器 CPU 使用率（%，按核数归一化）', cpuSamples);
  out.metric('dm_container_mem_usage_bytes', 'gauge', '容器内存使用（字节）', memUsageSamples);
  out.metric('dm_container_mem_limit_bytes', 'gauge', '容器内存上限（字节）', memLimitSamples);
  out.metric('dm_container_mem_percent', 'gauge', '容器内存使用率（%）', memPctSamples);
  out.metric('dm_container_pids', 'gauge', '容器内进程数', pidsSamples);
  out.metric('dm_container_network_rx_bytes_total', 'counter', '容器网络累计接收字节', rxSamples);
  out.metric('dm_container_network_tx_bytes_total', 'counter', '容器网络累计发送字节', txSamples);

  res.type('text/plain; version=0.0.4; charset=utf-8').send(out.toString());
});

export default router;
