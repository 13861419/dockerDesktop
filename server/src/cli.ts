/**
 * 面板管理 CLI（管理员找回等本地运维命令）
 *
 * 用法（构建后，须先停止面板服务）：
 *   node dist/cli.js list-users
 *   node dist/cli.js unlock --user admin
 *   node dist/cli.js reset-admin --user admin [--disable-totp] [--password-stdin]
 *
 * 典型场景：
 *  - 管理员忘记密码 / 连续失败被锁定 → reset-admin（或仅 unlock）
 *  - 2FA 认证器设备丢失（手机更换） → reset-admin --disable-totp
 *
 * 安全边界：本命令仅应在面板宿主机本地执行（拥有本地执行权者本可直接
 * 读取数据库文件，故不另设鉴权）。密码不进命令行参数（防 shell history
 * 泄露），支持管道输入或隐藏回显交互输入。所有操作写入操作日志留痕。
 */
import crypto from 'crypto';
import net from 'net';
import { initStorage, getDb, closeDb } from './storage';
import { validatePasswordPolicy } from './security';
import { hashPassword, setTotpSecret } from './users';
import { logOperation } from './operationLog';

/** 运行时 IO 注入（测试用），生产直连真实 stdin */
export interface CliIo {
  /** 预置 stdin 内容（配合 --password-stdin 的测试注入） */
  stdin?: string;
  /** 是否探测面板服务端口是否在运行（默认 true，测试可关） */
  checkPort?: boolean;
}

interface ParsedArgs {
  cmd: string;
  user?: string;
  disableTotp: boolean;
  passwordStdin: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = '', ...rest] = argv;
  const parsed: ParsedArgs = { cmd, disableTotp: false, passwordStdin: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--user') parsed.user = rest[++i];
    else if (rest[i] === '--disable-totp') parsed.disableTotp = true;
    else if (rest[i] === '--password-stdin') parsed.passwordStdin = true;
  }
  return parsed;
}

/** 尽力探测面板服务是否正在运行（端口连通即视为在运行） */
function isServerLikelyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const port = Number(process.env.PORT) || 9528;
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(250);
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** 从管道读取密码（--password-stdin） */
function readStdinPiped(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.resume();
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

/** 隐藏回显的交互式密码输入（Windows/Linux 原始终端模式） */
function readHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const chars: string[] = [];
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (ch: Buffer) => {
      const c = ch.toString('utf8');
      if (c === '\r' || c === '\n') {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(chars.join(''));
      } else if (c === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (c === '\u007f' || c === '\b') {
        chars.pop();
      } else {
        chars.push(c);
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

function printUsage(): void {
  console.log('面板管理 CLI');
  console.log('');
  console.log('用法：node dist/cli.js <子命令> [选项]');
  console.log('');
  console.log('子命令：');
  console.log('  list-users                       列出用户（用户名/角色/2FA/锁定状态）');
  console.log('  unlock --user <name>             清除账号登录锁定');
  console.log('  reset-admin --user <name>        重置密码并清除锁定（下次登录强制改密）');
  console.log('    [--disable-totp]               同时关闭该账号两步验证（认证器丢失时）');
  console.log('    [--password-stdin]             从管道读取新密码（推荐），缺省交互输入');
  console.log('');
  console.log('示例：echo "NewPass123" | node dist/cli.js reset-admin --user admin --password-stdin');
}

/** 查询用户行，不存在时返回 null（由调用方打印错误并返回退出码） */
function findUser(username: string): { username: string } | null {
  const row = getDb().prepare('SELECT username FROM users WHERE username = ?').get(username) as
    | { username: string }
    | undefined;
  return row ?? null;
}

/**
 * CLI 主逻辑（返回进程退出码）
 * @param argv 命令行参数（不含 node 与脚本路径）
 * @param io IO 注入（测试用）
 */
export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const args = parseArgs(argv);
  if (!args.cmd) {
    printUsage();
    return 1;
  }
  initStorage();
  if (io.checkPort !== false && (await isServerLikelyRunning())) {
    console.warn('警告：检测到面板服务可能正在运行，建议先停止服务（NSSM stop DockerManager）再执行本命令。');
  }

  if (args.cmd === 'list-users') {
    const rows = getDb()
      .prepare('SELECT username, role, totp_enabled, locked_until FROM users ORDER BY username')
      .all() as Array<{ username: string; role: string; totp_enabled: number | null; locked_until: number | null }>;
    console.log('用户名'.padEnd(20) + '角色'.padEnd(10) + '两步验证'.padEnd(10) + '锁定中');
    for (const r of rows) {
      const locked = r.locked_until && r.locked_until > Date.now() ? '是' : '否';
      console.log(
        r.username.padEnd(20) + r.role.padEnd(10) + (r.totp_enabled ? '已启用' : '未启用').padEnd(10) + locked,
      );
    }
    return 0;
  }

  if (args.cmd === 'unlock') {
    if (!args.user) {
      console.error('错误：缺少 --user 参数');
      return 1;
    }
    if (!findUser(args.user)) {
      console.error(`错误：用户 "${args.user}" 不存在`);
      return 1;
    }
    getDb()
      .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = ?')
      .run(args.user);
    logOperation(args.user, 'CLI 解除账号锁定', 'system', args.user);
    console.log(`已清除账号 "${args.user}" 的登录锁定。`);
    return 0;
  }

  if (args.cmd === 'reset-admin') {
    if (!args.user) {
      console.error('错误：缺少 --user 参数');
      return 1;
    }
    if (!findUser(args.user)) {
      console.error(`错误：用户 "${args.user}" 不存在`);
      return 1;
    }
    let password = '';
    if (args.passwordStdin) {
      password = io.stdin !== undefined ? io.stdin : await readStdinPiped();
    } else {
      password = await readHidden('请输入新密码（输入不回显）：');
    }
    if (!password) {
      console.error('错误：密码不能为空');
      return 1;
    }
    try {
      validatePasswordPolicy(password);
    } catch (err: any) {
      console.error(`错误：${err?.message || '密码不符合安全策略'}`);
      return 1;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    getDb()
      .prepare(
        'UPDATE users SET salt = ?, password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL WHERE username = ?',
      )
      .run(salt, hashPassword(password, salt), args.user);
    if (args.disableTotp) {
      setTotpSecret(args.user, null);
    }
    logOperation(args.user, 'CLI 重置管理员密码', 'system', args.user);
    console.log(`已重置账号 "${args.user}" 的密码并清除登录锁定。`);
    if (args.disableTotp) console.log('已关闭该账号的两步验证（2FA）。');
    console.log('该账号下次登录时将被要求修改密码。');
    return 0;
  }

  printUsage();
  return 1;
}

/** 进程入口：仅在直接执行本脚本时运行（被 import 时不启动） */
export function main(): void {
  runCli(process.argv.slice(2))
    .then((code) => {
      closeDb();
      process.exit(code);
    })
    .catch((err) => {
      console.error('执行失败:', err);
      closeDb();
      process.exit(1);
    });
}

// 通过 ts-node/dist 直接执行时才运行业务逻辑
if (require.main === module) {
  main();
}
