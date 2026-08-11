/**
 * 数据库可视化管理 API 路由
 *
 * 所有数据库都运行在 Docker 容器中，本模块不引入任何数据库驱动依赖，
 * 而是通过「docker exec 容器内官方 CLI」（mysql / psql / redis-cli）执行操作。
 * 对已登记实例：
 *  - 若 container_ref 存在，优先用 docker exec 进入该容器调用官方 CLI；
 *  - 否则回退用宿主机 CLI（execAsync 调 mysql/psql/redis-cli）。
 *
 * 口令使用 encryptSecret/decryptSecret 对称加解密（storage.ts），
 * 仅在本次命令执行时解密使用，绝不上报前端、不打日志。
 */
import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import Dockerode from 'dockerode';
import { getDockerClient } from '../docker/client';
import { getDb, encryptSecret, decryptSecret } from '../storage';
import { logOperation } from '../operationLog';
import { APP_LABEL_KEY, APP_CATALOG } from '../appstore/catalog';

const execAsync = promisify(exec);
const router = Router();

/** 允许登记的数据库类型集合（用于 POST 校验） */
const VALID_TYPES = new Set(['mysql', 'postgres', 'mariadb', 'redis']);
/** 各类型默认端口（登记时未显式提供则使用） */
const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgres: 5432,
  redis: 6379,
};
/** 应用商店中属于数据库的应用 id 集合（用于自动识别标记） */
const DB_APP_IDS = new Set(['mysql', 'postgres', 'mongo', 'mariadb', 'redis']);

/** com.dockermanager.app 标签：用于识别哪些容器是应用商店部署的应用 */
/** exec 单命令执行超时时间（毫秒） */
const EXEC_TIMEOUT_MS = 15000;

/** database_instances 表的原始行（数据库字段，snake_case） */
interface DbInstanceRow {
  id: number;
  name: string;
  type: string;
  container_ref: string | null;
  host: string;
  port: number;
  user: string | null;
  cred_encrypted: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 统一兜底错误处理，保证所有异步路由异常都能被捕获并返回 JSON。
 * 与容器/商店路由保持一致；可选的 onFail 用于写操作失败时补记一条失败审计日志。
 * @param fn 异步处理函数
 * @param onFail 失败时生成审计日志元数据（可选）
 * @returns Express 中间件
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<any>,
  onFail?: (req: Request, err: any) => { action: string; targetType: string; targetName?: string | null; detail?: string | null } | null,
) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      // 写操作失败时记录失败审计日志（不影响错误响应）
      if (onFail) {
        try {
          const meta = onFail(req, err);
          if (meta) {
            logOperation(
              res.locals.username,
              meta.action,
              meta.targetType,
              meta.targetName ?? null,
              `失败: ${meta.detail || err?.message || '未知错误'}`,
              false,
            );
          }
        } catch {
          // 记录日志失败不影响错误响应
        }
      }
      const status = err?.statusCode || (err?.statusCode === 404 ? 404 : 500);
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 为宿主机 shell 命令安全地引用单个参数（单引号包裹并把内部单引号转义）
 * @param arg 原始参数
 * @returns 可安全拼入 shell 命令的字符串
 */
