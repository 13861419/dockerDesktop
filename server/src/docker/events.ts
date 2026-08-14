/**
 * Docker 引擎事件采集服务
 *
 * 通过 dockerode 的 getEvents 持续监听 Docker 引擎的实时事件流，
 * 并在内存中维护一个环形缓冲（默认最多保留 recentMax 条），供 REST 接口查询最近事件，
 * 同时向注册的订阅者（WebSocket）实时推送新事件。
 *
 * 说明：Docker 事件本身不持久化存储，本服务用内存缓存最近事件，服务重启后缓存清空。
 */
import { EventEmitter } from 'events';
import { getDockerClient } from './client';
import { getDb } from '../storage';

/** 单个 Docker 事件（标准化后的结构，供前端消费） */
export interface DockerEvent {
  /** 事件产生时间（毫秒时间戳） */
  time: number;
  /** 事件类型：container / image / volume / network / plugin / daemon 等 */
  type: string;
  /** 动作：start / stop / destroy / pull / create 等 */
  action: string;
  /** 事件主体标识（如容器 id / 镜像名 / 卷名 / 网络名） */
  id: string;
  /** 事件来源（engine） */
  scope: string;
  /** 附加过滤属性（如容器镜像名） */
  attributes?: Record<string, string>;
  /** 原始事件 */
  raw: any;
}

/** 内存环形缓冲容量上限（保留最近 N 条事件） */
const RECENT_MAX = 200;
/** 重连等待时间（毫秒） */
const RECONNECT_DELAY = 5000;

/** 事件落库批量 flush 间隔（毫秒） */
const FLUSH_INTERVAL = 2000;
/** 单批落库条数阈值（达到即提前 flush） */
const FLUSH_BATCH = 100;
/** 持久化保留的事件最大条数（超出删除最旧，防止无限增长） */
const PERSIST_MAX = 50000;

/** 最近事件环形缓冲（cap 最大 RECENT_MAX 条，尾部追加） */
const recentEvents: DockerEvent[] = [];
/** 实时事件订阅者集合（WebSocket 连接通过 onEvent 注册） */
const subscribers = new Set<(ev: DockerEvent) => void>();
/** 事件采集器运行标志 */
let started = false;
/** 事件采集器内部模拟 http.Server 监听开关 */
let listening = false;
/** 当前活动的事件流（用于切换引擎时主动断开以触发基于新引擎的重连） */
let activeStream: { destroy(): void } | null = null;

/** 待落库事件缓冲（攒批批量写入 SQLite，减少高频写压力） */
const persistBuffer: DockerEvent[] = [];
/** 落库定时器句柄 */
let flushTimer: NodeJS.Timeout | null = null;

/** 用于在切换引擎/重启时通知订阅者重置缓存的事件 */
export const eventBus = new EventEmitter();
/** 缓存被清空时触发 */
eventBus.setMaxListeners(0);

/**
 * 推入一条最近事件到环形缓冲
 * @param ev 标准化事件
 */
function pushRecent(ev: DockerEvent): void {
  recentEvents.push(ev);
  if (recentEvents.length > RECENT_MAX) {
    recentEvents.shift();
  }
}

/**
 * 标准化 dockerode getEvents 返回的原始事件对象
 * @param raw dockerode 事件
 * @returns 标准化事件
 */
function normalize(raw: any): DockerEvent {
  return {
    time: Number(raw.time || raw.timeNano || Date.now()) * (raw.timeNano ? 1 : 1000),
    type: raw.Type || 'unknown',
    action: raw.Action || '',
    id: raw.Actor?.ID || raw.id || '',
    scope: raw.scope || 'local',
    attributes: raw.Actor?.Attributes || raw.attributes || {},
    raw,
  };
}

/**
 * 获取最近的事件列表（倒序返回，最新的在前）
 * @param limit 数量限制
 * @returns 事件数组
 */
export function getRecentEvents(limit: number = 100): DockerEvent[] {
  const n = Math.min(limit, recentEvents.length);
  return recentEvents.slice(-n).reverse();
}

/**
 * 注册事件订阅者，返回取消订阅函数
 * @param cb 新事件回调
 * @returns 取消订阅函数
 */
