/**
 * B1「镜像漏洞扫描」单元测试（node:test，零第三方依赖）
 * 覆盖：image name 安全校验；Trivy JSON 解析标准化与 severity 归类
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { assertSafeImageName, parseTrivyOutput } from '../src/trivyCli';

test('assertSafeImageName 拒绝含 shell 元字符的镜像名', () => {
  assert.doesNotThrow(() => assertSafeImageName('nginx:latest'));
  assert.doesNotThrow(() => assertSafeImageName('registry.example.com/myapp:v1.0'));
  assert.throws(() => assertSafeImageName('nginx;rm -rf /'), /非法/);
  assert.throws(() => assertSafeImageName('img" && whoami'), /非法/);
  assert.throws(() => assertSafeImageName('a|b'), /非法/);
  assert.throws(() => assertSafeImageName('-leading'), /连字符/);
});

test('parseTrivyOutput 解析多 target 多漏洞并正确归类', () => {
  const json = JSON.stringify({
    Results: [
      {
        Target: 'nginx:latest (debian 12.6)',
        Vulnerabilities: [
          { VulnerabilityID: 'CVE-2025-1001', Severity: 'CRITICAL', PkgName: 'libc6', InstalledVersion: '2.36', FixedVersion: '2.36-9', Title: 'Critical libc overflow', Description: 'long desc', References: ['https://example.com/cve1'] },
          { VulnerabilityID: 'CVE-2025-2002', Severity: 'HIGH', PkgName: 'openssl', InstalledVersion: '3.0.13', FixedVersion: '', Title: 'ssl issue' },
        ],
      },
      {
        Target: 'go.mod',
        Vulnerabilities: [
          { VulnerabilityID: 'CVE-2025-3003', Severity: 'MEDIUM', PkgName: 'golang.org/x/text', InstalledVersion: 'v0.3.0' },
        ],
      },
    ],
  });
  const scan = parseTrivyOutput(json);
  assert.strictEqual(scan.available, true);
  assert.ok(scan.scannedAt);
  assert.deepStrictEqual(scan.summary, { critical: 1, high: 1, medium: 1, low: 0, unknown: 0 });
  assert.strictEqual(scan.vulnerabilities!.length, 3);
  const cve1 = scan.vulnerabilities![0];
  assert.strictEqual(cve1.id, 'CVE-2025-1001');
  assert.strictEqual(cve1.severity, 'CRITICAL');
  assert.strictEqual(cve1.pkgName, 'libc6');
  assert.strictEqual(cve1.fixedVersion, '2.36-9');
  assert.ok(cve1.refs && cve1.refs[0].startsWith('https://'));
});

test('parseTrivyOutput 无漏洞时返回空列表与全 0', () => {
  const scan = parseTrivyOutput('{"Results": []}');
  assert.strictEqual(scan.available, true);
  assert.deepStrictEqual(scan.summary, { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
  assert.strictEqual((scan.vulnerabilities || []).length, 0);
});
