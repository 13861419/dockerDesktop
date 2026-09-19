#!/usr/bin/env node
/**
 * DockerManager Edge Agent（1.86.0）
 *
 * 零依赖单文件 agent：部署在远程主机上，主动反向连接面板，
 * 把面板下发的 Docker Engine HTTP 请求透传给本机 Docker daemon。
 *
 * 用法（环境变量）：
 *   PANEL_URL  面板地址，如 http://panel.example.com:9528
 *   EDGE_TOKEN 面板 Edge 节点 token（创建节点时返回）
 *   DOCKER_SOCK 可选，默认 /var/run/docker.sock（Windows 自动用命名管道）
 *   EDGE_AUTO_UPGRADE 可选，默认开启（设为 0 关闭）：连接面板后版本落后则自动自升级
 *   EDGE_RESTART 可选，默认 systemd（退出交给服务管理器拉起）；设为 spawn 时自拉起新进程再退出，
 *                适合 nohup 等无服务管理器场景
 *
 * 要求 Node.js >= 22（使用内置 WebSocket 客户端）。
 */
'use strict';

const PANEL_URL = (process.env.PANEL_URL || '').replace(/\/+$/, '');
const EDGE_TOKEN = process.env.EDGE_TOKEN || '';
const AGENT_VERSION = '1.86.0';

if (!PANEL_URL || !EDGE_TOKEN) {
  console.error('[edge-agent] 缺少环境变量：PANEL_URL / EDGE_TOKEN');
  process.exit(1);
}

/** 本机 Docker socket（Linux/macOS unix socket；Windows 命名管道） */
const DOCKER_SOCKET =
  process.env.DOCKER_SOCKET ||
  (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');

/** 通过 Docker socket 执行 HTTP 请求并返回 { status, json } */
function dockerRequest(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        method: method || 'GET',
        path: path || '/',
        timeout: timeoutMs || 30_000,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = buf.length ? JSON.parse(buf.toString('utf8')) : null;
          } catch {
            json = buf.toString('utf8');
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Docker socket 请求超时')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * 解析 Docker 多路复用流（/logs）为行数组
 * 帧格式：8 字节头 [streamType, 0, 0, 0, size(uint32 BE)] + payload
 */
function parseMuxStream(buf) {
  const lines = [];
  let off = 0;
  let plain = '';
  while (off + 8 <= buf.length) {
    const streamType = buf[off];
    const size = buf.readUInt32BE(off + 4);
    if (buf[off + 1] !== 0 || buf[off + 2] !== 0 || buf[off + 3] !== 0 || size > buf.length - off) {
      // 非 mux 帧（Tty 模式），退化为纯文本
      lines.push({ s: 'out', t: buf.slice(0).toString('utf8') });
      return lines;
    }
    const payload = buf.slice(off + 8, off + 8 + size);
    lines.push({ s: streamType === 2 ? 'err' : 'out', t: payload.toString('utf8') });
    off += 8 + size;
    plain = '';
  }
  if (lines.length === 0 && buf.length) {
    plain = buf.toString('utf8');
    lines.push({ s: 'out', t: plain });
  }
  return lines;
}

/** 容器日志：经 mux 解析后按行返回 */
function dockerLogs(path) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(
      { socketPath: DOCKER_SOCKET, method: 'GET', path, timeout: 30_000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode;
          if (status >= 400) {
            resolve({ status, lines: [Buffer.concat(chunks).toString('utf8')] });
          } else {
            resolve({ status, lines: parseMuxStream(Buffer.concat(chunks)) });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Docker socket 请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 订阅本机 Docker 事件流并经隧道转发给面板（断流自动重订） */
let eventReq = null;

/** 主机资源采样：CPU 占比（相邻两次 cpus 时刻差计算）与内存使用 */
const os = require('os');
const fs = require('fs');
let lastCpuSample = os.cpus();

function sampleStats() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < cpus.length; i++) {
    idle += cpus[i].times.idle - lastCpuSample[i].times.idle;
    total +=
      cpus[i].times.user +
      cpus[i].times.nice +
      cpus[i].times.sys +
      cpus[i].times.idle +
      cpus[i].times.irq -
      (lastCpuSample[i].times.user +
        lastCpuSample[i].times.nice +
        lastCpuSample[i].times.sys +
        lastCpuSample[i].times.idle +
        lastCpuSample[i].times.irq);
  }
  lastCpuSample = cpus;
  const cpu = total > 0 ? Math.min(100, Math.max(0, (1 - idle / total) * 100)) : 0;
  return {
    cpu: Math.round(cpu * 10) / 10,
    memUsed: os.totalmem() - os.freemem(),
    memTotal: os.totalmem(),
  };
}

/** 每 10 秒向面板上报一次主机资源（隧道在线时） */
function startStats(ws) {
  setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      const s = sampleStats();
      ws.send(JSON.stringify({ type: 'stats', cpu: s.cpu, memUsed: s.memUsed, memTotal: s.memTotal }));
    } catch {
      // 采样失败忽略下一轮
    }
  }, 10_000).unref();
}

/**
 * 自升级（1.71.0 手动 / 1.86.0 自动）：从面板下载最新 agent.js 覆盖自身后退出。
 *
 * reply 为面板下发的升级指令帧（手动触发时回执用），自动触发时为 null。
 * 退出方式由 EDGE_RESTART 决定：
 *   systemd（默认）：直接退出，由 systemd Restart=always 等服务管理器重新拉起；
 *   spawn：先以同样的环境变量拉起一个分离的新进程（运行覆盖后的文件）再退出，
 *          适合 nohup / 计划任务等无服务管理器的场景。
 */
