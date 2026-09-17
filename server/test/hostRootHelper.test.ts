/**
 * Docker 助手容器提权参数单元测试（1.75.4）：
 * docker CLI 拒绝把管道 stdin 挂到 -t 容器——交互模式只保留 -i，
 * PTY 由 innerCmd 内的宿主机 script 分配；TERM 经 -e 传入。
 */
import { test } from 'node:test';
import assert = require('node:assert');
import { dockerHelperArgs } from '../src/platform/hostRoot';

const channel = { mode: 'docker' as const, dockerBin: 'docker', image: 'alpine' };

/** docker run 参数段（image 之前）；nsenter 的 -t 1 / -i 等在 image 之后，不能混入判断 */
function dockerFlags(args: string[]): string[] {
  return args.slice(0, args.indexOf(channel.image));
}

test('助手容器参数：交互模式不含 -t（stdin 为管道会被 docker CLI 拒绝）', () => {
  const args = dockerHelperArgs(channel, 'true', true);
  const flags = dockerFlags(args);
  assert.ok(flags.includes('-i'), '交互模式保留 -i');
  assert.ok(!flags.includes('-t'), '不得包含 -t');
  assert.ok(flags.includes('TERM=xterm-256color'), 'TERM 需经 -e 传入容器');
});

test('助手容器参数：单命令执行模式不注入 TERM（非交互）', () => {
  const flags = dockerFlags(dockerHelperArgs(channel, 'uname -a', false));
  assert.ok(!flags.includes('-i'));
  assert.ok(!flags.includes('-t'));
  assert.ok(!flags.includes('TERM=xterm-256color'));
});

test('助手容器参数：nsenter 进入宿主机 PID 1 并执行 innerCmd', () => {
  const args = dockerHelperArgs(channel, 'echo hi', true);
  const i = args.indexOf('nsenter');
  assert.ok(i > 0);
  assert.deepStrictEqual(args.slice(i, i + 7), ['nsenter', '-t', '1', '-m', '-u', '-i', '-n']);
  assert.strictEqual(args[args.length - 1], 'echo hi');
});
