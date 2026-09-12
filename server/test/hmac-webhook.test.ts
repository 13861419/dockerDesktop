import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyHubSignature } from '../src/routes/webhook';

describe('verifyHubSignature', () => {
  const SECRET = 'my-webhook-secret';
  const BODY = Buffer.from(JSON.stringify({ action: 'push', zen: 'test' }));

  it('有效的 sha256= 签名通过校验', () => {
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(BODY).digest('hex');
    assert.equal(verifyHubSignature(SECRET, BODY, sig), true);
  });

  it('签名与密钥不匹配返回 false', () => {
    const sig = 'sha256=' + createHmac('sha256', 'wrong-secret').update(BODY).digest('hex');
    assert.equal(verifyHubSignature(SECRET, BODY, sig), false);
  });

  it('请求体被篡改返回 false', () => {
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(BODY).digest('hex');
    const tampered = Buffer.from(JSON.stringify({ action: 'push', zen: 'evil' }));
    assert.equal(verifyHubSignature(SECRET, tampered, sig), false);
  });

  it('缺少 sha256= 前缀的签名返回 false', () => {
    const hex = createHmac('sha256', SECRET).update(BODY).digest('hex');
    assert.equal(verifyHubSignature(SECRET, BODY, hex), false);
  });

  it('非法十六进制签名返回 false', () => {
    assert.equal(verifyHubSignature(SECRET, BODY, 'sha256=' + 'g'.repeat(64)), false);
    assert.equal(verifyHubSignature(SECRET, BODY, 'sha256=abcd'), false);
  });

  it('空请求体返回 false', () => {
    const sig = 'sha256=' + createHmac('sha256', SECRET).update('').digest('hex');
    assert.equal(verifyHubSignature(SECRET, undefined, sig), false);
    assert.equal(verifyHubSignature(SECRET, Buffer.alloc(0), sig), false);
  });

  it('大写十六进制签名可校验（容错）', () => {
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(BODY).digest('hex').toUpperCase();
    assert.equal(verifyHubSignature(SECRET, BODY, sig), true);
  });

  it('sha1 签名（长度不足）返回 false', () => {
    const sig = 'sha1=' + createHmac('sha1', SECRET).update(BODY).digest('hex');
    assert.equal(verifyHubSignature(SECRET, BODY, sig), false);
  });
});
