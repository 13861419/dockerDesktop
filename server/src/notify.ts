/**
 * 通知渠道存储与推送模块
 *
 * 负责通知渠道（Webhook / 邮件 / 钉钉 / 飞书）的持久化 CRUD，
 * 以及将告警消息推送到已启用渠道。
 *
 * - 渠道配置中敏感字段（口令/密钥/访问令牌）使用 storage 的对称加密存储，
 *   前端回显时不返回明文，仅标记"已配置"。
 * - 推送执行基于 Node 内置能力（fetch / net / tls），零第三方依赖。
 */
import crypto from 'crypto';
import net from 'net';
import tls from 'tls';
import { getDb, encryptSecret, decryptSecret } from './storage';

/** 渠道类型 */
export type ChannelType = 'webhook' | 'email' | 'dingtalk' | 'feishu';

/** 渠道行结构（数据库行） */
interface ChannelRow {
  id: string;
  name: string;
  type: string;
  enabled: number;
  config: string;
  created_at: number;
  updated_at: number;
}

/** 暴露给前端的渠道配置（敏感字段脱敏） */
export interface ChannelInfo {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  /** 非敏感配置项（如 URL、主机、收件人等） */
  config: Record<string, any>;
  /** 敏感字段是否已设置（代替明文回显） */
  secretsSet: Record<string, boolean>;
  createdAt: number;
  updatedAt: number;
}

/** 需要加密存储的字段（按渠道类型） */
const SECRET_FIELDS: Record<ChannelType, string[]> = {
  webhook: ['secret'],
  email: ['password'],
  dingtalk: ['accessToken', 'secret'],
  feishu: [],
};

/**
 * 解密渠道配置中的敏感字段，返回完整配置
 * @param config 已加密存储的整段配置 JSON 字符串
 */
function decodeConfig(config: string): Record<string, any> {
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(config || '{}');
  } catch {
    parsed = {};
  }
  const cfg: Record<string, any> = {};
  for (const [k, v] of Object.entries(parsed)) {
    // 带 enc: 前缀的字段为密文，解密还原
    if (typeof v === 'string' && v.startsWith('enc:')) {
      cfg[k] = decryptSecret(v.slice(4));
    } else {
      cfg[k] = v;
    }
  }
  return cfg;
}

/**
 * 加密渠道配置中的敏感字段，输出可存储的整段 JSON 字符串
 * @param cfg 明文配置
 * @param type 渠道类型
 */
function encodeConfig(cfg: Record<string, any>, type: ChannelType): string {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === null) continue;
    if (SECRET_FIELDS[type]?.includes(k) && String(v) !== '') {
      // 敏感字段：加密后带 enc: 前缀存储
      out[k] = 'enc:' + encryptSecret(String(v));
    } else {
      out[k] = v;
    }
  }
  return JSON.stringify(out);
}

/**
 * 将数据库行转换为公开的渠道信息（脱敏敏感字段）
 * @param row 渠道行
 */
