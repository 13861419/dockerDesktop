/**
 * 云端备份目标 API 路由（挂载路径 /api/cloud）
 *
 * 提供 WebDAV / S3 / 阿里 OSS 三种云端存储目标的管理、连通性测试与文件上传。
 * 全部基于 Node 内置 http/https 手写请求与签名，不引入任何第三方依赖。
 *
 * 安全：凭据（SecretKey/密码）经 storage.encryptSecret 加密后落库，仅在解析时解密。
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { getDb, encryptSecret, decryptSecret } from '../storage';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/** 云目标类型 */
type CloudType = 's3' | 'oss' | 'webdav';

/** 云目标行 */
interface CloudTarget {
  id: string;
  name: string;
  type: CloudType;
  endpoint: string;
  bucket: string | null;
  path: string;
  access_key: string | null;
  secret_encrypted: string | null;
  region: string | null;
  created_at: number;
  updated_at: number;
}

/** 云目标输入（字段全必填，避免 undefined 传入 SQLite） */
interface CloudTargetInput {
  name: string;
  type: CloudType;
  endpoint: string;
  bucket: string;
  path: string;
  accessKey: string;
  secret: string;
  region: string;
}

/** 解析后的云目标（含解密的 secret） */
interface ResolvedTarget {
  id: string;
  name: string;
  type: CloudType;
  endpoint: string;
  bucket: string;
  path: string;
  accessKey: string;
  secret: string;
  region: string;
}

/** 统一兜底错误处理 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 执行一次 HTTP(S) 请求
 * @param urlStr 完整 URL
 * @param method 方法
 * @param headers 请求头
 * @param body 请求体（Buffer | string）
 * @returns { status, body, headers }
 */