function sq(arg: string): string {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/**
 * 读取数据库实例并校验存在性
 * @param id 实例 id
 * @returns 实例行；不存在时抛出 404 错误
 */
async function requireInstance(id: string): Promise<DbInstanceRow> {
  const d = getDb();
  const row = d
    .prepare('SELECT id, name, type, container_ref, host, port, user, cred_encrypted, created_at, updated_at FROM database_instances WHERE id = ?')
    .get(Number(id)) as unknown as DbInstanceRow | undefined;
  if (!row) {
    const err: any = new Error('数据库实例不存在');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

/**
 * 解密实例的口令（仅用于本次命令执行，不落地）
 * @param inst 实例行
 * @returns 明文口令，未设置时为空串
 */
function plainPwd(inst: DbInstanceRow): string {
  return decryptSecret(inst.cred_encrypted);
}

/**
 * 判断实例是否优先走容器内执行（存在 container_ref 即走容器）
 * @param inst 实例行
 * @returns 是否使用容器内 CLI
 */
function useContainer(inst: DbInstanceRow): boolean {
  return !!inst.container_ref;
}

/**
 * 在运行中的容器内执行命令，收集 stdout+stderr 文本与退出码。
 * 参照 containers.ts /exec 的剥帧（Tty=false 多路复用帧）与超时处理。
 * @param containerId 容器 id
 * @param cmd 命令参数数组（天然安全，无 shell 拼接）
 * @param env 额外环境变量（可选，如 PGPASSWORD）
 * @returns 输出文本
 * @throws 退出码非 0 或超时时抛出带输出内容的错误
 */
async function execInContainer(containerId: string, cmd: string[], env?: Record<string, string>): Promise<string> {
  const docker = await getDockerClient();
  const container = docker.getContainer(containerId);
  // 创建非交互式 exec，仅附加输出；可选注入环境变量
  const exec = await container.exec({
    Cmd: cmd,
    Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  } as any);
  const stream = (await exec.start({ hijack: true, stdin: false, Tty: false })) as unknown as NodeJS.ReadableStream;
  let output = '';
  let frameBuf = Buffer.alloc(0);

  try {
    // 等 exec 流结束，期间做超时控制
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      // 超时定时器：超时销毁流并按错误处理
      const timer = setTimeout(() => {
        settled = true;
        try { (stream as any).destroy(); } catch { /* ignore */ }
        reject(new Error('命令执行超时（15 秒）'));
      }, EXEC_TIMEOUT_MS);
      (timer as any).unref?.();

      /**
       * 将新到达的 chunk 并入滚动缓冲，剥离多路复用帧头后拼接文本
       * @param chunk 新到达的二进制块
       */
      const feed = (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        frameBuf = Buffer.concat([frameBuf, buf]);
        // 循环剥离完整帧（8 字节头 + payload）
        while (frameBuf.length >= 8) {
          const payloadLen = frameBuf.readUInt32BE(4);
          if (frameBuf.length < 8 + payloadLen) break;
          output += frameBuf.subarray(8, 8 + payloadLen).toString('utf8');
          frameBuf = frameBuf.subarray(8 + payloadLen);
        }
      };

      stream.on('data', (chunk: Buffer | string) => feed(chunk));
      stream.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });

    // 查询 exec 最终退出码，非 0 视为命令失败（携带输出便于前端定位）
    let exitCode: number | null = null;
    try {
      const insp = await exec.inspect();
      exitCode = insp?.ExitCode ?? null;
    } catch {
      exitCode = null;
    }
    if (exitCode !== null && exitCode !== 0) {
      const err: any = new Error(output?.trim() || `命令执行失败（退出码 ${exitCode}）`);
      err.statusCode = 400;
      throw err;
    }
    return output;
  } finally {
    // 尽力销毁 exec 流，避免资源泄漏
    try { (stream as any).destroy(); } catch { /* ignore */ }
  }
}

/**
 * 在宿主机执行 CLI 命令，返回 stdout 文本。
 * 参照 compose.ts 的 runCmd(execAsync) 模式；stderr 非空时并入错误信息。
 * @param cmd 命令字符串
 * @param env 额外环境变量（可选）
 * @returns 命令输出
 * @throws 命令失败（非 0 退出码）时抛出带 stderr 的错误
 */
async function runHost(cmd: string, env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...env } });
    return stdout;
  } catch (err: any) {
    const detail = err?.stderr || err?.message || '命令执行失败';
    // 检查命令是否存在（未安装对应 CLI 时给出友好提示）
    if (/ENOENT|not recognized|不是内部或外部命令/i.test(String(err?.message || ''))) {
      const apiErr: any = new Error('宿主机未安装对应数据库客户端 CLI');
      apiErr.statusCode = 400;
      throw apiErr;
    }
    const apiErr: any = new Error(String(detail).trim() || '命令执行失败');
    apiErr.statusCode = 400;
    throw apiErr;
  }
}

/**
 * 构造 mysql 基础连接参数（不含 SQL），密码以 -p<密> 紧跟形式（进程参数，可接受范围）
 * @param inst 实例行
 * @param pwd 明文口令（可为空）
 * @returns mysql 连接参数数组
 */
