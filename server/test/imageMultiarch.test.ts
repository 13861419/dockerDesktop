/**
 * buildx 多架构构建单元测试（1.83.0）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { normalizePlatforms, needsEmulation, buildBuildxArgs, DM_BUILDX_BUILDER, evalImageTag } from '../src/routes/deploys';

test('normalizePlatforms: 白名单过滤、去重、去空、小写归一', () => {
  assert.deepStrictEqual(normalizePlatforms(['linux/amd64', 'linux/ARM64', '  linux/arm64 ', '', 'linux/evil', null]), [
    'linux/amd64',
    'linux/arm64',
  ]);
  assert.deepStrictEqual(normalizePlatforms('linux/amd64'), []);
  assert.deepStrictEqual(normalizePlatforms(undefined), []);
  assert.deepStrictEqual(normalizePlatforms([]), []);
});

test('needsEmulation: 目标平台与宿主机架构不同即需要 QEMU', () => {
  assert.strictEqual(needsEmulation(['linux/amd64'], 'x64'), false);
  assert.strictEqual(needsEmulation(['linux/amd64', 'linux/arm64'], 'x64'), true);
  assert.strictEqual(needsEmulation(['linux/arm64'], 'arm64'), false);
  assert.strictEqual(needsEmulation([], 'x64'), false);
});

test('buildBuildxArgs: 组装 buildx 参数（双 tag + --push）', () => {
  const args = buildBuildxArgs({
    platforms: ['linux/amd64', 'linux/arm64'],
    imageName: 'harbor.example.com/team/myapp',
    tag: 'main-abc1234',
    dockerfile: '/repos/myapp/Dockerfile',
    context: '/repos/myapp',
    builder: DM_BUILDX_BUILDER,
  });
  assert.deepStrictEqual(args, [
    'buildx',
    'build',
    '--builder',
    'dm-multiarch',
    '--platform',
    'linux/amd64,linux/arm64',
    '-f',
    '/repos/myapp/Dockerfile',
    '-t',
    'harbor.example.com/team/myapp:main-abc1234',
    '-t',
    'harbor.example.com/team/myapp:latest',
    '--push',
    '/repos/myapp',
  ]);
});

test('evalImageTag: 多架构路径沿用同一 tag 模板', () => {
  assert.strictEqual(evalImageTag('{branch}-{sha7}', 'main', 'abcdef12345'), 'main-abcdef1');
  assert.strictEqual(evalImageTag(null, 'dev', '1234567890'), 'dev-1234567');
});
