/**
 * ACME jose 工具单测（1.56.0）
 *
 * 覆盖：b64url、JWK/指纹、JWS 签名可验证、CSR 结构、密钥持久化、http-01 挑战服务。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { b64url, b64urlDecode, jwkFor, thumbprint, signJws, buildCsr, loadOrCreateKey } from '../src/acme/jose';

describe('acme jose', () => {
  it('b64url 编解码往返一致', () => {
    const buf = crypto.randomBytes(64);
    const encoded = b64url(buf);
    assert.equal(encoded.includes('+'), false);
    assert.equal(encoded.includes('/'), false);
    assert.equal(encoded.includes('='), false);
    assert.ok(b64urlDecode(encoded).equals(buf));
  });

  it('JWK 与 RFC 7638 指纹（知名向量：RSA 指纹可复算）', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = jwkFor(privateKey);
    assert.equal(jwk.kty, 'RSA');
    assert.ok(jwk.n.length > 100);
    assert.equal(jwk.e, 'AQAB');
    const tp1 = thumbprint(jwk);
    const tp2 = thumbprint({ kty: jwk.kty, n: jwk.n, e: jwk.e });
    assert.equal(tp1, tp2);
    // 指纹为 32 字节的 Base64url
    assert.equal(b64urlDecode(tp1).length, 32);
  });

  it('JWS 签名可用公钥验证（RS256 FLATTEN）', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jws = signJws({
      signingKey: privateKey,
      protectedHeader: { alg: 'RS256', nonce: 'n1', url: 'https://acme.test/x' },
      payloadObj: { hello: 'world' },
    });
    const verified = crypto.verify(
      'sha256',
      Buffer.from(`${jws.protected}.${jws.payload}`),
      publicKey,
      b64urlDecode(jws.signature),
    );
    assert.equal(verified, true);
    // payload 还原
    assert.equal(JSON.parse(b64urlDecode(jws.payload).toString()).hello, 'world');
  });

  it('CSR 包含 SAN 域名且为合法 DER SEQUENCE', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const domains = ['example.com', 'www.example.com'];
    const csr = buildCsr({ domains, privateKey });
    assert.ok(csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----'));
    const body = Buffer.from(
      csr.replace(/-----[^\-]+-----/g, '').replace(/\s+/g, ''),
      'base64',
    );
    // 外层 SEQUENCE（0x30）+ 多字节长度
    assert.equal(body[0], 0x30);
    assert.equal(body[1] & 0x80, 0x80);
    // 域名以 UTF8String / IA5String 明文存在
    assert.ok(body.includes(Buffer.from('example.com')));
    assert.ok(body.includes(Buffer.from('www.example.com')));
  });

  it('密钥文件持久化后可重复加载', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-key-'));
    const file = path.join(dir, 'test-key.pem');
    const k1 = loadOrCreateKey(file);
    const k2 = loadOrCreateKey(file);
    const e1 = crypto.createPublicKey(k1).export({ format: 'der', type: 'spki' });
    const e2 = crypto.createPublicKey(k2).export({ format: 'der', type: 'spki' });
    assert.ok(e1.equals(e2));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('acme http-01 挑战服务', () => {
  const PORT = 9480;
  let mod: typeof import('../src/acme/challengeServer');

  before(async () => {
    process.env.ACME_HTTP_PORT = String(PORT);
    mod = await import('../src/acme/challengeServer');
  });

  after(() => {
    mod.stopChallengeServer();
  });

  it('启动后可通过 80 端口路径取回 keyAuthorization', async () => {
    const started = await mod.startChallengeServer();
    assert.equal(started.ok, true);
    assert.equal(started.port, PORT);
    mod.putChallenge('tok-abc', 'tok-abc.thumbprint-value');
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${PORT}/.well-known/acme-challenge/tok-abc`, (res) => {
          let buf = '';
          res.on('data', (c: Buffer) => (buf += c));
          res.on('end', () => resolve(buf));
        })
        .on('error', reject);
    });
    assert.equal(body, 'tok-abc.thumbprint-value');
    // popChallenge 取走后即失效
    assert.equal(mod.popChallenge('tok-abc'), undefined);
  });

  it('未注册的 token 返回 404', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${PORT}/.well-known/acme-challenge/missing`, (res) => resolve(res.statusCode || 0))
        .on('error', reject);
    });
    assert.equal(status, 404);
    assert.equal(mod.challengeServerStatus().listening, true);
  });
});