function httpRequest(
  urlStr: string,
  method: string,
  headers: Record<string, string>,
  body?: Buffer | string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch (e: any) {
      return reject(Object.assign(new Error('无效的 URL：' + urlStr), { statusCode: 400 }));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const data = body ? Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8') : undefined;
    const req = mod.request(
      u,
      { method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', (e) => reject(e));
    req.setTimeout(30000, () => {
      req.destroy(new Error('请求超时'));
    });
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 计算 HMAC
 * @param key 密钥
 * @param data 数据
 * @returns Buffer
 */
function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** AWS SigV4 帮助函数：sigv4 hex */
function hmacSha256Hex(key: Buffer | string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/**
 * 计算 S3 预签名版本的规范请求与签名（AWS4-HMAC-SHA256，PayloadHash=SHA256(body)）
 * @param cfg 目标配置
 * @param objectKey 对象键（含基路径）
 * @param body 请求体
 * @param method 方法
 * @returns 需要的 headers
 */
function signS3(
  cfg: ResolvedTarget,
  objectKey: string,
  body: Buffer,
  method: string,
  region: string,
  host: string,
): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

  const canonicalUri = '/' + objectKey.split('/').map((seg) => encodeURIComponent(seg).replace(/%2F/gi, '/')).join('/');
  const canonicalQuery = '';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hmacSha256Hex('', canonicalRequest)}`;

  const dateKey = hmac('AWS4' + cfg.secret, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmacSha256Hex(signingKey, stringToSign);

  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * 计算阿里 OSS 签名（基于 HMAC-SHA1 的 OSS V1）
 * @param cfg 目标配置
 * @param objectKey 对象键
 * @param contentType 内容类型
 * @param date 日期字符串（GMT）
 * @returns Authorization 值
 */
function signOSS(
  cfg: ResolvedTarget,
  objectKey: string,
  contentType: string,
  date: string,
): string {
  const resource = '/' + cfg.bucket + '/' + objectKey.split('/').map((s) => encodeURIComponent(s)).join('/');
  const stringToSign = `PUT\n\n${contentType}\n${date}\n${resource}`;
  const sig = crypto
    .createHmac('sha1', cfg.secret)
    .update(stringToSign, 'utf8')
    .digest('base64');
  return `OSS ${cfg.accessKey}:${sig}`;
}

/**
 * 构造上传目标 URL 并执行
 * @param cfg 目标解析结果
 * @param filename 文件名
 * @param content 文件内容
 * @returns 测试/上传结果
 */
async function performUpload(
  cfg: ResolvedTarget,
  filename: string,
  content: Buffer,
): Promise<{ ok: boolean; message: string; status: number }> {
  const objectPath = [cfg.path, filename].filter(Boolean).join('/');

  if (cfg.type === 'webdav') {
    // WebDAV：PUT + Basic Auth
    let base = cfg.endpoint.replace(/\/+$/, '');
    const url = base + '/' + objectPath.split('/').map(encodeURIComponent).join('/');
    const auth = 'Basic ' + Buffer.from(`${cfg.accessKey}:${cfg.secret}`, 'utf8').toString('base64');
    const headers: Record<string, string> = {
      Authorization: auth,
      'Content-Type': 'application/octet-stream',
    };
    return httpRequest(url, 'PUT', headers, content).then((r) => ({
      ok: r.status >= 200 && r.status < 300,
      message: r.status >= 200 && r.status < 300 ? '上传成功' : `上传失败（HTTP ${r.status}）：${r.body.slice(0, 300)}`,
      status: r.status,
    }));
  }

  // S3 / OSS 共享：确定 host 与 bucket
  const bucket = cfg.bucket;
  if (!bucket) return { ok: false, message: '缺少桶名（bucket）', status: 0 };
  const region = cfg.region || 'us-east-1';

  if (cfg.type === 'oss') {
    // OSS：endpoint 形如 https://oss-cn-hangzhou.aliyuncs.com；URL = https://<bucket>.<endpoint-host>/<object>
    let base = cfg.endpoint.replace(/\/+$/, '');
    const u = new URL(base);
    const host = `${bucket}.${u.host}`;
    const url = `https://${host}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
    const date = new Date().toUTCString();
    const contentMd5 = crypto.createHash('md5').update(content).digest('base64');
    const auth = signOSS(cfg, objectPath, 'application/octet-stream', date);
    const headers: Record<string, string> = {
      Authorization: auth,
      'Content-Type': 'application/octet-stream',
      Date: date,
    };
    if (contentMd5) headers['Content-MD5'] = contentMd5;
    return httpRequest(url, 'PUT', headers, content).then((r) => ({
      ok: r.status >= 200 && r.status < 300,
      message: r.status >= 200 && r.status < 300 ? '上传成功' : `上传失败（HTTP ${r.status}）：${r.body.slice(0, 300)}`,
      status: r.status,
    }));
  }

  // S3（AWS SigV4）
  let base = cfg.endpoint.replace(/\/+$/, '');
  const u = new URL(base);
  const host = `${bucket}.${u.host}`;
  const url = `https://${host}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
  const sigHeaders = signS3(cfg, objectPath, content, 'PUT', region, host);
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    ...sigHeaders,
  };
  return httpRequest(url, 'PUT', headers, content).then((r) => ({
    ok: r.status >= 200 && r.status < 300,
    message: r.status >= 200 && r.status < 300 ? '上传成功' : `上传失败（HTTP ${r.status}）：${r.body.slice(0, 300)}`,
    status: r.status,
  }));
}

/**
 * 解析并校验云端目标
 * @param body 请求体
 * @returns 归一化字段
 */
function validateBody(body: any): CloudTargetInput {
  const type: CloudType = ['s3', 'oss', 'webdav'].includes(body?.type) ? body.type : 'webdav';
  const name = String(body?.name || '').trim();
  const endpoint = String(body?.endpoint || '').trim();
  if (!name) throw Object.assign(new Error('目标名称不能为空'), { statusCode: 400 });
  if (!endpoint) throw Object.assign(new Error('端点不能为空'), { statusCode: 400 });
  return {
    name,
    type,
    endpoint,
    bucket: String(body?.bucket || '').trim(),
    path: String(body?.path || '').trim().replace(/^\/+|\/+$/g, ''),
    accessKey: String(body?.accessKey || '').trim(),
    secret: String(body?.secret || ''),
    region: String(body?.region || '').trim() || 'us-east-1',
  };
}

/**
 * GET /api/cloud/targets
 * 列出全部云端目标（secret 不返回）
 */
router.get(
  '/targets',
  asyncHandler(async (_req: Request, res: Response) => {
    const d = getDb();
    const rows = d
      .prepare('SELECT id, name, type, endpoint, bucket, path, access_key, region, created_at, updated_at FROM cloud_targets ORDER BY created_at ASC')
      .all() as unknown as CloudTarget[];
    res.json({
      targets: rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        endpoint: r.endpoint,
        bucket: r.bucket || '',
        path: r.path || '',
        accessKey: r.access_key || '',
        region: r.region || '',
        hasSecret: !!r.secret_encrypted,
      })),
    });
  }),
);

/**
 * POST /api/cloud/targets
 * 新增云端目标
 */
router.post(
  '/targets',
  asyncHandler(async (req: Request, res: Response) => {
    const v = validateBody(req.body);
    const d = getDb();
    const id = crypto.randomUUID();
    const now = Date.now();
    d.prepare(
      'INSERT INTO cloud_targets (id, name, type, endpoint, bucket, path, access_key, secret_encrypted, region, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, v.name, v.type, v.endpoint, v.bucket || null, v.path || '', v.accessKey || null, encryptSecret(v.secret || ''), v.region || null, now, now);
    logOperation(res.locals.username, '新增云端目标', '备份', v.name, v.type);
    res.json({ ok: true, id });
  }),
);

/**
 * PUT /api/cloud/targets/:id
 * 更新云端目标（secret 为空则保持不变）
 */
router.put(
  '/targets/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT secret_encrypted FROM cloud_targets WHERE id = ?').get(id) as { secret_encrypted: string | null } | undefined;
    if (!row) return res.status(404).json({ error: '目标不存在' });
    const v = validateBody(req.body);
    const newSecret = String(req.body?.secret || '').trim();
    const secret = newSecret ? encryptSecret(newSecret) : row.secret_encrypted;
    d.prepare(
      'UPDATE cloud_targets SET name=?, type=?, endpoint=?, bucket=?, path=?, access_key=?, secret_encrypted=?, region=?, updated_at=? WHERE id=?',
    ).run(v.name, v.type, v.endpoint, v.bucket || null, v.path || '', v.accessKey || null, secret, v.region || null, Date.now(), id);
    logOperation(res.locals.username, '更新云端目标', '备份', v.name);
    res.json({ ok: true });
  }),
);

/**
 * DELETE /api/cloud/targets/:id
 * 删除云端目标
 */
router.delete(
  '/targets/:id',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const d = getDb();
    const row = d.prepare('SELECT name FROM cloud_targets WHERE id = ?').get(id) as { name: string } | undefined;
    if (!row) return res.status(404).json({ error: '目标不存在' });
    d.prepare('DELETE FROM cloud_targets WHERE id = ?').run(id);
    logOperation(res.locals.username, '删除云端目标', '备份', row.name);
    res.json({ ok: true });
  }),
);

/**
 * 从数据库解析目标（含解密 secret）
 * @param body 请求体（含 id）
 */
function resolveTarget(body: any): ResolvedTarget {
  const id = String(body?.id || '');
  if (!id) throw Object.assign(new Error('缺少目标 id'), { statusCode: 400 });
  const d = getDb();
  const row = d.prepare('SELECT * FROM cloud_targets WHERE id = ?').get(id) as CloudTarget | undefined;
  if (!row) throw Object.assign(new Error('目标不存在'), { statusCode: 404 });
  const secret = decryptSecret(row.secret_encrypted);
  if (!secret) throw Object.assign(new Error('目标密钥缺失，请编辑目标补充密钥'), { statusCode: 400 });
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    endpoint: row.endpoint,
    bucket: row.bucket || '',
    path: row.path || '',
    accessKey: row.access_key || '',
    secret,
    region: row.region || 'us-east-1',
  };
}

/**
 * POST /api/cloud/targets/:id/test
 * 测试目标连通性：上传一个极小探测文件
 */
router.post(
  '/targets/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const cfg = resolveTarget({ id });
    const probe = Buffer.from('dm-probe-' + Date.now(), 'utf8');
    const result = await performUpload(cfg, '.dm-probe.tmp', probe);
    res.json({ ok: result.ok, message: result.ok ? '连接成功，已创建测试文件' : result.message });
  }),
);

/**
 * POST /api/cloud/upload
 * 上传文件到云端目标
 * 请求体：express.raw（application/octet-stream），query 传 id=目标id & filename=文件名
 */
router.post(
  '/upload',
  express.raw({ type: 'application/octet-stream', limit: '1gb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.query.id || '');
    const filename = String(req.query.filename || '').trim();
    if (!id) return res.status(400).json({ error: '缺少目标 id' });
    if (!filename) return res.status(400).json({ error: '缺少文件名' });
    const raw = req.body as Buffer | undefined;
    if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) {
      return res.status(400).json({ error: '空内容' });
    }
    const cfg = resolveTarget({ id });
    const result = await performUpload(cfg, filename, raw);
    logOperation(res.locals.username, '云端上传', '备份', cfg.name, `${filename}${result.ok ? '' : `（失败：${result.message}）`}`);
    if (!result.ok) return res.status(502).json({ error: result.message });
    res.json({ ok: true, size: raw.length, target: cfg.name });
  }),
);

export default router;