function toChannelInfo(row: ChannelRow): ChannelInfo {
  const raw = decodeConfig(row.config);
  const type = row.type as ChannelType;
  // 仅返回非敏感配置
  const publicCfg: Record<string, any> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (SECRET_FIELDS[type]?.includes(k)) {
      secretsSet[k] = Boolean(v);
    } else {
      publicCfg[k] = v;
    }
  }
  return {
    id: row.id,
    name: row.name,
    type,
    enabled: row.enabled === 1,
    config: publicCfg,
    secretsSet,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 校验并归一化渠道配置（缺失必填字段时抛 400）
 * @param type 渠道类型
 * @param config 用户提交的配置
 */
function validateConfig(type: ChannelType, config: Record<string, any>): void {
  if (type === 'webhook') {
    if (!String(config?.url ?? '').trim()) {
      throw Object.assign(new Error('请填写 Webhook 地址'), { statusCode: 400 });
    }
  } else if (type === 'email') {
    const miss = ['host', 'port', 'from', 'to'].filter((f) => !String(config?.[f] ?? '').trim());
    if (miss.length) throw Object.assign(new Error(`请填写: ${miss.join('、')}`), { statusCode: 400 });
    if (!/^\d+$/.test(String(config.port))) {
      throw Object.assign(new Error('邮件端口需为数字'), { statusCode: 400 });
    }
  } else if (type === 'dingtalk') {
    if (!String(config?.accessToken ?? '').trim()) {
      throw Object.assign(new Error('请填写钉钉机器人 access_token'), { statusCode: 400 });
    }
  } else if (type === 'feishu') {
    if (!String(config?.webhookUrl ?? '').trim()) {
      throw Object.assign(new Error('请填写飞书机器人 Webhook 地址'), { statusCode: 400 });
    }
  }
}

/**
 * 列出所有通知渠道
 */
export function listChannels(): ChannelInfo[] {
  const rows = getDb()
    .prepare('SELECT id, name, type, enabled, config, created_at, updated_at FROM notify_channels ORDER BY created_at ASC')
    .all() as unknown as ChannelRow[];
  return rows.map(toChannelInfo);
}

/**
 * 根据 id 获取单条渠道（内部使用，返回完整解密配置）
 * @param id 渠道 id
 */
export function getChannel(id: string): { info: ChannelInfo; cfg: Record<string, any> } | null {
  const row = getDb()
    .prepare('SELECT id, name, type, enabled, config, created_at, updated_at FROM notify_channels WHERE id = ?')
    .get(id) as unknown as ChannelRow | undefined;
  if (!row) return null;
  return { info: toChannelInfo(row), cfg: decodeConfig(row.config) };
}

/**
 * 新增通知渠道
 * @param input 渠道输入（name/type/config）
 */
export function createChannel(input: { name: string; type: ChannelType; config: Record<string, any> }): { id: string } {
  const name = String(input?.name || '').trim();
  const type = input?.type;
  const config = input?.config || {};
  if (!name) throw Object.assign(new Error('请输入渠道名称'), { statusCode: 400 });
  if (!['webhook', 'email', 'dingtalk', 'feishu'].includes(type)) {
    throw Object.assign(new Error('不支持的渠道类型'), { statusCode: 400 });
  }
  validateConfig(type, config);
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO notify_channels (id, name, type, enabled, config, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
    .run(id, name, type, encodeConfig(config, type), now, now);
  return { id };
}

/**
 * 更新通知渠道（不传的字段保持原值；敏感字段传空则保留原密文）
 * @param id 渠道 id
 * @param patch 待更新字段
 */
export function updateChannel(
  id: string,
  patch: { name?: string; enabled?: boolean; config?: Record<string, any> },
): void {
  const existing = getChannel(id);
  if (!existing) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 });
  const d = getDb();
  const name = patch.name !== undefined ? String(patch.name).trim() : existing.info.name;
  if (!name) throw Object.assign(new Error('请输入渠道名称'), { statusCode: 400 });

  // 合并配置：新提交覆盖非敏感字段；敏感字段为空保留原值
  let merged: Record<string, any> = { ...existing.cfg };
  if (patch.config) {
    for (const [k, v] of Object.entries(patch.config)) {
      if (v === undefined || v === null) continue;
      if (SECRET_FIELDS[existing.info.type]?.includes(k) && String(v) === '') continue;
      merged[k] = v;
    }
  }
  validateConfig(existing.info.type, merged);

  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.info.enabled ? 1 : 0;
  const now = Date.now();
  d.prepare('UPDATE notify_channels SET name = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?').run(
    name,
    enabled,
    encodeConfig(merged, existing.info.type),
    now,
    id,
  );
}

/**
 * 删除通知渠道
 * @param id 渠道 id
 */
export function deleteChannel(id: string): void {
  const r = getDb().prepare('DELETE FROM notify_channels WHERE id = ?').run(id);
  if (r.changes === 0) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 });
}

/**
 * 组装钉钉机器人加签参数
 * @param secret 加签密钥
 */
function dingtalkSign(secret: string): { timestamp: string; sign: string } {
  const timestamp = String(Date.now());
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  return { timestamp, sign: encodeURIComponent(sign) };
}

/**
 * 推送一条告警消息到指定渠道
 * @param channelId 渠道 id
 * @param text 告警文本
 */
export async function sendAlert(channelId: string, text: string): Promise<{ ok: boolean; detail: string }> {
  const ch = getChannel(channelId);
  if (!ch) return { ok: false, detail: '渠道不存在' };
  if (!ch.info.enabled) return { ok: false, detail: '渠道已停用' };
  return dispatch(ch.info.type, ch.cfg, text);
}

/**
 * 根据渠道类型执行推送
 * @param type 渠道类型
 * @param cfg 解密后的配置
 * @param text 告警文本
 */
async function dispatch(type: ChannelType, cfg: Record<string, any>, text: string): Promise<{ ok: boolean; detail: string }> {
  switch (type) {
    case 'webhook':
      return pushWebhook(String(cfg.url || ''), String(cfg.secret || ''), text);
    case 'dingtalk':
      return pushDingtalk(String(cfg.accessToken || ''), String(cfg.secret || ''), text);
    case 'feishu':
      return pushFeishu(String(cfg.webhookUrl || ''), text);
    case 'email':
      return sendEmail(cfg, text);
    default:
      return { ok: false, detail: '不支持的渠道类型' };
  }
}

/**
 * 通用 Webhook 推送（POST JSON：{ text }，可选 Bearer Secret）
 * @param url 回调地址
 * @param secret 可选鉴权密钥
 * @param text 告警文本
 */
async function pushWebhook(url: string, secret: string, text: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers['Authorization'] = `Bearer ${secret}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message || err) };
  }
}

/**
 * 钉钉自定义机器人推送
 * @param accessToken 机器人 access_token
 * @param secret 可选加签密钥
 * @param text 告警文本
 */
async function pushDingtalk(accessToken: string, secret: string, text: string): Promise<{ ok: boolean; detail: string }> {
  try {
    let url = `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(accessToken)}`;
    if (secret) {
      const { timestamp, sign } = dingtalkSign(secret);
      url += `&timestamp=${timestamp}&sign=${sign}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      signal: AbortSignal.timeout(10000),
    });
    const body = (await res.text()).slice(0, 300);
    return { ok: res.ok, detail: body || `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message || err) };
  }
}

/**
 * 飞书自定义机器人推送
 * @param webhookUrl 机器人 Webhook 地址
 * @param text 告警文本
 */
async function pushFeishu(webhookUrl: string, text: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(10000),
    });
    const body = (await res.text()).slice(0, 300);
    return { ok: res.ok, detail: body || `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message || err) };
  }
}