function mysqlConnArgs(inst: DbInstanceRow, pwd: string): string[] {
  const args: string[] = [`-h${inst.host}`, `-P${String(inst.port)}`];
  if (inst.user) args.push(`-u${inst.user}`);
  if (pwd) args.push(`-p${pwd}`);
  return args;
}

/**
 * 执行 mysql 命令（自动选择容器 exec 或宿主机 CLI）
 * @param inst 实例行
 * @param rest 基础连接参数之外的附加参数（如 -e SQL）
 * @returns 命令输出
 */
async function mysqlRun(inst: DbInstanceRow, rest: string[]): Promise<string> {
  const pwd = plainPwd(inst);
  if (useContainer(inst)) {
    return execInContainer(inst.container_ref as string, ['mysql', ...mysqlConnArgs(inst, pwd), ...rest]);
  }
  // 宿主机回退：shell 拼接命令，逐参数安全引用
  return runHost(['mysql', ...mysqlConnArgs(inst, pwd), ...rest].map(sq).join(' '));
}

/**
 * 构造 psql 基础连接参数（连接某库）。密码不走命令行，用 PGPASSWORD 环境变量注入。
 * 加 -w 禁止交互式密码提示，避免 psql 挂起。
 * @param inst 实例行
 * @param db 目标库名（缺省用 postgres 作为管理库）
 * @returns {args, env} 参数与环境变量
 */
function psqlConnArgs(inst: DbInstanceRow, db?: string): { args: string[]; env: Record<string, string> } {
  const args = ['-h', inst.host, '-p', String(inst.port), '-U', inst.user || 'postgres', '-w'];
  const targetDb = db || 'postgres';
  args.push('-d', targetDb);
  return { args, env: { PGPASSWORD: plainPwd(inst) } };
}

/**
 * 执行 psql 命令（自动选择容器 exec 或宿主机 CLI）
 * @param inst 实例行
 * @param rest 附加参数（如 -t -A -c SQL）
 * @param db 目标库名
 * @returns 命令输出
 */
async function psqlRun(inst: DbInstanceRow, rest: string[], db?: string): Promise<string> {
  const { args, env } = psqlConnArgs(inst, db);
  if (useContainer(inst)) {
    return execInContainer(inst.container_ref as string, ['psql', ...args, ...rest], env);
  }
  // 宿主机回退：psql 密码通过 PGPASSWORD 环境变量传递，更安全
  return runHost(['psql', ...args, ...rest].map(sq).join(' '), env);
}

/**
 * 构造 redis-cli 基础连接参数（含密码 -a 与 --no-auth-warning，避免认证警告写 stderr）
 * @param inst 实例行
 * @param pwd 明文口令（可为空）
 * @returns redis-cli 连接参数数组
 */
function redisConnArgs(inst: DbInstanceRow, pwd: string): string[] {
  const args = ['-h', inst.host, '-p', String(inst.port)];
  if (pwd) args.push('-a', pwd, '--no-auth-warning');
  return args;
}

/**
 * 执行 redis-cli 命令（自动选择容器 exec 或宿主机 CLI）
 * @param inst 实例行
 * @param rest 附加参数（如 PING / --scan）
 * @returns 命令输出
 */
async function redisRun(inst: DbInstanceRow, rest: string[]): Promise<string> {
  const pwd = plainPwd(inst);
  if (useContainer(inst)) {
    return execInContainer(inst.container_ref as string, ['redis-cli', ...redisConnArgs(inst, pwd), ...rest]);
  }
  return runHost(['redis-cli', ...redisConnArgs(inst, pwd), ...rest].map(sq).join(' '));
}

/**
 * 将非空行切分为字段数组（用于解析 -N -B / -t -A 输出的表格）
 * @param line 单行输出
 * @param delimiter 字段分隔符
 * @returns 字段数组
 */
function splitLine(line: string, delimiter: string): string[] {
  return line.split(delimiter);
}

