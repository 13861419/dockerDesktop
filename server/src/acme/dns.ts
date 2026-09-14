/**
 * DNS-01 挑战支撑（1.59.0）：DNS 解析商 TXT 记录读写
 *
 *  - cloudflare：Cloudflare API v4（单 API Token）
 *  - aliyun：阿里云 DNS RPC 签名接口（AccessKey ID + Secret）
 *
 * 凭证从系统参数读取：
 *  - acme.dnsProvider = none | cloudflare | aliyun
 *  - acme.dnsApiToken = Cloudflare Token 或 "AKID:Secret"（阿里云）
 */
import crypto from 'crypto';

export type DnsProvider = 'none' | 'cloudflare' | 'aliyun';

/** DNS 记录操作句柄 */
export interface DnsTxtRecord {
  /** 供删除用的记录 ID（provider 内部标识） */
  recordId: string;
  /** 完整挑战域名（_acme-challenge.<domain>） */
  recordName: string;
  /** 清理 TXT 记录 */
  cleanup(): Promise<void>;
}

/** 解析凭证串 → provider 专用结构 */
function parseToken(provider: DnsProvider, token: string): string {
  const t = String(token || '').trim();
  if (!t) throw new Error('未配置 DNS API 凭证（设置 → 系统参数 → 安全 → DNS API 凭证）');
  return t;
}

/** DNS-01 TXT 记录值 = base64url(sha256(keyAuthorization)) */
export function dnsTxtValue(keyAuthorization: string): string {
  return crypto.createHash('sha256').update(keyAuthorization).digest('base64url');
}

/** 挑战域名 */
export function challengeDomain(domain: string): string {
  // *.example.com 与 example.com 的挑战域名一致
  return `_acme-challenge.${domain.replace(/^\*\./, '')}`;
}

/** RFC 3986 百分号编码（阿里云签名用） */
function aliyunPercentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/** 阿里云 RPC 签名 GET 请求 */
async function aliyunCall(akPair: string, params: Record<string, string>): Promise<any> {
  const sep = akPair.indexOf(':');
  if (sep <= 0) {
    throw new Error('阿里云 DNS 凭证格式错误：应为 "AccessKey ID:AccessKey Secret"（英文冒号连接）');
  }
  const akId = akPair.slice(0, sep);
  const akSecret = akPair.slice(sep + 1);
  const base: Record<string, string> = {
    Format: 'JSON',
    Version: '2015-01-09',
    AccessKeyId: akId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const all = { ...base, ...params };
  const canonical = Object.keys(all)
    .sort()
    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(all[k])}`)
    .join('&');
  const stringToSign = `GET&%2F&${aliyunPercentEncode(canonical)}`;
  const sig = crypto.createHmac('sha1', `${akSecret}&`).update(stringToSign).digest('base64');
  const url = `https://alidns.aliyuncs.com/?${canonical}&Signature=${aliyunPercentEncode(sig)}`;
  const resp = await fetch(url);
  const data = (await resp.json().catch(() => ({}))) as any;
  if (data?.Code || data?.Message) {
    throw new Error(`阿里云 DNS API 错误：${data.Message || data.Code}`);
  }
  return data;
}

/** Cloudflare API 调用 */
async function cfCall(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const resp = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const obj = (await resp.json().catch(() => ({}))) as any;
  if (!obj?.success) {
    const msg = obj?.errors?.[0]?.message || `HTTP ${resp.status}`;
    throw new Error(`Cloudflare API 错误：${msg}`);
  }
  return obj.result;
}

/** 候选 zone 名：sub.example.com → example.com → com（从长到短） */
function zoneCandidates(domain: string): string[] {
  const labels = domain.replace(/^\*\./, '').split('.');
  const out: string[] = [];
  for (let i = 1; i < labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** 在指定解析商创建 TXT 记录（成功返回句柄，cleanup 可删除） */
export async function createTxtRecord(
  provider: DnsProvider,
  token: string,
  domain: string,
  value: string,
): Promise<DnsTxtRecord> {
  const name = challengeDomain(domain);
  if (provider === 'cloudflare') {
    const t = String(token || '').trim();
    if (!t) throw new Error('未配置 DNS API 凭证（设置 → 系统参数 → 安全 → DNS API 凭证）');
    // 定位 zone：从完整域逐级上溯找托管区
    const labels = domain.replace(/^\*\./, '').split('.');
    let recordId = '';
    let zoneId = '';
    for (let i = 1; i < labels.length - 1 && !recordId; i++) {
      const zoneName = labels.slice(i).join('.');
      const zones = await cfCall(t, 'GET', `/zones?name=${encodeURIComponent(zoneName)}&per_page=1`);
      if (Array.isArray(zones) && zones.length > 0) {
        zoneId = zones[0].id;
        const rec = await cfCall(t, 'POST', `/zones/${zoneId}/dns_records`, {
          type: 'TXT',
          name,
          content: value,
          ttl: 120,
        });
        recordId = rec.id;
      }
    }
    if (!recordId) throw new Error(`未找到 ${domain} 对应的 Cloudflare Zone（Token 需包含 DNS 编辑权限）`);
    return {
      recordId,
      recordName: name,
      cleanup: async () => {
        await cfCall(t, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`).catch(() => {});
      },
    };
  }
  if (provider === 'aliyun') {
    const t = parseTokenPair(token);
    const labels = domain.replace(/^\*\./, '').split('.');
    const rr = name.replace(`.${labels.slice(-2).join('.')}`, '');
    const domainName = labels.slice(-2).join('.');
    const rec = await aliyunCall(t, {
      Action: 'AddDomainRecord',
      DomainName: domainName,
      RR: rr,
      Type: 'TXT',
      Value: value,
      TTL: '120',
    });
    return {
      recordId: String(rec.RecordId || ''),
      recordName: name,
      cleanup: async () => {
        if (rec.RecordId) {
          await aliyunCall(t, { Action: 'DeleteDomainRecord', RecordId: String(rec.RecordId) }).catch(() => {});
        }
      },
    };
  }
  throw new Error(`不支持的 DNS 解析商：${provider}`);
}

function parseTokenPair(token: string): string {
  const t = String(token || '').trim();
  if (!t || !t.includes(':')) {
    throw new Error('阿里云 DNS 凭证格式错误：应为 "AccessKey ID:AccessKey Secret"（英文冒号连接）');
  }
  return t;
}

/** 通过 DoH（DNS over HTTPS）轮询 TXT 生效（尽力而为，超时不抛错由 ACME 服务端裁决） */
export async function waitTxtVisible(domain: string, value: string, timeoutMs = 90_000): Promise<boolean> {
  const name = challengeDomain(domain);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
        headers: { accept: 'application/dns-json' },
      });
      if (resp.ok) {
        const obj = (await resp.json()) as any;
        const answers: any[] = obj?.Answer || [];
        if (answers.some((a) => String(a.data || '').replace(/^"|"$/g, '') === value)) return true;
      }
    } catch {
      // DoH 不通时静默等待（权威解析由 LE 校验）
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}
