/**
 * SSH 引擎接入（1.93.0）
 *
 * 通过 SSH 通道访问远程 Docker 引擎：本地起一个仅绑定回环地址的 TCP bridge，
 * dockerode 的每个请求经 bridge 转发到 SSH 通道内的远程管道命令
 * （socat - UNIX-CONNECT:/var/run/docker.sock，回退 nc -U），
 * 实现零暴露端口、免 TLS 的远程 Docker 管理。
 *
 * 端点格式：ssh://user@host:port（user 缺省 root，port 缺省 22）
 * 凭证（password 或 privateKey + passphrase）由 engines 路由加密存储于 docker_engines.cred_encrypted
 */
import net from 'net';
import { Client as SshClient } from 'ssh2';
import Dockerode from 'dockerode';
import { getDb, decryptSecret } from '../storage';

/** 默认远程 docker socket 路径 */
const DEFAULT_DOCKER_SOCK = '/var/run/docker.sock';

/** SSH 凭证 */
export interface SshCredential {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** 解析 ssh://user@host:port 端点 */
export interface SshEndpointParts {
  user: string;
  host: string;
  port: number;
}

/**
 * 解析 ssh://user@host:port 端点（user 缺省 root，port 缺省 22）
 * @param endpoint ssh:// 开头的端点字符串
 */
export function parseSshEndpoint(endpoint: string): SshEndpointParts {
  const m = /^ssh:\/\/(?:([^/@]+)@)?([^/@:]+)(?::(\d+))?\/?$/i.exec(String(endpoint || '').trim());
  if (!m) {
    throw Object.assign(new Error('SSH 端点格式非法，应为 ssh://user@host:port'), { statusCode: 400 });
  }
  return { user: m[1] || 'root', host: m[2], port: Number(m[3] || 22) };
}

/**
 * 判断端点是否为 SSH 引擎
 */
export function isSshEndpoint(endpoint: string | null | undefined): boolean {
  return String(endpoint || '').trim().toLowerCase().startsWith('ssh://');
}

/** SSH 连接 + 本地 bridge 的缓存条目 */
interface SshBridge {
  endpoint: string;
  conn: SshClient;
  server: net.Server;
  port: number;
  /** 远端管道命令（首连时探测），如 socat - UNIX-CONNECT:/var/run/docker.sock */
  pipeCmd: string;
  ready: Promise<void>;
}

const bridges = new Map<string, SshBridge>();

/**
 * 获取（或复用）某 SSH 端点的 bridge，等待 SSH 就绪后返回绑定本地端口的 dockerode 实例
 * @param endpoint ssh://user@host:port
 * @param cred SSH 凭证（password 或 privateKey + passphrase）
 */
export async function getSshDocker(endpoint: string, cred?: SshCredential): Promise<Dockerode> {
  let bridge = bridges.get(endpoint);
  if (!bridge) {
    bridge = startBridge(endpoint, cred);
    bridges.set(endpoint, bridge);
  }
  await bridge.ready;
  return new Dockerode({ host: '127.0.0.1', port: bridge.port, protocol: 'http' });
}

/**
 * 探测远程可用的管道命令：优先 socat，回退 nc -U
 * @param conn 已就绪的 SSH 连接
 */
async function probePipeCmd(conn: SshClient): Promise<string> {
  const has = (cmd: string) =>
    new Promise<boolean>((resolve) => {
      try {
        conn.exec(`command -v ${cmd}`, (err, stream) => {
          if (err) return resolve(false);
          let out = '';
          stream.on('data', (c: Buffer) => (out += c.toString()));
          stream.stderr?.on('data', () => {});
          stream.on('close', () => resolve(out.trim().length > 0));
        });
      } catch {
        resolve(false);
      }
    });
  if (await has('socat')) return `socat - UNIX-CONNECT:${DEFAULT_DOCKER_SOCK}`;
  if (await has('nc')) return `nc -U ${DEFAULT_DOCKER_SOCK}`;
  throw Object.assign(
    new Error(`远程主机缺少 socat 或 nc（用于转发 ${DEFAULT_DOCKER_SOCK}），请先在远程主机安装 socat`),
    { statusCode: 400 },
  );
}

/** 启动某 SSH 端点的 bridge（连接 + 本地回环 TCP 服务） */
function startBridge(endpoint: string, cred?: SshCredential): SshBridge {
  const parts = parseSshEndpoint(endpoint);
  const conn = new SshClient();
  const server = net.createServer((socket) => {
    // 每个本地连接对应一条 SSH 通道：exec 远端管道命令后双向对接
    conn.exec(bridge.pipeCmd, (err, stream) => {
      if (err) {
        socket.destroy();
        return;
      }
      socket.pipe(stream);
      stream.pipe(socket);
      socket.on('error', () => stream.end());
      stream.on('error', () => socket.destroy());
      stream.on('close', () => socket.destroy());
      socket.on('close', () => stream.end());
    });
  });
  const bridge = { endpoint, conn, server, port: 0, pipeCmd: '', ready: Promise.resolve() } as SshBridge;
  bridge.ready = new Promise<void>((resolve, reject) => {
    server.on('error', (e) => reject(e));
    server.listen(0, '127.0.0.1', () => {
      bridge.port = (server.address() as net.AddressInfo).port;
      connectSsh(conn, parts, cred)
        .then(async () => {
          bridge.pipeCmd = await probePipeCmd(conn);
          resolve();
        })
        .catch((e) => {
          server.close();
          reject(e);
        });
    });
  });
  return bridge;
}

/** 建立 SSH 连接（Promise 包装） */
function connectSsh(conn: SshClient, parts: SshEndpointParts, cred?: SshCredential): Promise<void> {
  return new Promise((resolve, reject) => {
    conn
      .on('ready', () => resolve())
      .on('error', (err) => reject(err))
      .connect({
        host: parts.host,
        port: parts.port,
        username: parts.user,
        password: cred?.password,
        privateKey: cred?.privateKey ? normalizePrivateKey(cred.privateKey) : undefined,
        passphrase: cred?.passphrase,
        tryKeyboard: false,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
      });
  });
}

/**
 * 测试 SSH 端点连通性：建立连接并执行 `true`
 * @param endpoint ssh:// 端点
 * @param cred SSH 凭证
 */
export function testSshEndpoint(endpoint: string, cred?: SshCredential): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let parts: SshEndpointParts;
    try {
      parts = parseSshEndpoint(endpoint);
    } catch (e: any) {
      return resolve({ ok: false, error: e?.message || 'SSH 端点格式非法' });
    }
    const conn = new SshClient();
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        // 忽略
      }
      resolve({ ok, error });
    };
    const timer = setTimeout(() => finish(false, 'SSH 连接超时（15 秒）'), 15000);
    conn
      .on('ready', () => {
        conn.exec('true', (err) => finish(!err, err?.message));
      })
      .on('error', (err) => finish(false, err?.message || 'SSH 连接失败'))
      .connect({
        host: parts.host,
        port: parts.port,
        username: parts.user,
        password: cred?.password,
        privateKey: cred?.privateKey ? normalizePrivateKey(cred.privateKey) : undefined,
        passphrase: cred?.passphrase,
        tryKeyboard: false,
        readyTimeout: 15000,
      });
  });
}

