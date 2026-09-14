#!/usr/bin/env node
/**
 * DockerManager Edge Agent（1.63.0）
 *
 * 零依赖单文件 agent：部署在远程主机上，主动反向连接面板，
 * 把面板下发的 Docker Engine HTTP 请求透传给本机 Docker daemon。
 *
 * 用法（环境变量）：
 *   PANEL_URL  面板地址，如 http://panel.example.com:9528
 *   EDGE_TOKEN 面板 Edge 节点 token（创建节点时返回）
 *   DOCKER_SOCK 可选，默认 /var/run/docker.sock（Windows 自动用命名管道）
 *
 * 要求 Node.js >= 22（使用内置 WebSocket 客户端）。
 */
'use strict';

const PANEL_URL = (process.env.PANEL_URL || '').replace(/\/+$/, '');
const EDGE_TOKEN = process.env.EDGE_TOKEN || '';
const AGENT_VERSION = '1.63.0';

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
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
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

/** 连接面板（带指数退避重连） */
let backoff = 1000;

function connect() {
  const wsUrl = `${PANEL_URL.replace(/^http/, 'ws')}/api/edge/ws?token=${encodeURIComponent(EDGE_TOKEN)}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    backoff = 1000;
    console.log(`[edge-agent] 已连接面板 ${PANEL_URL}（v${AGENT_VERSION}）`);
    ws.send(JSON.stringify({ type: 'hello', version: AGENT_VERSION }));
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (typeof msg?.id !== 'string' || typeof msg?.method !== 'string' || typeof msg?.path !== 'string') return;
    // 镜像拉取等长耗时操作放宽本机 socket 超时
    const timeout = msg.path.startsWith('/images/create') ? 300_000 : 30_000;
    try {
      const { status, json } = await dockerRequest(msg.method, msg.path, msg.body, timeout);
      ws.send(JSON.stringify({ id: msg.id, ok: status < 400, status, data: json }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, status: 502, error: String((err && err.message) || err) }));
    }
  };

  ws.onclose = () => {
    console.error(`[edge-agent] 连接断开，${backoff / 1000}s 后重连`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };

  ws.onerror = () => ws.close();
}

console.log(`[edge-agent] 启动：面板=${PANEL_URL}，Docker socket=${DOCKER_SOCKET}`);
connect();