/**
 * 将 CLI 输出的表格文本解析为 { columns, rows } 结构化数据。
 * 首行为列名，其余行为数据行；空格行为分隔符被忽略。
 * @param output 命令输出文本
 * @param delimiter 字段分隔符（mysql 用 tab，psql 用 |）
 * @returns 表格化结果
 */
function parseTableOutput(output: string, delimiter: string): { columns: string[]; rows: string[][] } {
  const lines = output
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };
  // 首行作为列名，其余作为数据行
  const columns = splitLine(lines[0], delimiter);
  const rows = lines.slice(1).map((l) => splitLine(l, delimiter));
  return { columns, rows };
}

/**
 * 过滤 mysql SHOW DATABASES 的系统库（返回业务库列表）
 * @param output mysql -N -B 输出
 * @returns 库名数组
 */
function filterMysqlDbs(output: string): string[] {
  return output
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l.length > 0 && !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(l));
}

/**
 * 构造被反引号包裹且正确转义内部反引号的 mysql 标识符
 * @param name 原始库/表名
 * @returns 安全的反引号标识符
 */
function mysqlIdent(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/**
 * 构造被双引号包裹且正确转义内部双引号的 psql 标识符
 * @param name 原始库/表名
 * @returns 安全的双引号标识符
 */
function psqlIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * 校验 SQL 是否为只读查询（仅允许 SELECT/SHOW/DESCRIBE/DESC/EXPLAIN 开头）
 * @param sql SQL 语句
 * @returns 是否只读
 */
function isReadOnlySql(sql: string): boolean {
  const t = sql.replace(/^\s+/, '').toUpperCase();
  return /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/.test(t);
}

/**
 * 格式化数据库实例为前端接口输出（camelCase，口令不返回，仅返回 hasPassword）
 * @param row 实例行
 * @returns 格式化结果
 */
function formatInstance(row: DbInstanceRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    containerRef: row.container_ref,
    host: row.host,
    port: row.port,
    user: row.user,
    hasPassword: !!row.cred_encrypted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 扫描应用商店数据库容器，标记可识别/未登记的实例
 * @param instances 已登记实例格式化列表（用于排除已登记）
 * @returns 识别出的数据库容器列表
 */
async function scanRecognizedInstances() {
  const docker = await getDockerClient();
  const containers = await docker.listContainers({ all: true });
  // 收集已登记实例的容器引用集合（含 id 前缀匹配的两种形式）
  const inst = getDb()
    .prepare('SELECT container_ref FROM database_instances WHERE container_ref IS NOT NULL')
    .all() as unknown as Array<{ container_ref: string }>;
  const registeredRefs = new Set(inst.map((i) => i.container_ref));
  const out: Array<{
    appId: string;
    name: string;
    containerName: string;
    containerId: string;
    running: boolean;
    port: string | null;
    registered: boolean;
  }> = [];
  for (const c of containers) {
    const appId = c.Labels?.[APP_LABEL_KEY];
    // 仅关心标记为数据库的应用容器
    if (!appId || !DB_APP_IDS.has(appId)) continue;
    const cname = (c.Names?.[0] || '').replace(/^\//, '');
    const app = APP_CATALOG.find((a) => a.id === appId);
    const ports = c.Ports || [];
    const p = ports[0];
    out.push({
      appId,
      name: app?.name || appId,
      containerName: cname,
      containerId: c.Id,
      running: c.State === 'running',
      port: p ? `${p.PublicPort ?? '未知'}:${p.PrivatePort}` : null,
      registered: registeredRefs.has(c.Id) || registeredRefs.has(c.Id.slice(0, 12)),
    });
  }
  return out;
}

// ==================== 实例列表 + 自动识别 ====================

/**
 * GET /api/databases
 * 返回已登记实例列表（camelCase，不含口令）+ 自动扫描识别出的数据库容器。
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = getDb()
      .prepare('SELECT id, name, type, container_ref, host, port, user, cred_encrypted, created_at, updated_at FROM database_instances ORDER BY id ASC')
      .all() as unknown as DbInstanceRow[];
    const instances = rows.map(formatInstance);
    // 自动识别应用商店的数据库容器，供前端"同步/识别"使用
    let recognizedInstances: Array<any> = [];
    try {
      recognizedInstances = await scanRecognizedInstances();
    } catch {
      // Docker 不可用时识别失败不影响已登记列表返回
      recognizedInstances = [];
    }
    res.json({ instances, recognizedInstances });
  }),
);

// ==================== 登记实例 ====================

/**
 * POST /api/databases
 * 登记一个数据库实例。
 * body={name,type,containerRef?,host?,port?,user?,password?}
 */
router.post(
  '/',
  asyncHandler(
    async (req: Request, res: Response) => {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      const type = String(b.type || '').trim().toLowerCase();
      // 名称与类型必填，且类型必须在允许集合内
      if (!name) {
        res.status(400).json({ error: '名称不能为空' });
        return;
      }
      if (!VALID_TYPES.has(type)) {
        res.status(400).json({ error: `不支持的数据库类型，仅支持: ${Array.from(VALID_TYPES).join(', ')}` });
        return;
      }
      const host = String(b.host || '').trim() || 'localhost';
      const port = b.port ? Number(b.port) : DEFAULT_PORTS[type];
      if (!Number.isFinite(port) || port <= 0) {
        res.status(400).json({ error: '端口无效' });
        return;
      }
      const user = b.user ? String(b.user).trim() : null;
      const containerRef = b.containerRef ? String(b.containerRef).trim() : null;
      // 口令用 encryptSecret 对称加密存储
      const credEncrypted = b.password ? encryptSecret(String(b.password)) : null;
      const now = Date.now();
      const d = getDb();
      const result = d
        .prepare(
          'INSERT INTO database_instances (name, type, container_ref, host, port, user, cred_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(name, type, containerRef, host, port, user, credEncrypted, now, now);
      const id = Number(result.lastInsertRowid);
      logOperation(res.locals.username, '登记数据库实例', 'database', name, `类型: ${type}@${host}:${port}`);
      res.status(201).json(formatInstance({ ...b, id, name, type, host, port, user, container_ref: containerRef, cred_encrypted: credEncrypted, created_at: now, updated_at: now } as unknown as DbInstanceRow));
    },
    (req: Request) => ({ action: '登记数据库实例', targetType: 'database', targetName: req.body?.name }),
  ),
);

// ==================== 更新实例 ====================

/**
 * PUT /api/databases/:id
 * 更新实例的姓名/类型/连接信息/口令；password 传空串（或省略）则不更新口令。
 */
router.put(
  '/:id',
  asyncHandler(
    async (req: Request, res: Response) => {
      const row = await requireInstance(req.params.id);
      const b = req.body || {};
      const d = getDb();
      // 汇总：仅覆盖显式提供的字段，缺省沿用原值
      const name = b.name !== undefined && String(b.name).trim() ? String(b.name).trim() : row.name;
      let type = row.type;
      if (b.type) {
        const t = String(b.type).trim().toLowerCase();
        if (!VALID_TYPES.has(t)) {
          res.status(400).json({ error: `不支持的数据库类型，仅支持: ${Array.from(VALID_TYPES).join(', ')}` });
          return;
        }
        type = t;
      }
      const host = b.host !== undefined && String(b.host).trim() ? String(b.host).trim() : row.host;
      const port = b.port ? Number(b.port) : row.port;
      const user = b.user !== undefined ? (String(b.user).trim() || null) : row.user;
      const containerRef = b.containerRef !== undefined ? (String(b.containerRef).trim() || null) : row.container_ref;
      // 口令：仅当传入非空 password 时才重新加密覆盖
      let credEncrypted = row.cred_encrypted;
      if (b.password !== undefined && b.password !== null && String(b.password) !== '') {
        credEncrypted = encryptSecret(String(b.password));
      }
      const now = Date.now();
      d.prepare(
        'UPDATE database_instances SET name = ?, type = ?, container_ref = ?, host = ?, port = ?, user = ?, cred_encrypted = ?, updated_at = ? WHERE id = ?',
      ).run(name, type, containerRef, host, port, user, credEncrypted, now, row.id);
      const updated = await requireInstance(String(row.id));
      logOperation(res.locals.username, '更新数据库实例', 'database', name);
      res.json(formatInstance(updated));
    },
    (req: Request) => ({ action: '更新数据库实例', targetType: 'database', targetName: req.params.id }),
  ),
);

// ==================== 删除登记 ====================

/**
 * DELETE /api/databases/:id
 * 删除实例登记（仅删除登记记录，不影响底层容器/数据）。
 */
router.delete(
  '/:id',
  asyncHandler(
    async (req: Request, res: Response) => {
      const row = await requireInstance(req.params.id);
      getDb().prepare('DELETE FROM database_instances WHERE id = ?').run(row.id);
      logOperation(res.locals.username, '删除数据库实例', 'database', row.name);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '删除数据库实例', targetType: 'database', targetName: req.params.id }),
  ),
);

// ==================== 连接测试 ====================

/**
 * 对 mysql/postgres 执行 SELECT 1、redis 执行 PING 的测试语句参数
 * @param inst 实例行
 * @returns 附加 测试参数数组
 */
function testSql(inst: DbInstanceRow): string[] {
  if (inst.type === 'mysql' || inst.type === 'mariadb') {
    return ['-N', '-B', '-e', 'SELECT 1'];
  }
  if (inst.type === 'postgres') {
    return ['-t', '-A', '-c', 'SELECT 1;'];
  }
  // redis
  return ['PING'];
}

/**
 * POST /api/databases/:id/test
 * 连接测试，返回 { ok, message }。
 */
router.post(
  '/:id/test',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await requireInstance(req.params.id);
    try {
      let output = '';
      if (row.type === 'mysql' || row.type === 'mariadb') {
        output = await mysqlRun(row, testSql(row));
      } else if (row.type === 'postgres') {
        output = await psqlRun(row, testSql(row));
      } else if (row.type === 'redis') {
        output = await redisRun(row, testSql(row));
      } else {
        res.status(400).json({ ok: false, message: '不支持的数据库类型' });
        return;
      }
      res.json({ ok: true, message: (output || '').trim() || '连接成功' });
    } catch (err: any) {
      res.json({ ok: false, message: err?.message || '连接失败' });
    }
  }),
);

// ==================== 列表库 ====================

/**
 * GET /api/databases/:id/databases
 * 列出库：mysql/postgres/mariadb 列出 schema；redis 返回 ['redis'] 单库。
 */
router.get(
  '/:id/databases',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await requireInstance(req.params.id);
    let dbs: string[] = [];
    if (row.type === 'mysql' || row.type === 'mariadb') {
      // mysql: SHOW DATABASES → -N -B 省略表头，逐行一个库名
      const output = await mysqlRun(row, ['-N', '-B', '-e', 'SHOW DATABASES']);
      dbs = filterMysqlDbs(output);
    } else if (row.type === 'postgres') {
      // psql: 查询 pg_database 非模板库，-t -A 逐行库名
      const output = await psqlRun(row, ['-t', '-A', '-c', "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname;"]);
      dbs = output.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter((l) => l.length > 0);
    } else if (row.type === 'redis') {
      // redis 无 schema 概念，统一视为单库
      dbs = ['redis'];
    } else {
      res.status(400).json({ error: '不支持的数据库类型' });
      return;
    }
    res.json({ databases: dbs });
  }),
);

