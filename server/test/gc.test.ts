/**
 * 镜像 GC 策略（gc.ts planGc）单元测试（node:test，零第三方依赖）
 * 覆盖：keepPerRepo / olderThanDays / 悬空清理 / 在用保护 / 兜底提示
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { planGc, bytesText, type GcImage } from '../src/gc';

const now = Math.floor(Date.now() / 1000);

function img(partial: Partial<GcImage>): GcImage {
  return {
    id: 'i' + Math.random().toString(36).slice(2, 10),
    repoTags: [],
    created: now,
    size: 100,
    usedByContainers: false,
    ...partial,
  };
}

test('keepPerRepo 仅保留最近 N 个标签', () => {
  // 同一 repo 三个版本，keep=2 应保留最近 2 个，1 个为候选
  const images: GcImage[] = [
    img({ id: 'a', repoTags: ['nginx:1.20'], created: now - 86400 * 30 }),
    img({ id: 'b', repoTags: ['nginx:1.21'], created: now - 86400 * 10 }),
    img({ id: 'c', repoTags: ['nginx:1.22'], created: now }),
  ];
  const plan = planGc(images, { keepPerRepo: 2 });
  assert.strictEqual(plan.candidates.length, 1);
  assert.strictEqual(plan.candidates[0].id, 'a');
});

test('被容器引用的镜像永远不删', () => {
  const images: GcImage[] = [
    img({ id: 'used', repoTags: ['nginx:1.22'], created: now - 86400 * 300, usedByContainers: true }),
    img({ id: 'free', repoTags: ['nginx:1.20'], created: now - 86400 * 300 }),
  ];
  const plan = planGc(images, { olderThanDays: 1, pruneDangling: true });
  // used 不会出现在候选
  assert.ok(!plan.candidates.some((c) => c.id === 'used'));
  // used 出现在 keepers + skipped（有原因）
  assert.ok(plan.keepers.some((k) => k.id === 'used'));
  assert.ok(plan.skipped.some((s) => s.reason.includes('有容器引用')));
  // free 超龄进入候选
  assert.ok(plan.candidates.some((c) => c.id === 'free'));
});

test('olderThanDays 清理超龄且闲置镜像', () => {
  const old = img({ id: 'old', repoTags: ['redis:7'], created: now - 86400 * 40, lastPullAt: now - 86400 * 40 });
  const fresh = img({ id: 'fresh', repoTags: ['redis:7'], created: now - 86400 * 1 });
  const plan = planGc([old, fresh], { olderThanDays: 30 });
  assert.strictEqual(plan.candidates.length, 1);
  assert.strictEqual(plan.candidates[0].id, 'old');
});

test('近期拉取的镜像不因旧创建时间被清理', () => {
  // 创建很旧但最近拉过（lastPullAt 新），不应按 olderThanDays 清理
  const old = img({ id: 'pulled', repoTags: ['ubuntu:22.04'], created: now - 86400 * 300, lastPullAt: now - 86400 * 2 });
  const plan = planGc([old], { olderThanDays: 30 });
  assert.strictEqual(plan.candidates.length, 0);
});

test('pruneDangling 清理悬空镜像', () => {
  const dangling = img({ id: 'd', repoTags: [], created: now - 100 });
  const tagged = img({ id: 't', repoTags: ['hello:latest'], created: now - 100 });
  const plan = planGc([dangling, tagged], { pruneDangling: true });
  assert.strictEqual(plan.candidates.length, 1);
  assert.strictEqual(plan.candidates[0].id, 'd');
});

test('无候选时给出兜底提示', () => {
  const images: GcImage[] = [img({ id: 'x', repoTags: ['x:1'], created: now, usedByContainers: true })];
  const plan = planGc(images, { olderThanDays: 1 });
  assert.strictEqual(plan.candidates.length, 0);
  assert.ok(plan.warnings.length > 0);
});

test('bytesText 人类可读', () => {
  assert.strictEqual(bytesText(0), '0 B');
  assert.strictEqual(bytesText(1024), '1.0 KB');
  assert.strictEqual(bytesText(1024 * 1024), '1.0 MB');
});