export function onNewEvent(cb: (ev: DockerEvent) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * 向所有订阅者广播新事件
 * @param ev 事件
 */
function broadcast(ev: DockerEvent): void {
  for (const cb of subscribers) {
    try {
      cb(ev);
    } catch {
      // 单个订阅者出错不影响其他订阅者
    }
  }
}

/**
 * 将一条事件加入落库缓冲队列
 * @param ev 标准化事件
 */
function queuePersist(ev: DockerEvent): void {
  persistBuffer.push(ev);
  // 达到批量阈值立即落库
  if (persistBuffer.length >= FLUSH_BATCH) {
    flushPersist();
  }
}

/**
 * 批量将缓冲事件写入 SQLite（单事务），并做保留上限清理
 */
function flushPersist(): void {
  if (persistBuffer.length === 0) return;
  const batch = persistBuffer.splice(0, persistBuffer.length);
  try {
    const d = getDb();
    const ins = d.prepare(
      'INSERT INTO docker_events (time, type, action, entity_id, scope, attributes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    d.exec('BEGIN');
    const now = Math.floor(Date.now() / 1000);
    for (const ev of batch) {
      ins.run(
        Number(ev.time) || Date.now(),
        ev.type || '',
        ev.action || '',
        ev.id || '',
        ev.scope || 'local',
        JSON.stringify(ev.attributes || {}),
        now,
      );
    }
    d.exec('COMMIT');
  } catch {
    try {
      getDb().exec('ROLLBACK');
    } catch {
      // 无活动事务时忽略
    }
  }
  // 清理超出保留上限的最旧事件（POST-COMMIT 单独执行，避免与插入争用锁）
  try {
    getDb()
      .prepare(
        'DELETE FROM docker_events WHERE id NOT IN (SELECT id FROM docker_events ORDER BY id DESC LIMIT ?)',
      )
      .run(PERSIST_MAX);
  } catch {
    // 清理失败不影响事件写入
  }
}

/**
 * 启动落库定时器（幂等，随事件采集器一同启动）
 */
function startPersistFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushPersist, FLUSH_INTERVAL);
  flushTimer.unref?.();
}

/**
 * 查询持久化事件历史（倒序，支持类型/动作过滤 + 分页）
 * @param opts 查询参数
 * @param opts.type 事件类型过滤
 * @param opts.action 动作过滤
 * @param opts.limit 条数（默认 100，最大 500）
  * @param opts.offset 偏移
  * @returns 事件数组（不含 raw，仅含可序列化字段）
  */
export function queryPersistedEvents(opts: {
  type?: string;
  action?: string;
  limit?: number;
  offset?: number;
}): Array<Omit<DockerEvent, 'raw'>> {
  const limit = Math.min(Number(opts.limit) || 100, 500);
  const offset = Number(opts.offset) || 0;
  const where: string[] = [];
  const params: any[] = [];
  if (opts.type) {
    where.push('type = ?');
    params.push(opts.type);
  }
  if (opts.action) {
    where.push('action = ?');
    params.push(opts.action);
  }
  const sql = `SELECT time, type, action, entity_id, scope, attributes FROM docker_events ${
    where.length ? 'WHERE ' + where.join(' AND ') : ''
  } ORDER BY id DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const rows = getDb().prepare(sql).all(...params) as Array<{
    time: number;
    type: string;
    action: string;
    entity_id: string;
    scope: string;
    attributes: string;
  }>;
  return rows.map((r) => {
    let attrs: Record<string, string> = {};
    try {
      attrs = JSON.parse(r.attributes || '{}');
    } catch {
      // 解析失败保持空对象
    }
    return {
      time: r.time,
      type: r.type,
      action: r.action,
      id: r.entity_id,
      scope: r.scope,
      attributes: attrs,
    };
  });
}

/** 持久化历史中的可用类型（供筛选项下拉统计） */
export function persistedEventTypes(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT type FROM docker_events WHERE type != ? ORDER BY type')
    .all('') as Array<{ type: string }>;
  return rows.map((r) => r.type);
}

/** 持久化历史中的可用动作（供筛选项下拉统计） */
export function persistedEventActions(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT action FROM docker_events WHERE action != ? ORDER BY action')
    .all('') as Array<{ action: string }>;
  return rows.map((r) => r.action);
}

/** 删除全部持久化事件历史（清空） */
export function clearPersistedEvents(): void {
  getDb().prepare('DELETE FROM docker_events').run();
}

/**
 * 启动 Docker 事件监听器（幂等）。
 * 持续监听事件流，断线自动重连。
 */
export function startEventMonitor(): void {
  if (started) return;
  started = true;
  // 启动事件落库定时器（幂等）
  startPersistFlusher();

  const listen = async () => {
    if (listening) return;
    listening = true;
    try {
      const docker = await getDockerClient();
      const stream = await docker.getEvents();
      listening = false;
      activeStream = stream as unknown as { destroy(): void };

      stream.on('data', (chunk: Buffer) => {
        try {
          const line = chunk.toString('utf8').trim();
          if (!line) return;
          const parsed = JSON.parse(line);
          const ev = normalize(parsed);
          pushRecent(ev);
          queuePersist(ev);
          broadcast(ev);
        } catch {
          // 忽略无法解析的行
        }
      });
      stream.on('end', () => {
        listening = false;
        scheduleReconnect();
      });
      stream.on('error', () => {
        listening = false;
        scheduleReconnect();
      });
      console.log('[events] Docker 事件监听已启动');
    } catch (err) {
      listening = false;
      console.error('[events] 事件监听启动失败:', err instanceof Error ? err.message : err);
      scheduleReconnect();
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const scheduleReconnect = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      listen();
    }, RECONNECT_DELAY);
  };

  // 首启
  setTimeout(listen, 200);
}

/**
 * 重启事件监听器（用于切换 Docker 引擎后让事件流对准新引擎）
 *
 * 主动销毁当前活动事件流，其 end/error 回调会自动触发基于最新"当前引擎"的重连。
 * 事件流的环形缓冲不清空（历史事件保留）。
 */
export function restartEventMonitor(): void {
  if (activeStream) {
    try {
      activeStream.destroy();
    } catch {
      // 忽略销毁异常
    }
    activeStream = null;
  }
}
