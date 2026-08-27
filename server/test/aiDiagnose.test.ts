/**
 * AI 告警诊断模块（aiDiagnose）单元测试（node:test）
 * 覆盖：buildDiagnosePrompt 纯函数
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';

// 隔离临时数据目录（须在 import storage 前设置）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-aidiag-'));
process.env.DOCKERMANAGER_DATA = tmpData;

import { initStorage, closeDb } from '../src/storage';
import { buildDiagnosePrompt } from '../src/aiDiagnose';

before(() => {
  initStorage();
});

after(() => {
  closeDb();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('buildDiagnosePrompt 包含告警上下文与快照', () => {
  const prompt = buildDiagnosePrompt(
    { type: 'cpu', level: 'danger', message: 'CPU 使用率过高：95%', value: 95 },
    '- web | nginx | running | Up 1h',
  );
  assert.ok(prompt.includes('cpu'));
  assert.ok(prompt.includes('danger'));
  assert.ok(prompt.includes('CPU 使用率过高：95%'));
  assert.ok(prompt.includes('95'));
  assert.ok(prompt.includes('- web | nginx | running | Up 1h'));
  assert.ok(prompt.includes('可能根因'));
  assert.ok(prompt.includes('处理建议'));
});

test('buildDiagnosePrompt 数值为 null 时正常渲染', () => {
  const prompt = buildDiagnosePrompt(
    { type: 'task', level: 'danger', message: '任务失败', value: null },
    '（无法获取容器快照）',
  );
  assert.ok(prompt.includes('-'));
  assert.ok(prompt.includes('任务失败'));
});
