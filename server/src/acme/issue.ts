/**
 * ACME 签发编排：申请、落盘、续期调度
 *
 *  - 证书与私钥同时写入 <数据目录>/certs/<主域名>/<主域名>.pem / .key，
 *    命名与站点反向代理的 cert_path / key_path 推导规则一致，可直接引用
 *  - 账户密钥持久化于 <数据目录>/acme-account-key.pem
 *  - 续期策略：每日检查一次，剩余有效期 < 30 天时重新签发
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AcmeClient, DEFAULT_DIRECTORY_URL } from './client';
import { buildCsr, loadOrCreateKey } from './jose';
import { putChallenge, startChallengeServer, challengeServerStatus } from './challengeServer';
import { createTxtRecord, dnsTxtValue, waitTxtVisible } from './dns';
import { getSetting } from '../settings';
import { DATA_DIR, getDb } from '../storage';

/** 账户密钥文件 */
const ACCOUNT_KEY_FILE = path.join(DATA_DIR, 'acme-account-key.pem');

/** 证书落盘目录 */
export const CERTS_DIR = path.join(DATA_DIR, 'certs');

/** 剩余有效期低于该天数时触发续期 */
const RENEW_BEFORE_DAYS = 30;

/** 域名格式校验（宽松：字母数字点划线，不校验 TLD 合法性；1.59.0 起支持首段通配符 *.example.com） */
const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*$/;

/** 通配符域名判断 */
export function isWildcard(domain: string): boolean {
  return domain.startsWith('*.');
}

/** 校验并整理域名列表（去重、去空白），非法时抛 400 */
export function sanitizeDomains(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : String(input || '').split(',');
  const domains = Array.from(
    new Set(
      raw
        .map((d) => String(d).trim().toLowerCase())
        .filter((d) => d.length > 0),
    ),
  );
  if (domains.length === 0) {
    const err: any = new Error('域名列表不能为空');
    err.statusCode = 400;
    throw err;
  }
  for (const d of domains) {
    const bare = d.replace(/^\*\./, '');
    if (!DOMAIN_RE.test(bare) && !DOMAIN_RE.test(d) || d.length > 253) {
      const err: any = new Error(`非法域名：${d}`);
      err.statusCode = 400;
      throw err;
    }
  }
  return domains;
}

/** 从证书 PEM 解析到期时间 */
function parseExpiresAt(certPem: string): number {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return new Date(x509.validTo).getTime();
  } catch {
    return Date.now() + 90 * 24 * 3600 * 1000;
  }
}

/**
 * 签发一张证书（含挑战应答与落盘），成功后写入 ssl_certs 表
 * @param domains 域名列表（首个为主域名）
 * @param contactEmail ACME 账户联系邮箱
 * @returns { domains, issuedAt, expiresAt }
 */