// ==================== 建库 ====================

/**
 * POST /api/databases/:id/databases
 * 创建库，body={name, charset?}（mysql/mariadb 可传 charset）。
 */
router.post(
  '/:id/databases',
  asyncHandler(
    async (req: Request, res: Response) => {
      const row = await requireInstance(req.params.id);
      const name = String(req.body?.name || '').trim();
      const charset = req.body?.charset ? String(req.body.charset).trim() : null;
      if (!name) {
        res.status(400).json({ error: '库名不能为空' });
        return;
      }
      if (row.type === 'mysql' || row.type === 'mariadb') {
        // 库名用转义的反引号标识符防注入；charset 追加 CHARACTER SET
        const sql = charset
          ? `CREATE DATABASE IF NOT EXISTS ${mysqlIdent(name)} CHARACTER SET ${mysqlIdent(charset)}`
          : `CREATE DATABASE IF NOT EXISTS ${mysqlIdent(name)}`;
        await mysqlRun(row, ['-e', sql]);
      } else if (row.type === 'postgres') {
        // psql 库名用转义双引号标识符；postgres 不支持在 DDL 里加 charset（表级才有）
        await psqlRun(row, ['-c', `CREATE DATABASE ${psqlIdent(name)};`]);
      } else if (row.type === 'redis') {
        res.status(400).json({ error: 'Redis 不支持创建库' });
        return;
      }
      logOperation(res.locals.username, '创建数据库', 'database', row.name, `库: ${name}`);
      res.status(201).json({ ok: true, name });
    },
    (req: Request) => ({ action: '创建数据库', targetType: 'database', targetName: req.params.id }),
  ),
);

