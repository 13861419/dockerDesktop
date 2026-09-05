/**
 * Prometheus 指标暴露（1.21.0）
 *
 * GET /metrics —— Prometheus 文本格式（v0.0.4）。
 * 通过 prometheus.enabled 设置开关（默认关闭）；可选 PROMETHEUS_TOKEN 环境变量，
 * 配置后请求需携带 Authorization: Bearer <token> 或 ?token=<token>。
 *
 * 指标：
 *   dockermanager_host_cpu_percent / mem_percent / disk_percent
 *   dockermanager_k8s_node_cpu_cores / mem_bytes（k8s 可用时）
 */
import { getDb } from './storage';

/** Prometheus 转义（label 值） */
function escapeLabel(v: string): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 构造 /metrics 文本 */
export function buildPrometheusText(): string {
  const out: string[] = [];
  const d = getDb();

  // 最新一条 host 指标
  try {
    const host = d.prepare('SELECT * FROM host_metrics ORDER BY id DESC LIMIT 1').get() as any;
    if (host) {
      out.push('# HELP dockermanager_host_cpu_percent Host CPU usage percent');
      out.push('# TYPE dockermanager_host_cpu_percent gauge');
      out.push(`dockermanager_host_cpu_percent ${(host.cpu_percent ?? 0).toFixed(2)}`);
      out.push('# HELP dockermanager_host_mem_percent Host memory usage percent');
      out.push('# TYPE dockermanager_host_mem_percent gauge');
      out.push(`dockermanager_host_mem_percent ${(host.mem_percent ?? 0).toFixed(2)}`);
      out.push('# HELP dockermanager_host_disk_percent Host disk usage percent');
      out.push('# TYPE dockermanager_host_disk_percent gauge');
      out.push(`dockermanager_host_disk_percent ${(host.disk_percent ?? 0).toFixed(2)}`);
    }
  } catch {
    /* host 指标缺失不影响其余指标 */
  }

  // K8s 节点最新指标
  try {
    const nodes = d
      .prepare(
        `SELECT m.node, m.cpu_cores, m.mem_bytes FROM k8s_metrics m
         JOIN (SELECT node, max(ts) AS maxts FROM k8s_metrics GROUP BY node) latest
         ON m.node = latest.node AND m.ts = latest.maxts`,
      )
      .all() as any[];
    if (nodes.length) {
      out.push('# HELP dockermanager_k8s_node_cpu_cores K8s node CPU usage (cores)');
      out.push('# TYPE dockermanager_k8s_node_cpu_cores gauge');
      out.push('# HELP dockermanager_k8s_node_mem_bytes K8s node memory usage (bytes)');
      out.push('# TYPE dockermanager_k8s_node_mem_bytes gauge');
      for (const n of nodes) {
        out.push(`dockermanager_k8s_node_cpu_cores{node="${escapeLabel(n.node)}"} ${(n.cpu_cores ?? 0).toFixed(4)}`);
        out.push(`dockermanager_k8s_node_mem_bytes{node="${escapeLabel(n.node)}"} ${Math.round(n.mem_bytes ?? 0)}`);
      }
    }
  } catch {
    /* ignore */
  }

  return out.join('\n') + '\n';
}
