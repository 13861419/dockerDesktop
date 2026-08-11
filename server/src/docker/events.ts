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

/** 最近事件环形缓冲（cap 最大 RECENT_MAX 条，尾部追加） */
const recentEvents: DockerEvent[] = [];
/** 实时事件订阅者集合（WebSocket 连接通过 onEvent 注册） */
const subscribers = new Set<(ev: DockerEvent) => void>();
/** 事件采集器运行标志 */
let started = false;
/** 事件采集器内部模拟 http.Server 监听开关 */
let listening = false;

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
 * 启动 Docker 事件监听器（幂等）。
 * 持续监听事件流，断线自动重连。
 */
export function startEventMonitor(): void {
  if (started) return;
  started = true;

  const listen = async () => {
    if (listening) return;
    listening = true;
    try {
      const docker = await getDockerClient();
      const stream = await docker.getEvents();
      listening = false;

      stream.on('data', (chunk: Buffer) => {
        try {
          const line = chunk.toString('utf8').trim();
          if (!line) return;
          const parsed = JSON.parse(line);
          const ev = normalize(parsed);
          pushRecent(ev);
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