async function selfUpgrade(msg, ws) {
  const reply = (payload) => {
    if (msg) {
      try { ws.send(JSON.stringify({ id: msg.id, ...payload })); } catch {}
    }
  };
  try {
    const resp = await fetch(`${PANEL_URL}/api/edge/agent.js?_=${Date.now()}`, {
      headers: { 'User-Agent': 'edge-agent' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const code = await resp.text();
    if (!code.startsWith('#!') || code.length < 1000) throw new Error('下载内容异常，已放弃覆盖');
    const self = process.argv[1];
    const tmp = self + '.new';
    fs.writeFileSync(tmp, code);
    fs.copyFileSync(self, self + '.bak');
    fs.renameSync(tmp, self);
    reply({ ok: true, status: 200, data: { restarting: true, version: 'latest' } });
    console.log('[edge-agent] 新版本已写入，1 秒后退出');
    setTimeout(() => {
      if (process.env.EDGE_RESTART === 'spawn') {
        try {
          const child = require('child_process');
          child.spawn(process.execPath, [self], { detached: true, stdio: 'ignore', env: process.env }).unref();
          console.log('[edge-agent] 已自拉起新进程');
        } catch (e) {
          console.error('[edge-agent] 自拉起失败：' + String((e && e.message) || e));
        }
      } else {
        console.log('[edge-agent] 等待服务管理器拉起新版本');
      }
      process.exit(0);
    }, 1000);
  } catch (e) {
    reply({ ok: false, status: 500, error: '升级失败: ' + String((e && e.message) || e) });
    if (!msg) console.error('[edge-agent] 自动升级失败：' + String((e && e.message) || e));
  }
}

/** 自动自升级冷却（5 分钟）：避免面板版本异常时反复下载覆盖 */
let lastAutoUpgradeAt = 0;

/** 握手回包（1.86.0）：面板版本落后且未关闭自动升级时自动自升级 */
function maybeAutoUpgrade(welcome, ws) {
  const latest = String(welcome && welcome.latest || '');
  if (!latest || latest === AGENT_VERSION) return;
  if (process.env.EDGE_AUTO_UPGRADE === '0') {
    console.log(`[edge-agent] 面板 agent 版本为 ${latest}，本机 ${AGENT_VERSION}（自动升级已关闭，跳过）`);
    return;
  }
  if (Date.now() - lastAutoUpgradeAt < 5 * 60 * 1000) return;
  lastAutoUpgradeAt = Date.now();
  console.log(`[edge-agent] 检测到新版本 ${latest}（当前 ${AGENT_VERSION}），自动升级中...`);
  selfUpgrade(null, ws);
}

function watchEvents(ws) {
  if (eventReq) {
    try { eventReq.destroy(); } catch {}
    eventReq = null;
  }
  const http = require('http');
  const req = http.request(
    { socketPath: DOCKER_SOCKET, method: 'GET', path: '/events', timeout: 0 },
    (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            // 仅转发容器 / 镜像事件，控制隧道流量
            if (ev.Type === 'container' || ev.Type === 'image') {
              ws.send(JSON.stringify({ type: 'event', event: ev }));
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      });
      res.on('end', () => {
        if (ws.readyState === ws.OPEN) setTimeout(() => watchEvents(ws), 1000);
      });
    },
  );
  req.on('error', () => {});
  req.end();
  eventReq = req;
}

/** 连接面板（带指数退避重连） */
let backoff = 1000;

function connect() {
  const wsUrl = `${PANEL_URL.replace(/^http/, 'ws')}/api/edge/ws?token=${encodeURIComponent(EDGE_TOKEN)}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    backoff = 1000;
    console.log(`[edge-agent] 已连接面板 ${PANEL_URL}（v${AGENT_VERSION}）`);
    ws.send(JSON.stringify({ type: 'hello', version: AGENT_VERSION }));
    watchEvents(ws);
    startStats(ws);
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    // 面板握手回包（1.86.0）：版本落后时自动自升级
    if (msg.type === 'welcome') {
      maybeAutoUpgrade(msg, ws);
      return;
    }
    // 面板下发的自升级指令（1.71.0）
    if (msg.method === 'POST' && msg.path === '/agent/upgrade') {
      await selfUpgrade(msg, ws);
      return;
    }
    if (typeof msg?.id !== 'string' || typeof msg?.method !== 'string' || typeof msg?.path !== 'string') return;
    // 镜像拉取等长耗时操作放宽本机 socket 超时
    const timeout = msg.path.startsWith('/images/create') ? 300_000 : 30_000;
    try {
      if (msg.method === 'GET' && /\/logs(\?|$)/.test(msg.path)) {
        const { status, lines } = await dockerLogs(msg.path);
        ws.send(JSON.stringify({ id: msg.id, ok: status < 400, status, data: { type: 'logs', lines } }));
        return;
      }
      const { status, json } = await dockerRequest(msg.method, msg.path, msg.body, timeout);
      ws.send(JSON.stringify({ id: msg.id, ok: status < 400, status, data: json }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, status: 502, error: String((err && err.message) || err) }));
    }
  };

  ws.onclose = () => {
    if (eventReq) {
      try { eventReq.destroy(); } catch {}
      eventReq = null;
    }
    console.error(`[edge-agent] 连接断开，${backoff / 1000}s 后重连`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };

  ws.onerror = () => ws.close();
}

console.log(`[edge-agent] 启动：面板=${PANEL_URL}，Docker socket=${DOCKER_SOCKET}`);
connect();
