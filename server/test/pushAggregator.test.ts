/**
 * 告警推送窗口聚合器（pushAggregator）单元测试
 *
 * 运行：npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createPushAggregator, buildDigestText } from '../src/pushAggregator';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('buildDigestText：最多展示 5 条并附总条数', () => {
  const msgs = Array.from({ length: 7 }, (_, i) => `告警${i + 1}`);
  const text = buildDigestText(msgs);
  assert.ok(text.includes('共 7 条'));
  assert.ok(text.includes('• 告警1'));
  assert.ok(text.includes('• 告警5'));
  assert.ok(!text.includes('• 告警6'));
  assert.ok(text.includes('…等共 7 条'));
});

test('窗口关闭（0）时逐条即时推送并回传结果', async () => {
  const sent: string[] = [];
  const agg = createPushAggregator(
    async (text) => {
      sent.push(text);
      return { ok: true };
    },
    () => 0,
  );
  const r1 = await agg.queue('warn', 'A');
  const r2 = await agg.queue('danger', 'B');
  assert.strictEqual(r1.status, 'ok');
  assert.strictEqual(r2.status, 'ok');
  assert.deepStrictEqual(sent, ['A', 'B']);
  assert.strictEqual(agg.pendingCount(), 0);
});

test('recovery 即时推送，不进入聚合窗口', async () => {
  const sent: string[] = [];
  const agg = createPushAggregator(
    async (text) => {
      sent.push(text);
      return { ok: true };
    },
    () => 60_000,
  );
  const r = await agg.queue('recovery', '已恢复');
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(sent, ['已恢复']);
  assert.strictEqual(agg.pendingCount(), 0);
});

test('窗口内多条 warn/danger 合并为一条摘要', async () => {
  const sent: string[] = [];
  const agg = createPushAggregator(
    async (text) => {
      sent.push(text);
      return { ok: true };
    },
    () => 200,
  );
  await agg.queue('danger', '容器 a 已退出');
  await agg.queue('warn', '容器 b 重启循环');
  await agg.queue('danger', '容器 c 不存在');
  assert.strictEqual(agg.pendingCount(), 3);
  await agg.flush();
  assert.strictEqual(sent.length, 1, '应只发送一条聚合消息');
  assert.ok(sent[0].includes('共 3 条'));
  assert.ok(sent[0].includes('容器 a 已退出'));
  assert.ok(sent[0].includes('容器 b 重启循环'));
  assert.ok(sent[0].includes('容器 c 不存在'));
  assert.strictEqual(agg.pendingCount(), 0);
});

test('窗口到期自动 flush（单条原样）', async () => {
  const sent: string[] = [];
  const agg = createPushAggregator(
    async (text) => {
      sent.push(text);
      return { ok: true };
    },
    () => 150,
  );
  await agg.queue('danger', '单条窗口消息');
  assert.strictEqual(sent.length, 0);
  await sleep(400);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0], '单条窗口消息');
});

test('send 抛错时即时路径返回 failed', async () => {
  const agg = createPushAggregator(
    async () => {
      throw new Error('网络不可达');
    },
    () => 0,
  );
  const r = await agg.queue('danger', 'x');
  assert.strictEqual(r.status, 'failed');
  assert.ok(String(r.detail).includes('网络不可达'));
});

test('聚合发送抛错被吞掉且缓冲清空（不重投）', async () => {
  let shouldThrow = true;
  const agg = createPushAggregator(
    async () => {
      if (shouldThrow) throw new Error('down');
      return { ok: true };
    },
    () => 100,
  );
  await agg.queue('danger', 'm1');
  await agg.queue('danger', 'm2');
  await agg.flush();
  assert.strictEqual(agg.pendingCount(), 0);
  shouldThrow = false;
  await agg.flush();
  assert.strictEqual(agg.pendingCount(), 0);
});