// ==================== 删库 ====================

/**
 * DELETE /api/databases/:id/databases/:db
 * 删除指定库（mysql/postgres；redis 不支持删库）。
 */
router.delete(
  '/:id/databases/:db',
  asyncHandler(
    async (req: Request, res: Response) => {
      const row = await requireInstance(req.params.id);
      const db = String(req.params.db || '').trim();
      if (!db) {
        res.status(400).json({ error: '库名不能为空' });
        return;
      }
      if (row.type === 'mysql' || row.type === 'mariadb') {
        await mysqlRun(row, ['-e', `DROP DATABASE IF EXISTS ${mysqlIdent(db)}`]);
      } else if (row.type === 'postgres') {
        await psqlRun(row, ['-c', `DROP DATABASE IF EXISTS ${psqlIdent(db)};`]);
      } else if (row.type === 'redis') {
        res.status(400).json({ error: 'Redis 不支持删除库' });
        return;
      }
      logOperation(res.locals.username, '删除数据库', 'database', row.name, `库: ${db}`);
      res.json({ ok: true });
    },
    (req: Request) => ({ action: '删除数据库', targetType: 'database', targetName: req.params.id }),
  ),
);

// ==================== 列表 ====================

/**
 * GET /api/databases/:id/databases/:db/tables
 * 列出指定库下的表（mysql/postgres；redis 无列表概念，返回 []）。
 */