/**
 * 极简 SMTP 发送器（基于 Node 内置 net/tls，零第三方依赖）
 *
 * 采用显式线性状态机，支持两种主流通路：
 *  - useTls=true：直连 SSL（如 465 端口）
 *  - useTls=false：明文连接（如 25 端口），登录+发送
 * 数据流式拼接，等待完整行响应后按阶段推进。
 * @param cfg 邮件配置
 * @param text 正文
 */
async function sendEmail(cfg: Record<string, any>, text: string): Promise<{ ok: boolean; detail: string }> {
  const host = String(cfg.host || '');
  const port = Number(cfg.port) || 25;
  const username = String(cfg.username || '');
  const password = String(cfg.password || '');
  const from = String(cfg.from || '');
  const toList = String(cfg.to || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const useTls = cfg.useTls === true || cfg.useTls === 'true';
  const timeoutMs = 10000;

  if (!host || toList.length === 0) return { ok: false, detail: '邮件配置不完整' };

  // 阶段编号：0=连接/欢迎, 1=EHLO, 2=MAIL FROM, 3=RCPT, 4=DATA, 5=body结束, 6=QUIT
  let step = 0;
  let socket: net.Socket | tls.TLSSocket | null = null;
  let buffer = '';

  const subject = 'Docker 管理面板告警';
  const body =
    `From: ${from}\r\n` +
    `To: ${toList.join(', ')}\r\n` +
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    Buffer.from(text, 'utf8').toString('base64') +
    '\r\n.\r\n';

  function line(cmd: string) {
    if (!socket || socket.destroyed) return;
    socket.write(cmd + '\r\n', 'utf8');
  }

  return new Promise((resolvePromise) => {
    const done = (ok: boolean, detail: string) => {
      try { socket?.destroy(); } catch { /* ignore */ }
      resolvePromise({ ok, detail });
    };

    socket = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    socket.setTimeout(timeoutMs);

    socket.on('data', (data) => {
      buffer += data.toString('utf8');
      while (buffer.includes('\r\n')) {
        const idx = buffer.indexOf('\r\n');
        let lineText = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 2);
        // 多行响应（除最后一行外以 "-" 结尾）
        if (lineText.length >= 3 && lineText.slice(3).startsWith('-')) continue;
        processLine(lineText);
        if (!socket || socket.destroyed) return;
      }
    });

    function processLine(lineText: string) {
      const code = Number(lineText.slice(0, 3));
      const ok = !Number.isNaN(code) && code >= 200 && code < 400;
      if (!ok) {
        done(false, `SMTP 错误: ${lineText}`);
        return;
      }
      if (step === 0) {
        // 欢迎 -> EHLO
        line('EHLO docker-manager.local');
        step = 1;
      } else if (step === 1) {
        // EHLO 完成 -> 认证或直接 MAIL FROM
        if (username) {
          line('AUTH LOGIN');
          step = 7;
        } else {
          line(`MAIL FROM:<${from}>`);
          step = 2;
        }
      } else if (step === 2) {
        // MAIL FROM -> RCPT
        const next = toList[0];
        if (next) {
          line(`RCPT TO:<${next}>`);
          step = 3;
        } else {
          line('DATA');
          step = 4;
        }
      } else if (step === 3) {
        // RCPT -> 下一个 RCPT 或 DATA
        toList.shift();
        if (toList.length > 0) {
          line(`RCPT TO:<${toList[0]}>`);
        } else {
          line('DATA');
          step = 4;
        }
      } else if (step === 4) {
        // DATA 250 -> 发送正文
        if (!socket || socket.destroyed) return;
        socket.write(body, 'utf8');
        step = 5;
        // 发送后服务器回 250
      } else if (step === 5) {
        // 正文完成 -> QUIT
        line('QUIT');
        step = 6;
      } else if (step === 6) {
        // QUIT 完成
        done(true, '邮件已发送');
      } else if (step === 7) {
        // AUTH LOGIN -> 发用户名(base64)
        line(Buffer.from(username).toString('base64'));
        step = 8;
      } else if (step === 8) {
        // 用户名 OK -> 发密码(base64)
        line(Buffer.from(password).toString('base64'));
        step = 9;
      } else if (step === 9) {
        // 认证成功 -> MAIL FROM
        line(`MAIL FROM:<${from}>`);
        step = 2;
      }
    }

    socket.on('error', (err) => done(false, `SMTP 连接错误: ${err.message}`));
    socket.on('timeout', () => done(false, 'SMTP 连接超时'));
    socket.on('close', () => {
      // 未正常完成（QUIT 后 close）视为失败
    });
  });
}
