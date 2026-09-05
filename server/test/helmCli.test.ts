/**
 * 1.23.0 Helm CLI 集成单测：参数白名单校验（不依赖 helm 二进制）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-helmcli-'));
process.env.DOCKERMANAGER_DATA = tmpData;
process.env.HELM_BIN = process.platform === 'win32' ? 'helm-not-exists-1.23' : '/nonexistent/helm-1.23';

import { initStorage, closeDb } from '../src/storage';
import { helmInstall } from '../src/k8s/helmCli';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('helmCli: release 名称 / 命名空间 / chart 非法字符被拒绝', async () => {
  await assert.rejects(
    () => helmInstall({ name: 'bad name; rm -rf', namespace: 'default', chart: 'nginx' }),
    /invalid release name/,
  );
  await assert.rejects(
    () => helmInstall({ name: 'app', namespace: '../etc', chart: 'nginx' }),
    /invalid namespace/,
  );
  await assert.rejects(
    () => helmInstall({ name: 'app', namespace: 'default', chart: 'nginx $(id)' }),
    /invalid chart/,
  );
  await assert.rejects(
    () => helmInstall({ name: 'app', namespace: 'default', chart: 'nginx', version: '1.0.0; evil' }),
    /invalid chart version/,
  );
  await assert.rejects(
    () => helmInstall({ name: 'app', namespace: 'default', chart: 'nginx', setArgs: { 'a b': '1' } }),
    /invalid set key/,
  );
});

test('helmCli: 合法参数不触发参数校验错误（helm 缺失时为 ENOENT 类错误）', async () => {
  // HELM_BIN 指向不存在的可执行文件：参数校验已通过，报 ENOENT
  await assert.rejects(
    () => helmInstall({ name: 'app-1', namespace: 'ns-1', chart: 'stable/nginx-1.2' }),
    (err: Error) => /ENOENT|not exists/i.test(err.message),
  );
});