router.get(
  '/:id/databases/:db/tables',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await requireInstance(req.params.id);
    const db = String(req.params.db || '').trim();
    if (!db) {
      res.status(400).json({ error: '库名不能为空' });
      return;
    }
    let tables: string[] = [];
    if (row.type === 'mysql' || row.type === 'mariadb') {
      // mysql: SHOW TABLES FROM `库` → -N -B 逐行表名
      const output = await mysqlRun(row, ['-N', '-B', '-e', `SHOW TABLES FROM ${mysqlIdent(db)}`]);
      tables = output.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter((l) => l.length > 0);
    } else if (row.type === 'postgres') {
      // psql: 查询 public schema 表 → -t -A 逐行表名
      const output = await psqlRun(row, ['-t', '-A', '-c', "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"], db);
      tables = output.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter((l) => l.length > 0);
    } else if (row.type === 'redis') {
      tables = [];
    }
    res.json({ tables });
  }),
);

// ==================== SQL 查询 ====================

/**
 * POST /api/databases/:id/query
 * 执行 SQL 查询，body={sql, db?}。
 * 默认仅允许只读语句（SELECT/SHOW/DESCRIBE/EXPLAIN 开头），否则返回 403。
 * 对 redis 不开放查询。
 */
router.post(
  '/:id/query',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await requireInstance(req.params.id);
    if (row.type === 'redis') {
      res.status(403).json({ error: 'Redis 不支持 SQL 查询' });
      return;
    }
    const sql = String(req.body?.sql || '').trim();
    if (!sql) {
      res.status(400).json({ error: 'SQL 不能为空' });
      return;
    }
    // 只读语句白名单校验（大小写不敏感，忽略前导空白）
    if (!isReadOnlySql(sql)) {
      res.status(403).json({ error: '仅允许只读查询（SELECT/SHOW/DESCRIBE/EXPLAIN）' });
      return;
    }
    // 对含分号的多语句执行只取第一条做校验，保持简单安全
    const db = req.body?.db ? String(req.body.db) : undefined;
    if (row.type === 'mysql' || row.type === 'mariadb') {
      const output = await mysqlRun(row, ['-B', '-e', sql]);
      res.json(parseTableOutput(output, '\t'));
    } else if (row.type === 'postgres') {
      // psql -A -F "|"：首行列名，后续为数据行（psql 指定分隔符便于统一解析）
      const output = await psqlRun(row, ['-A', '-F', '|', '-c', sql], db);
      res.json(parseTableOutput(output, '|'));
    } else {
      res.status(400).json({ error: '不支持的数据库类型' });
    }
  }),
);

