/**
 * ACME 所需的 JOSE 与 CSR 工具（零依赖，node:crypto 实现）
 *
 *  - b64url：Base64url 编码（RFC 4648 §5，无填充）
 *  - jwkFor / thumbprint：RSA 公钥 → JWK 与 RFC 7638 指纹
 *  - signJws：RS256 FLATTEN JWS（RFC 7515）
 *  - buildCsr：手写 DER 编码的 PKCS#10 CSR（支持 SAN 多域名）
 */
import crypto from 'crypto';
import fs from 'fs';

/** Base64url 编码（无填充） */
export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Base64url 解码 */
export function b64urlDecode(str: string): Buffer {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/**
 * 从 RSA 私钥构造 JWK（n / e 均为大端无符号整数，需去掉前导零字节）
 * @param privateKey RSA 私钥对象
 * @returns RSA JWK（kty/n/e）
 */
export function jwkFor(privateKey: crypto.KeyObject): { kty: string; n: string; e: string } {
  const jwk = privateKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  return { kty: 'RSA', n: jwk.n, e: jwk.e };
}

/**
 * RFC 7638 JWK 指纹（SHA-256 Base64url），用于 ACME keyAuthorization
 * @param jwk RSA JWK
 */
export function thumbprint(jwk: { kty: string; n: string; e: string }): string {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return b64url(crypto.createHash('sha256').update(canonical).digest());
}

/**
 * 构造 RSA JWS（FLATTEN JSON 序列化，RS256）
 * @param opts.signingKey 签名私钥
 * @param opts.protectedHeader 受保护头（不含签名）
 * @param payloadObj payload 对象（POST-as-GET 时传 ''）
 * @returns FLATTEN JWS JSON
 */
export function signJws(opts: {
  signingKey: crypto.KeyObject;
  protectedHeader: Record<string, unknown>;
  payloadObj: Record<string, unknown> | string;
}): { protected: string; payload: string; signature: string } {
  const payloadStr =
    typeof opts.payloadObj === 'string' ? opts.payloadObj : JSON.stringify(opts.payloadObj);
  const protectedB64 = b64url(Buffer.from(JSON.stringify(opts.protectedHeader)));
  const payloadB64 = b64url(Buffer.from(payloadStr));
  const sigInput = Buffer.from(`${protectedB64}.${payloadB64}`);
  const sig = crypto.sign('sha256', sigInput, opts.signingKey);
  return { protected: protectedB64, payload: payloadB64, signature: b64url(sig) };
}

// ============ DER 编码（PKCS#10 CSR） ============

/** DER TLV：tag + 长度 + 内容 */
function tlv(tag: number, content: Buffer): Buffer {
  if (content.length < 128) {
    return Buffer.concat([Buffer.from([tag, content.length]), content]);
  }
  const lenBytes: number[] = [];
  let n = content.length;
  while (n > 0) {
    lenBytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | lenBytes.length]), Buffer.from(lenBytes), content]);
}

/** DER SEQUENCE */
function derSeq(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}

/** DER SET */
function derSet(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items));
}

/** DER INTEGER */
function derInt(value: number): Buffer {
  return tlv(0x02, Buffer.from([value]));
}

/** DER NULL */
function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

/** DER OBJECT IDENTIFIER */
function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack: number[] = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** DER UTF8String */
function derUtf8(str: string): Buffer {
  return tlv(0x0c, Buffer.from(str, 'utf8'));
}

/** 生成 PKCS#10 CSR（PEM），SAN 覆盖全部域名，CN 为主域名 */
export function buildCsr(opts: {
  domains: string[];
  privateKey: crypto.KeyObject;
}): string {
  const domains = opts.domains;
  const cn = domains[0];
  // Subject：CN=<主域名>
  const subject = derSeq(
    derSet(derSeq(derOid('2.5.4.3'), derUtf8(cn))),
  );
  // SPKI 直接复用 node crypto 导出（省去手写模数/指数）
  const spki = crypto.createPublicKey(opts.privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  // subjectAltName：GENERAL NAME dNSName（context tag [2] IMPLICIT IA5String）
  const generalNames = Buffer.concat(
    domains.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),
  );
  const sanOid = derOid('2.5.29.17');
  const sanExt = derSeq(
    sanOid,
    tlv(0x04, derSeq(tlv(0x30, generalNames))),
  );
  const extReqOid = derOid('1.2.840.113549.1.9.14');
  const extensionRequest = tlv(
    0xa0,
    derSeq(extReqOid, derSet(derSeq(derOid('2.5.29.17'), tlv(0x04, sanExt)))),
  );
  // CertificationRequestInfo
  const cri = derSeq(
    derInt(0),
    subject,
    tlv(0x03, Buffer.concat([Buffer.from([0x00]), spki])),
    extensionRequest,
  );
  // sha256WithRSAEncryption
  const sigAlg = derSeq(derOid('1.2.840.113549.1.1.11'), derNull());
  const signature = crypto.sign('sha256', cri, opts.privateKey);
  const csrDer = derSeq(cri, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])));
  const pem = csrDer
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim();
  return `-----BEGIN CERTIFICATE REQUEST-----\n${pem}\n-----END CERTIFICATE REQUEST-----\n`;
}

/** 生成并持久化 RSA 账户密钥 / 证书私钥（文件存在则复用） */
export function loadOrCreateKey(file: string): crypto.KeyObject {
  if (fs.existsSync(file)) {
    return crypto.createPrivateKey(fs.readFileSync(file));
  }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  return privateKey;
}
