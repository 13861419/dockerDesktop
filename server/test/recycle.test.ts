/**
 * 容器回收站模块测试
 *
 * 覆盖：
 *  1. buildCreateOptionsFromSnapshot：inspect 快照 → 安全创建参数子集
 *     （端口回退 / 重启策略 / 资源限制 / 运行时字段剔除）
 *  2. captureContainerSnapshot：捕获 + 名称清洗 + 上限裁剪（MAX_RECYCLE_RECORDS）
 *  3. listRecycle / getRecycle / deleteRecycle / purgeRecycle
 *
 * 运行：先设置临时数据目录再 import 业务模块，确保隔离。
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 必须先于 storage 模块加载设置临时数据目录，确保数据库落在隔离环境
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-recycle-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb, getDb } from '../src/storage';
import {
  buildCreateOptionsFromSnapshot,
  captureContainerSnapshot,
  listRecycle,
  getRecycle,
  deleteRecycle,
  purgeRecycle,
  MAX_RECYCLE_RECORDS,
} from '../src/recycle';

initStorage();

/** 最小 dockerode mock：仅需要 getContainer(id).inspect() */
function fakeDocker(inspectById: Record<string, any>) {
  return {
    getContainer: (id: string) => ({
      inspect: async () => inspectById[id],
    }),
  } as any;
}

/** 一个贴近真实 inspect 输出的快照样例 */
const SAMPLE_INSPECT = {
  Id: 'abc123def456',
  Name: '/web-app',
  Config: {
    Image: 'nginx:1.25',
    Env: ['A=1', 'B=2'],
    Labels: { app: 'web' },
    Cmd: ['nginx', '-g', 'daemon off;'],
    ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
    Tty: true,
    Healthcheck: { Test: ['CMD', 'curl', '-f', 'http://localhost'], Interval: 30000000000, Retries: 3 },
  },
  HostConfig: {
    Binds: ['/data:/srv:ro'],
    PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
    RestartPolicy: { Name: 'always', MaximumRetryCount: 0 },
    NetworkMode: 'bridge',
    Privileged: false,
    AutoRemove: false,
    Memory: 536870912,
    NanoCpus: 1500000000,
    // 运行时解析字段（应被剔除）
    Links: null,
    VolumeDriver: '',
  },
  NetworkSettings: { IPAddress: '172.17.0.2' },
  State: { Status: 'running' },
};

test('buildCreateOptionsFromSnapshot：还原核心创建参数', () => {
  const opts = buildCreateOptionsFromSnapshot(SAMPLE_INSPECT, 'web-app');
  assert.strictEqual(opts.name, 'web-app');
  assert.strictEqual(opts.Image, 'nginx:1.25');
  assert.deepStrictEqual(opts.Env, ['A=1', 'B=2']);
  assert.deepStrictEqual(opts.Labels, { app: 'web' });
  assert.deepStrictEqual(opts.Cmd, ['nginx', '-g', 'daemon off;']);
  assert.ok(opts.ExposedPorts && opts.ExposedPorts['80/tcp'], 'ExposedPorts 应保留');
  assert.deepStrictEqual(opts.HostConfig?.PortBindings, {
    '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
  });
  assert.deepStrictEqual(opts.HostConfig?.Binds, ['/data:/srv:ro']);
  assert.deepStrictEqual(opts.HostConfig?.RestartPolicy, { Name: 'always', MaximumRetryCount: 0 });
  assert.strictEqual(opts.HostConfig?.NetworkMode, 'bridge');
  assert.strictEqual(opts.HostConfig?.Memory, 536870912);
  assert.strictEqual(opts.HostConfig?.NanoCpus, 1500000000);
  assert.strictEqual(opts.Tty, true);
  assert.ok(opts.Healthcheck, '健康检查应保留');
});

test('buildCreateOptionsFromSnapshot：剔除运行时字段与 no 重启策略', () => {
  const opts = buildCreateOptionsFromSnapshot(SAMPLE_INSPECT, 'x') as any;
  // NetworkSettings / State 等快照专属字段不应透传
  assert.strictEqual(opts.NetworkSettings, undefined);
  assert.strictEqual(opts.State, undefined);
  assert.strictEqual(opts.HostConfig?.Links, undefined);
  assert.strictEqual(opts.HostConfig?.VolumeDriver, undefined);

  const noPolicy = buildCreateOptionsFromSnapshot(
    { Config: { Image: 'busybox' }, HostConfig: { RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } } },
    'x',
  );
  assert.strictEqual(noPolicy.HostConfig?.RestartPolicy, undefined, 'no 策略不应透传');

  // ExposedPorts 缺失时回退 PortBindings 键
  const fallback = buildCreateOptionsFromSnapshot(
    { Config: { Image: 'busybox' }, HostConfig: { PortBindings: { '22/tcp': [{ HostPort: '2222' }] } } },
    'x',
  );
  assert.deepStrictEqual(fallback.ExposedPorts, { '22/tcp': {} });
});

test('captureContainerSnapshot：捕获并清洗容器名', async () => {
  const docker = fakeDocker({ abc123: SAMPLE_INSPECT });
  const ok = await captureContainerSnapshot(docker, 'abc123', 'admin');
  assert.strictEqual(ok, true);
  const list = listRecycle();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'web-app', '名称应去掉前导斜杠');
  assert.strictEqual(list[0].image, 'nginx:1.25');
  assert.strictEqual(list[0].deleted_by, 'admin');
});

test('captureContainerSnapshot：inspect 失败不阻塞（返回 false）', async () => {
  const docker = fakeDocker({});
  const ok = await captureContainerSnapshot(docker, 'missing', 'admin');
  assert.strictEqual(ok, false);
});

test('保留上限：超出 MAX_RECYCLE_RECORDS 自动清理最旧记录', async () => {
  purgeRecycle();
  for (let i = 0; i < MAX_RECYCLE_RECORDS + 5; i++) {
    const id = 'c' + i;
    const docker = fakeDocker({ [id]: { Name: '/' + id, Config: { Image: 'busybox' } } });
    await captureContainerSnapshot(docker, id, 'admin');
  }
  const list = listRecycle();
  assert.strictEqual(list.length, MAX_RECYCLE_RECORDS);
  // 最旧的 c0..c4 应被清理，最新记录为 cMAX+4
  assert.strictEqual(list[0].name, 'c' + (MAX_RECYCLE_RECORDS + 4));
  assert.strictEqual(list.some((r) => r.name === 'c0'), false);
});

test('getRecycle / deleteRecycle / purgeRecycle', async () => {
  const first = listRecycle()[0];
  assert.ok(getRecycle(first.id), '记录应可读取');
  deleteRecycle(first.id);
  assert.strictEqual(getRecycle(first.id), undefined);
  purgeRecycle();
  assert.strictEqual(listRecycle().length, 0);
});

after(() => {
  closeDb();
});
