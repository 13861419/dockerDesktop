/**
 * 极简 ACME v2 客户端（RFC 8555，零依赖）
 *
 * 覆盖签发证书的最小闭环：
 *   directory → newAccount → newOrder → http-01 挑战 → finalize(CSR) → download
 *
 * 设计要点：
 *  - fetch + node:crypto，不引入第三方依赖
 *  - nonce 从每次响应的 replay-nonce 头读取，失败时自动重新获取一次
 *  - 轮询统一走 POST-as-GET，最多 maxPollTimes 次
 */
import crypto from 'crypto';
import { b64url, jwkFor, signJws, thumbprint } from './jose';

/** Let's Encrypt 生产环境目录（可用 ACME_DIRECTORY_URL 覆盖为 staging） */
export const DEFAULT_DIRECTORY_URL =
  process.env.ACME_DIRECTORY_URL || 'https://acme-v02.api.letsencrypt.org/directory';

/** 单个授权/订单的最大轮询次数（3s 间隔） */
const MAX_POLL_TIMES = 20;

export class AcmeClient {
  private accountKey: crypto.KeyObject;
  private kid = '';
  private dir: Record<string, string> = {};
  private nonce = '';
  private dirUrl: string;

  constructor(accountKey: crypto.KeyObject, dirUrl = DEFAULT_DIRECTORY_URL) {
    this.accountKey = accountKey;
    this.dirUrl = dirUrl;
  }

  /** 读取目录并初始化端点 */
  async init(): Promise<void> {
    const resp = await fetch(this.dirUrl, { method: 'GET' });
    if (!resp.ok) throw new Error(`获取 ACME directory 失败：HTTP ${resp.status}`);
    this.dir = (await resp.json()) as Record<string, string>;
    await this.refreshNonce();
  }

  /** 获取新的 anti-replay nonce */
  private async refreshNonce(): Promise<void> {
    const resp = await fetch(this.dir.newNonce, { method: 'HEAD' });
    const n = resp.headers.get('replay-nonce');
    if (!n) throw new Error('未能获取 ACME nonce');
    this.nonce = n;
  }

  /** 带自动重试的 JWS POST */
  private async post(url: string, payloadObj: Record<string, unknown> | string, useKid = true): Promise<Response> {
    const doSend = async (): Promise<Response> => {
      const header = useKid
        ? { alg: 'RS256', kid: this.kid, nonce: this.nonce, url }
        : { alg: 'RS256', jwk: jwkFor(this.accountKey), nonce: this.nonce, url };
      const jws = signJws({ signingKey: this.accountKey, protectedHeader: header, payloadObj });
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jose+json' },
        body: JSON.stringify(jws),
      });
    };
    let resp = await doSend();
    if (!resp.ok && resp.status === 400) {
      // nonce 过期等场景：刷新后重试一次
      await this.refreshNonce();
      resp = await doSend();
    }
    const n = resp.headers.get('replay-nonce');
    if (n) this.nonce = n;
    return resp;
  }

  /** 解析 ACME 错误响应 */
  private async raise(resp: Response, context: string): Promise<never> {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { detail?: string; type?: string };
      if (body?.detail) detail = body.detail;
    } catch {
      // 保留 HTTP 状态码
    }
    throw new Error(`${context}失败：${detail}`);
  }

  /** 注册账户（幂等，返回账户 URL 作为 KID） */
  async ensureAccount(contactEmail: string): Promise<string> {
    const resp = await this.post(this.dir.newAccount, {
      termsOfServiceAgreed: true,
      contact: [`mailto:${contactEmail}`],
      onlyReturnExisting: false,
    }, false);
    const location = resp.headers.get('location');
    if (!resp.ok) await this.raise(resp, '注册 ACME 账户');
    if (!location) throw new Error('ACME 账户响应缺少 location');
    this.kid = location;
    return location;
  }

  /** 创建订单（domains 为待签发域名列表） */
  async newOrder(domains: string[]): Promise<any> {
    const resp = await this.post(this.dir.newOrder, {
      identifiers: domains.map((d) => ({ type: 'dns', value: d })),
    });
    if (!resp.ok) await this.raise(resp, '创建订单');
    return (await resp.json()) as any;
  }

  /** POST-as-GET 拉取授权 / 订单 */
  async fetchAsGet(url: string): Promise<any> {
    const resp = await this.post(url, '');
    if (!resp.ok) await this.raise(resp, '查询');
    return (await resp.json()) as any;
  }

  /** 应答 http-01 挑战 */
  async respondChallenge(challengeUrl: string): Promise<void> {
    const resp = await this.post(challengeUrl, {});
    if (!resp.ok && resp.status !== 200) await this.raise(resp, '应答挑战');
  }

  /** keyAuthorization = token + '.' + thumbprint */
  keyAuthorization(token: string): string {
    return `${token}.${thumbprint(jwkFor(this.accountKey))}`;
  }

  /** 轮询直至 valid / invalid / 超时 */
  async pollUntilValid(url: string): Promise<any> {
    for (let i = 0; i < MAX_POLL_TIMES; i++) {
      const obj = await this.fetchAsGet(url);
      if (obj?.status === 'valid' || obj?.status === 'invalid') return obj;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error('轮询超时：授权 / 订单长时间未完成');
  }

  /** 提交 CSR 并等待订单生效，返回证书下载地址 */
  async finalize(finalizeUrl: string, csrPem: string): Promise<string> {
    const der = pemToDer(csrPem);
    const resp = await this.post(finalizeUrl, { csr: b64url(der) });
    if (!resp.ok) await this.raise(resp, '提交 CSR');
    const order = (await resp.json()) as any;
    let url = order.certificate as string | undefined;
    if (!url || order.status !== 'valid') {
      const finalOrder = await this.pollUntilValid(finalizeUrl);
      if (finalOrder?.status !== 'valid') throw new Error(`订单未生效：${finalOrder?.status}`);
      url = finalOrder.certificate;
    }
    if (!url) throw new Error('订单缺少证书地址');
    return url;
  }

  /** 下载证书链（PEM） */
  async downloadCertificate(url: string): Promise<string> {
    const resp = await this.post(url, '');
    if (!resp.ok) await this.raise(resp, '下载证书');
    return (await resp.text()) as string;
  }
}

/** PEM → DER */
function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----[^\-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}
