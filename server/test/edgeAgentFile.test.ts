/**
 * Edge agent 文件与自更新（1.86.0）单元测试
 *
 * 覆盖：
 *  - parseAgentVersion：agent.js 头部版本常量解析（含畸形输入）
 *  - readAgentVersion：真实 agent 文件读取与缓存
 *  - agent.js 自更新开关常量存在性（EDGE_AUTO_UPGRADE / EDGE_RESTART 契约）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { parseAgentVersion, readAgentVersion, AGENT_DIR } from '../src/edge/agentFile';

test('parseAgentVersion: 标准格式与畸形输入', () => {
  assert.strictEqual(parseAgentVersion("const AGENT_VERSION = '1.86.0';"), '1.86.0');
  assert.strictEqual(parseAgentVersion("AGENT_VERSION='1.71.0'"), '1.71.0');
  assert.strictEqual(parseAgentVersion("AGENT_VERSION =  '2.0.0' "), '2.0.0');
  // 畸形：无版本号、无声明、双引号不匹配旧契约
  assert.strictEqual(parseAgentVersion('const AGENT_VERSION;'), '');
  assert.strictEqual(parseAgentVersion(''), '');
  assert.strictEqual(parseAgentVersion('AGENT_VERSION = "1.0.0";'), '');
});

test('readAgentVersion: 读取真实 agent 文件并缓存', () => {
  const v = readAgentVersion();
  assert.ok(/^\d+\.\d+\.\d+$/.test(v), '应解析出语义化版本，实际: ' + v);
  // 缓存后再次读取一致
  assert.strictEqual(readAgentVersion(), v);
  // AGENT_DIR 指向真实 agent 目录
  assert.ok(fs.existsSync(path.join(AGENT_DIR, 'agent.js')));
  assert.ok(fs.existsSync(path.join(AGENT_DIR, 'install.sh')));
});

test('agent.js 自更新契约：自动升级开关与 spawn 兜底', () => {
  const code = fs.readFileSync(path.join(AGENT_DIR, 'agent.js'), 'utf8');
  // 握手回包触发自动升级
  assert.ok(code.includes("msg.type === 'welcome'"), '应处理 welcome 握手回包');
  assert.ok(code.includes('EDGE_AUTO_UPGRADE'), '应支持 EDGE_AUTO_UPGRADE 关闭自动升级');
  assert.ok(code.includes('EDGE_RESTART'), '应支持 EDGE_RESTART 重启模式');
  assert.ok(code.includes("=== 'spawn'"), '应实现 spawn 自拉起模式');
  // 自动升级冷却，防版本异常时反复覆盖
  assert.ok(code.includes('lastAutoUpgradeAt'), '应有自动升级冷却');
  // 手动升级指令保持兼容
  assert.ok(code.includes("'/agent/upgrade'"), '应保留手动升级指令');
});