/** 兼容 \r\n 与剪贴板空白残留的私钥清理 */
function normalizePrivateKey(key: string): string {
  return key.replace(/\r\n/g, '\n');
}

/** 关闭指定端点的 SSH bridge */
export function closeSshBridge(endpoint: string): void {
  const b = bridges.get(endpoint);
  if (!b) return;
  bridges.delete(endpoint);
  try {
    b.server.close();
  } catch {
    // 忽略
  }
  try {
    b.conn.end();
  } catch {
    // 忽略
  }
}

/** 关闭全部 SSH bridge（引擎删除/切换时调用） */
export function closeAllSshBridges(): void {
  for (const endpoint of Array.from(bridges.keys())) closeSshBridge(endpoint);
}

/**
 * 读取某引擎端点存储的 SSH 凭证（cred_encrypted 列，解密后 JSON）
 * @param endpoint ssh:// 端点
 */
export function loadEngineCredential(endpoint: string): SshCredential | undefined {
  try {
    const row = getDb()
      .prepare('SELECT cred_encrypted FROM docker_engines WHERE endpoint = ?')
      .get(endpoint) as { cred_encrypted: string | null } | undefined;
    if (!row?.cred_encrypted) return undefined;
    const raw = decryptSecret(row.cred_encrypted);
    return raw ? (JSON.parse(raw) as SshCredential) : undefined;
  } catch {
    return undefined;
  }
}