export async function issueCertificate(domains: string[], contactEmail: string): Promise<{
  domains: string[];
  issuedAt: number;
  expiresAt: number;
  certPem: string;
  keyPem: string;
}> {
  // 确保 80 端口挑战服务可用（占用失败时给出明确提示）；纯通配符订单走 DNS-01 无需 80 端口
  const wildcards = domains.filter(isWildcard);
  const normals = domains.filter((d) => !isWildcard(d));
  const dnsProvider = (String(getSetting<string>('acme.dnsProvider') || 'none').toLowerCase() || 'none') as
    | 'none'
    | 'cloudflare'
    | 'aliyun';
  const dnsToken = String(getSetting<string>('acme.dnsApiToken') || '');

  if (wildcards.length > 0 && (dnsProvider === 'none' || !dnsToken)) {
    const err: any = new Error(
      '通配符域名需 DNS-01 验证：请先在「设置 → 系统参数 → 安全」配置 DNS 解析商与 API 凭证',
    );
    err.statusCode = 400;
    throw err;
  }

  if (normals.length > 0) {
    const st = challengeServerStatus();
    if (!st.listening) {
      const started = await startChallengeServer();
      if (!started.ok) {
        const err: any = new Error(
          `HTTP-01 挑战服务未就绪：${started.error}。请释放 80 端口（或设置 ACME_HTTP_PORT 换端口），并确保域名解析指向本机`,
        );
        err.statusCode = 400;
        throw err;
      }
    }
  }

  const client = new AcmeClient(loadOrCreateKey(ACCOUNT_KEY_FILE), currentDirectoryUrl());
  await client.init();
  const email =
    contactEmail || String(getSetting<string>('acme.contactEmail') || '') || `admin@${domains[0].replace(/^\*\./, '')}`;
  await client.ensureAccount(email);

  const order = await client.newOrder(domains);
  const authorizations: string[] = order.authorizations || [];
  // 逐授权完成挑战：通配符域名走 dns-01（写 TXT → 等生效 → 应答 → 清理），其余走 http-01
  for (const authzUrl of authorizations) {
    const authz = await client.fetchAsGet(authzUrl);
    if (authz?.status === 'valid') continue;
    const identifierValue: string = authz?.identifier?.value || '';
    const challenges: any[] = authz?.challenges || [];

    if (isWildcard(identifierValue)) {
      const challenge = challenges.find((c) => c.type === 'dns-01');
      if (!challenge) throw new Error(`域名 ${identifierValue} 授权中未提供 dns-01 挑战`);
      const keyAuth = client.keyAuthorization(challenge.token);
      const record = await createTxtRecord(dnsProvider, dnsToken, identifierValue, dnsTxtValue(keyAuth));
      try {
        await waitTxtVisible(identifierValue, dnsTxtValue(keyAuth));
        await client.respondChallenge(challenge.url);
        const polled = await client.pollUntilValid(authzUrl);
        if (polled?.status !== 'valid') {
          throw new Error(`域名 ${identifierValue} DNS-01 验证未通过：${polled?.status}`);
        }
      } finally {
        await record.cleanup();
      }
    } else {
      const challenge = challenges.find((c) => c.type === 'http-01');
      if (!challenge) throw new Error(`域名 ${identifierValue} 授权中未提供 http-01 挑战`);
      putChallenge(challenge.token, client.keyAuthorization(challenge.token));
      await client.respondChallenge(challenge.url);
      const polled = await client.pollUntilValid(authzUrl);
      if (polled?.status !== 'valid') {
        throw new Error(`域名 ${identifierValue} 验证未通过：${polled?.status}`);
      }
    }
  }

  // CSR → finalize → 下载
  const certKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const csr = buildCsr({ domains, privateKey: certKey });
  const certUrl = await client.finalize(order.finalize, csr);
  const certPem = await client.downloadCertificate(certUrl);
  const keyPem = certKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  // 落盘（命名与站点反代 cert_path 推导规则一致：<主域名>.pem / <主域名>.key）
  const dir = path.join(CERTS_DIR, domains[0]);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${domains[0]}.pem`), certPem, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, `${domains[0]}.key`), keyPem, { mode: 0o600 });

  // 写库（主域名唯一，重复签发即覆盖）
  const now = Date.now();
  const expiresAt = parseExpiresAt(certPem);
  getDb()
    .prepare(
      `INSERT INTO ssl_certs (id, domains, cert_pem, key_pem, source, issued_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'acme', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET domains = excluded.domains, cert_pem = excluded.cert_pem,
         key_pem = excluded.key_pem, issued_at = excluded.issued_at, expires_at = excluded.expires_at`,
    )
    .run(domains[0], JSON.stringify(domains), certPem, keyPem, now, expiresAt, now);

  return { domains, issuedAt: now, expiresAt, certPem, keyPem };
}

/** 判断证书是否需要续期 */
export function needsRenewal(expiresAt: number): boolean {
  return expiresAt - Date.now() < RENEW_BEFORE_DAYS * 24 * 3600 * 1000;
}

/**
 * 执行一轮续期巡检：对所有剩余有效期不足 30 天的 ACME 证书重新签发
 * @returns 续期结果明细（成功 / 失败原因）
 */
export async function renewDueCertificates(): Promise<Array<{ domain: string; ok: boolean; detail: string }>> {
  const rows = getDb()
    .prepare("SELECT id, domains, expires_at FROM ssl_certs WHERE source = 'acme'")
    .all() as unknown as Array<{ id: string; domains: string; expires_at: number }>;
  const results: Array<{ domain: string; ok: boolean; detail: string }> = [];
  for (const row of rows || []) {
    if (!needsRenewal(row.expires_at)) continue;
    let domains: string[] = [];
    try {
      domains = JSON.parse(row.domains);
    } catch {
      domains = [row.id];
    }
    try {
      await issueCertificate(domains, '');
      results.push({ domain: row.id, ok: true, detail: '续期成功' });
    } catch (err: any) {
      results.push({ domain: row.id, ok: false, detail: String(err?.message || err) });
    }
  }
  return results;
}

/** 当前 ACME 目录地址（设置可覆盖，前端展示用） */
export function currentDirectoryUrl(): string {
  return String(getSetting<string>('acme.directoryUrl') || '').trim() || DEFAULT_DIRECTORY_URL;
}
