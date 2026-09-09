/**
 * MCP 工具清单：把面板既有能力（dockerode / 告警 / 计划任务）映射为 MCP tools
 *
 * - 全部工具零第三方依赖，复用现有模块；
 * - handler 统一返回纯文本（LLM 友好），异常折叠为错误文本不抛出；
 * - 每次调用经 logOperation 留痕（用户名固定为 mcp）。
 */
import os from 'os';
import { getDockerClient } from '../docker/client';
import { pullWithFailover } from '../docker/pull';
import { getAlertRules, getAlertRecords } from '../alerting';
import { getDb } from '../storage';
import { dispatchTask } from '../routes/tasks';
import { logOperation } from '../operationLog';

/** MCP 工具描述结构（对齐 MCP tools/list 返回） */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (args: Record<string, any>) => Promise<string>;
}

/** 统一文本输出 */
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

/** 解析容器：支持 id 前缀或名称（/name 归一），找不到返回 null */
async function resolveContainer(docker: any, idOrName: string): Promise<any | null> {
  const list = (await docker.listContainers({ all: true })) as any[];
  const key = String(idOrName || '').trim();
  for (const c of list) {
    if (c.Id.startsWith(key)) return docker.getContainer(c.Id);
    const names = (c.Names || []).map((n: string) => String(n).replace(/^\//, ''));
    if (names.includes(key)) return docker.getContainer(c.Id);
  }
  return null;
}

/** 容器列表行摘要 */
function containerRow(c: any): Record<string, unknown> {
  return {
    id: c.Id,
    name: (c.Names && c.Names[0] ? c.Names[0] : '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created ? new Date(c.Created * 1000).toISOString() : null,
    ports: (c.Ports || []).map((p: any) => `${p.PrivatePort}->${p.PublicPort}/${p.Type}`.replace('->null', '')),
  };
}

/** 统一 JSON 文本输出（体积裁剪） */
function jsonOut(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

export const mcpTools: McpTool[] = [
  {
    name: 'system_snapshot',
    description: 'Get a host system snapshot: CPU cores/load, memory, Docker version and container/image counts.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const docker = await getDockerClient();
      const version = await docker.version();
      const containers = (await docker.listContainers({ all: true })) as any[];
      const images = (await docker.listImages()) as any[];
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      return jsonOut({
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.release()}`,
        cpuCores: os.cpus().length,
        loadavg: os.loadavg().map((n) => Number(n.toFixed(1))),
        memory: {
          totalBytes: totalMem,
          freeBytes: freeMem,
          usedPercent: Number((((totalMem - freeMem) / totalMem) * 100).toFixed(1)),
        },
        dockerVersion: version.Version,
        containers: { total: containers.length, running: containers.filter((c) => c.State === 'running').length },
        imageCount: images.length,
      });
    },
  },
  {
    name: 'containers_list',
    description: 'List Docker containers. Set all=true to include stopped ones; filter is a case-insensitive substring on name/image.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include stopped containers (default true)' },
        filter: { type: 'string', description: 'Optional name/image substring filter' },
      },
    },
    handler: async (args) => {
      const docker = await getDockerClient();
      const list = (await docker.listContainers({ all: args?.all !== false })) as any[];
      const kw = String(args?.filter || '').toLowerCase();
      const rows = list
        .map(containerRow)
        .filter((r) => !kw || String(r.name).toLowerCase().includes(kw) || String(r.image).toLowerCase().includes(kw));
      return jsonOut({ count: rows.length, containers: rows });
    },
  },
  {
    name: 'containers_inspect',
    description: 'Get detailed info of one container (image, state, mounts, ports, env, restart policy).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Container id or name' } }, required: ['id'] },
    handler: async (args) => {
      const docker = await getDockerClient();
      const c = await resolveContainer(docker, String(args?.id || ''));
      if (!c) return '容器不存在: ' + String(args?.id);
      const info = await c.inspect();
      return jsonOut({
        id: info.Id,
        name: info.Name,
        image: info.Config?.Image,
        state: info.State,
        restartPolicy: info.HostConfig?.RestartPolicy,
        ports: info.HostConfig?.PortBindings,
        mounts: (info.Mounts || []).map((m: any) => ({ type: m.Type, source: m.Source, dest: m.Destination })),
        env: info.Config?.Env,
        created: info.Created,
      });
    },
  },
  {
    name: 'containers_logs',
    description: 'Get recent logs of one container (stdout+stderr merged, newest at end).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Container id or name' },
        tail: { type: 'number', description: 'Number of lines from the end (default 200, max 2000)' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const docker = await getDockerClient();
      const c = await resolveContainer(docker, String(args?.id || ''));
      if (!c) return '容器不存在: ' + String(args?.id);
      const tail = Math.min(Math.max(Number(args?.tail) || 200, 1), 2000);
      const buf = await c.logs({ tail, stdout: true, stderr: true, follow: false, timestamps: false });
      return (Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)).slice(-200000);
    },
  },
  {
    name: 'containers_start',
    description: 'Start a stopped container.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Container id or name' } }, required: ['id'] },
    handler: (args) => simpleContainerAction(args, 'start'),
  },
  {
    name: 'containers_stop',
    description: 'Stop a running container gracefully.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, timeout: { type: 'number', description: 'Grace period seconds (default 10)' } },
      required: ['id'],
    },
    handler: async (args) => {
      const docker = await getDockerClient();
      const c = await resolveContainer(docker, String(args?.id || ''));
      if (!c) return '容器不存在: ' + String(args?.id);
      await c.stop({ t: Number(args?.timeout) || 10 });
      logMcp('containers_stop', args);
      return '已停止 ' + String(args?.id);
    },
  },
  {
    name: 'containers_restart',
    description: 'Restart a container.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: (args) => simpleContainerAction(args, 'restart'),
  },
  {
    name: 'containers_kill',
    description: 'Force kill a container (SIGKILL).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args) => {
      const docker = await getDockerClient();
      const c = await resolveContainer(docker, String(args?.id || ''));
      if (!c) return '容器不存在: ' + String(args?.id);
      await c.kill();
      logMcp('containers_kill', args);
      return '已强制终止 ' + String(args?.id);
    },
  },
  {
    name: 'containers_remove',
    description: 'Remove a container. Destructive: set force=true to remove a running container.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, force: { type: 'boolean', description: 'Remove running container (default false)' } },
      required: ['id'],
    },
    handler: async (args) => {
      const docker = await getDockerClient();
      const c = await resolveContainer(docker, String(args?.id || ''));
      if (!c) return '容器不存在: ' + String(args?.id);
      await c.remove({ force: args?.force === true });
      logMcp('containers_remove', args);
      return '已删除 ' + String(args?.id);
    },
  },
  {
    name: 'images_list',
    description: 'List Docker images with repo tags and sizes.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const docker = await getDockerClient();
      const list = (await docker.listImages()) as any[];
      return jsonOut({
        count: list.length,
        images: list.map((i) => ({
          id: i.Id,
          repo: (i.RepoTags || ['<none>'])[0],
          sizeMB: Number((i.Size / 1048576).toFixed(1)),
          created: i.Created ? new Date(i.Created * 1000).toISOString() : null,
        })),
      });
    },
  },
  {
    name: 'images_pull',
    description: 'Pull an image from the registry (e.g. nginx:latest).',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'Image reference, e.g. nginx:1.27' } }, required: ['ref'] },
    handler: async (args) => {
      const ref = String(args?.ref || '').trim();
      if (!ref) return '缺少镜像引用';
      const docker = await getDockerClient();
      const pulled = await pullWithFailover(docker, ref);
      logMcp('images_pull', args);
      return '已拉取 ' + pulled.ref;
    },
  },
  {
    name: 'images_remove',
    description: 'Remove an image by id or repo tag. Destructive.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args) => {
      const docker = await getDockerClient();
      await docker.getImage(String(args?.id || '')).remove({ force: false });
      logMcp('images_remove', args);
      return '已删除镜像 ' + String(args?.id);
    },
  },
  {
    name: 'volumes_list',
    description: 'List Docker volumes with drivers and mount points.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const docker = await getDockerClient();
      const res = await docker.listVolumes();
      return jsonOut({
        count: (res.Volumes || []).length,
        volumes: (res.Volumes || []).map((v: any) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint })),
      });
    },
  },
  {
    name: 'networks_list',
    description: 'List Docker networks.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const docker = await getDockerClient();
      const list = (await docker.listNetworks()) as any[];
      return jsonOut({
        count: list.length,
        networks: list.map((n) => ({ id: n.Id, name: n.Name, driver: n.Driver, scope: n.Scope })),
      });
    },
  },
  {
    name: 'alerts_rules_list',
    description: 'List all alert rules (host resources, container resources anomaly, container watches) with enabled state and thresholds.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const host = getAlertRules();
      const d = getDb();
      const ctn = d.prepare('SELECT id, container_id, watch_type, enabled, warn_threshold, danger_threshold FROM container_alert_rules').all();
      return jsonOut({ hostRules: host, containerRules: ctn });
    },
  },
  {
    name: 'alerts_records_list',
    description: 'List recent alert records, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max records (default 20, max 100)' },
        level: { type: 'string', description: 'Filter by level: warn | danger | recovery' },
        type: { type: 'string', description: 'Filter by type, e.g. cpu / mem / ctnRes / exited' },
      },
    },
    handler: async (args) => {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
      const res = getAlertRecords({ page: 1, pageSize: limit, level: args?.level || undefined, type: args?.type || undefined });
      return jsonOut({ total: res.total, records: res.records });
    },
  },
  {
    name: 'tasks_list',
    description: 'List scheduled cron tasks with schedule and last run status.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const rows = getDb()
        .prepare('SELECT id, name, type, cron, enabled, last_status, last_run_at, next_run_at FROM cron_tasks ORDER BY created_at DESC')
        .all();
      return jsonOut({ count: rows.length, tasks: rows });
    },
  },
  {
    name: 'tasks_run',
    description: 'Trigger a scheduled task to run immediately by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Task id (see tasks_list)' } }, required: ['id'] },
    handler: async (args) => {
      const result = await dispatchTask(String(args?.id || ''));
      logMcp('tasks_run', args);
      return jsonOut(result || { ok: false });
    },
  },
];

/** 单动作容器操作（start/restart） */
async function simpleContainerAction(args: Record<string, any>, action: 'start' | 'restart'): Promise<string> {
  const docker = await getDockerClient();
  const c = await resolveContainer(docker, String(args?.id || ''));
  if (!c) return '容器不存在: ' + String(args?.id);
  await c[action]();
  logMcp(`containers_${action}`, args);
  return `${action === 'start' ? '已启动' : '已重启'} ${String(args?.id)}`;
}

/** MCP 工具调用留痕 */
function logMcp(tool: string, args: Record<string, unknown>): void {
  logOperation('mcp', 'MCP 工具调用', 'mcp', tool, JSON.stringify(args || {}).slice(0, 200), true);
}