// ==================== Redis 键浏览 ====================

/**
 * POST /api/databases/:id/redis/keys
 * Redis 键浏览，body={pattern?, limit?}。
 * 用 redis-cli --scan（避免大规模 KEYS 阻塞），按 limit 截断返回。
 */
router.post(
  '/:id/redis/keys',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await requireInstance(req.params.id);
    if (row.type !== 'redis') {
      res.status(400).json({ error: '仅 Redis 实例支持该操作' });
      return;
    }
    const pattern = req.body?.pattern ? String(req.body.pattern) : '*';
    const limit = req.body?.limit ? Number(req.body.limit) : 500;
    // 密码在 exec 参数中，--scan 不需要额外参数；pattern 作单参数传递避免注入
    const output = await redisRun(row, ['--scan', '--pattern', pattern]);
    const allKeys = output.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter((l) => l.length > 0);
    const keys = allKeys.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 500);
    res.json({ keys, total: allKeys.length, truncated: allKeys.length > keys.length });
  }),
);

// ==================== Redis 信息指标 ====================

/**
 * POST /api/databases/:id/redis/info
 * Redis 基础指标（内存/命中率/连接数），解析 redis-cli INFO 的 memory/keyspace stats 字段。
 */
router.post(
  '/:id/redis/info',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await requireInstance(req.params.id);
    if (row.type !== 'redis') {
      res.status(400).json({ error: '仅 Redis 实例支持该操作' });
      return;
    }
    const output = await redisRun(row, ['INFO']);
    // 逐行解析 "key:value" 字段
    const fields: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const m = line.match(/^([^:#]+):(.+)$/);
      if (m) fields[m[1].trim()] = m[2].trim();
    }
    const hits = Number(fields['keyspace_hits'] || '0');
    const misses = Number(fields['keyspace_misses'] || '0');
    const hitRate = hits + misses > 0 ? hits / (hits + misses) : 0;
    res.json({
      usedMemoryHuman: fields['used_memory_human'] || '',
      usedMemory: Number(fields['used_memory'] || '0'),
      connectedClients: Number(fields['connected_clients'] || '0'),
      uptimeSeconds: Number(fields['uptime_in_seconds'] || '0'),
      keyspaceHits: hits,
      keyspaceMisses: misses,
      hitRate, // 0~1，命中率
      role: fields['role'] || '',
      version: fields['redis_version'] || '',
      os: fields['os'] || '',
      totalKeys: fields['db0'] || '',
    });
  }),
);

// ==================== Redis 删除键 ====================

/**
 * DELETE /api/databases/:id/redis/keys
 * 删除指定 Redis 键，body={key}。
 */
router.delete(
  '/:id/redis/keys',
  asyncHandler(
    async (req: Request, res: Response) => {
      const row = await requireInstance(req.params.id);
      if (row.type !== 'redis') {
        res.status(400).json({ error: '仅 Redis 实例支持该操作' });
        return;
      }
      const key = String(req.body?.key || '').trim();
      if (!key) {
        res.status(400).json({ error: '键名不能为空' });
        return;
      }
      const output = await redisRun(row, ['DEL', key]);
      const deleted = Number((output || '').trim() || '0') > 0;
      logOperation(res.locals.username, '删除 Redis 键', 'database', row.name, `key: ${key}`);
      res.json({ ok: true, deleted });
    },
    (req: Request) => ({ action: '删除 Redis 键', targetType: 'database', targetName: req.params.id }),
  ),
);

export default router;
