/**
 * 安全基线规则引擎单元测试
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { checkContainer, POLICY_RULES } from '../src/policy';

/** 构造最小合法容器 inspect 对象（全部基线合规） */
function compliant(extra: any = {}): any {
  return {
    Name: '/web',
    HostConfig: {
      Privileged: false,
      Memory: 536870912,
      NanoCpus: 1000000000,
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: [],
      Mounts: [],
    },
    Config: { Labels: { owner: 'ops' } },
    ...extra,
  };
}

test('checkContainer：合规容器零违规', () => {
  assert.deepStrictEqual(checkContainer(compliant()), []);
});

test('checkContainer：特权模式被标记', () => {
  const v = checkContainer(compliant({ HostConfig: { Privileged: true, Memory: 1, NanoCpus: 1, RestartPolicy: { Name: 'always' } } }));
  assert.ok(v.some((x) => x.ruleId === 'no-privileged'));
});

test('checkContainer：docker.sock 与根目录挂载被标记', () => {
  const base = compliant();
  base.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock', '/:/host'];
  const v = checkContainer(base);
  const hits = v.filter((x) => x.ruleId === 'no-sensitive-mount');
  assert.strictEqual(hits.length, 2);
  assert.ok(hits.some((x) => x.detail.includes('docker.sock')));
  assert.ok(hits.some((x) => x.detail.includes('/host') || x.detail.includes('挂载宿主路径 /')));
});

test('checkContainer：未设资源限制与重启策略被标记', () => {
  const base = compliant();
  base.HostConfig.Memory = 0;
  base.HostConfig.NanoCpus = 0;
  base.HostConfig.RestartPolicy = { Name: '' };
  const v = checkContainer(base);
  assert.ok(v.some((x) => x.ruleId === 'mem-limit'));
  assert.ok(v.some((x) => x.ruleId === 'cpu-limit'));
  assert.ok(v.some((x) => x.ruleId === 'restart-policy'));
});

test('checkContainer：CpuQuota 可替代 NanoCpus；缺 owner 标签被标记', () => {
  const base = compliant();
  base.HostConfig.NanoCpus = 0;
  base.HostConfig.CpuQuota = 100000;
  base.Config.Labels = {};
  const v = checkContainer(base);
  assert.ok(!v.some((x) => x.ruleId === 'cpu-limit'));
  assert.ok(v.some((x) => x.ruleId === 'owner-label'));
});

test('POLICY_RULES：规则 ID 与严重度完备', () => {
  const ids = POLICY_RULES.map((r) => r.id);
  assert.ok(ids.includes('no-privileged'));
  assert.ok(ids.includes('no-sensitive-mount'));
  assert.ok(ids.includes('mem-limit'));
  assert.ok(ids.includes('cpu-limit'));
  assert.ok(ids.includes('restart-policy'));
  assert.ok(ids.includes('owner-label'));
  for (const r of POLICY_RULES) {
    assert.ok(['danger', 'warn', 'info'].includes(r.severity));
    assert.ok(r.advice.length > 0);
  }
});
