/**
 * 容器内文件管理 API 路由（挂载路径 /api/files）
 *
 * 提供宿主机 ↔ 容器之间的文件浏览 / 上传 / 下载 / 删除 / 重命名 / 新建目录能力。
 *
 * 核心技术选型（无任何第三方新依赖，只用 node 内置 stream/buffer + dockerode）：
 *  - 读取/列目录：dockerode 的 container.getArchive({ path }) 返回容器内该路径的 tar 流，
 *    本模块用手写的最小 tar 解析器（支持 v7/gnu 基础格式）解出文件条目与单文件内容。
 *    这种方式不依赖容器内是否预装 bash/coreutils，更稳靠。
 *  - 写文件：container.putArchive(tarStream, { path: 目标目录 })，
 *    用手写 tarBuilder.singleFile 构造“单个文件的 tar 打包流”上传。
 *  - 目录/重命名/删除类修改操作：用 exec 在容器内执行 mkdir -p / mv / rm。
 *
 * 安全约束：所有路径经 sanitizePath 规整为容器内绝对路径，含 '..' 的路径直接拒绝（防路径穿越）。
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import { Readable } from 'stream';
import { getDockerClient } from '../docker/client';
import Dockerode from 'dockerode';
import { logOperation } from '../operationLog';

const router = Router();

/** 读取接口允许的单个文件大小上限（字节，2MB），超出提示改用下载 */
const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * 统一兜底错误处理，保证所有异步路由异常都能被捕获并返回 JSON
 * @param fn 异步处理函数
 * @returns Express 中间件
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<any>,
  onFail?: (req: Request, err: any) => { action: string; targetType: string; targetName?: string | null; detail?: string | null } | null,
) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      // 操作失败时若提供了 onFail，记录一条失败审计日志
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
 * 判断错误是否为“容器不存在”类错误
 * @param err 原始错误
 * @returns 是否容器不存在
 */
function isNoSuchContainer(err: any): boolean {
  const msg = String(err?.message || err?.json?.message || '');
  return /(no such container|not found|404)/i.test(msg);
}

/**
 * 将 dockerode 原始错误转换为更友好的中文提示
 * @param err 原始错误
 * @returns 友好错误文案
 */
function friendlyErrorMessage(err: any): string {
  const msg = String(err?.message || err?.json?.message || err || '');
  if (/(no such container|404)/i.test(msg)) {
    return '容器不存在或已被删除';
  }
  if (/container\s+stopped|is not running|not running/i.test(msg)) {
    return '容器当前未运行，请先启动容器后再操作';
  }
  if (/not found|no\s+such\s+file|does\s+not\s+exist/i.test(msg)) {
    return '容器内文件或目录不存在';
  }
  if (/permission denied|operation not permitted/i.test(msg)) {
    return '没有足够的权限在该容器内执行该操作';
  }
  if (/is a directory/i.test(msg)) {
    return '目标为目录，请指向文件后再操作';
  }
  return msg;
}

/**
 * 将用户传入的路径规整为容器内绝对路径，并拒绝包含 '..' 的路径（防路径穿越）
 * @param raw 用户传入的路径（可为空，表示根目录）
 * @returns 规整后的容器内绝对路径（以 / 开头）
 * @throws 当路径含 '..' 时抛出带状态码 400 的异常
 */
function sanitizePath(raw: string | undefined | null): string {
  const p = String(raw || '').trim();
  // 拆分为若干段，用于检测 '..'（路径穿越防护）
  const segments = p.split('/');
  if (segments.some((s) => s === '..')) {
    throw Object.assign(new Error('路径不能包含 ".."（禁止路径穿越）'), { statusCode: 400 });
  }
  // 规整为以 / 开头的绝对路径：空路径表示根目录
  if (!p) return '/';
  const joined = '/' + segments.filter((s) => s !== '' && s !== '.').join('/');
  return joined || '/';
}

/**
 * 在容器内执行一条非交互式命令，收集 stdout/stderr 与退出码
 * @param container dockerode 容器对象
 * @param cmd 命令及参数数组（如 ['mkdir', '-p', '/data']）
 * @returns 退出码与合并后的输出文本
 */
async function execInContainer(container: Dockerode.Container, cmd: string[]): Promise<{ exitCode: number; output: string }> {
  // 创建仅附加输出的 exec（非 TTY）
  const exec = await container.exec({
    AttachStdout: true,
    AttachStderr: true,
    Cmd: cmd,
    Tty: false,
  } as any);

  // hijack 模式启动 exec，得到混合输出流
  const stream = (await exec.start({ hijack: true, stdin: false, Tty: false })) as unknown as NodeJS.ReadableStream;

  // 与 containers.ts 的 exec 一致：Tty=false 时输出为多路复用帧（8 字节头 + payload），需剥离帧头
  let output = '';
  let frameBuf = Buffer.alloc(0);

  // 等待 exec 流结束，并做超时保护
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    // 默认超时 15 秒，避免命令卡死导致请求挂起
    const timer = setTimeout(() => {
      settled = true;
      try { (stream as any).destroy(); } catch { /* ignore */ }
      reject(new Error('命令执行超时'));
    }, 15000);
    (timer as any).unref?.();

    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      frameBuf = Buffer.concat([frameBuf, buf]);
      // 循环剥离完整多路复用帧
      while (frameBuf.length >= 8) {
        const payloadLen = frameBuf.readUInt32BE(4);
        if (frameBuf.length < 8 + payloadLen) break;
        output += frameBuf.subarray(8, 8 + payloadLen).toString('utf8');
        frameBuf = frameBuf.subarray(8 + payloadLen);
      }
    });
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

  // 查询最终退出码
  let exitCode: number | null = null;
  try {
    const inspect = await exec.inspect();
    exitCode = inspect?.ExitCode ?? null;
  } catch {
    exitCode = null;
  }
  return { exitCode: exitCode ?? 0, output };
}

/**
 * 校验容器存在，并返回容器对象；容器不存在时抛出 404
 * @param id 容器 ID
 * @returns dockerode 容器对象
 */
async function getContainerOr404(id: string): Promise<Dockerode.Container> {
  const docker = await getDockerClient();
  const container = docker.getContainer(id);
  // 通过 inspect 校验容器是否存在
  try {
    await container.inspect();
  } catch (err: any) {
    if (isNoSuchContainer(err)) {
      throw Object.assign(new Error('容器不存在或已被删除'), { statusCode: 404 });
    }
    throw Object.assign(new Error(friendlyErrorMessage(err)), { statusCode: err?.statusCode || 500 });
  }
  return container;
}

/**
 * 校验容器存在且处于运行状态；未运行返回 null
 * @param container dockerode 容器对象
 * @returns 容器是否处于运行状态
 */
async function requireRunning(container: Dockerode.Container): Promise<boolean> {
  try {
    const info = await container.inspect();
    return !!info.State?.Running;
  } catch {
    return false;
  }
}

// ============ tar 解析器（用于读取 getArchive 返回的流） ============

/** tar 头一个块的大小 */
const TAR_BLOCK_SIZE = 512;

/**
 * 从 tar 头块中读取一个八进制数字字段（字段为空格/0 填充的 ASCII）
 * @param buf 整个 512 字节头块
 * @param offset 字段起始偏移
 * @param length 字段长度
 * @returns 解析出的数值，无内容时返回 0
 */
function readOctal(buf: Buffer, offset: number, length: number): number {
  // tar 头中数字以八进制 + 结尾 NUL/空格 存储；取出字节后去尾随 NUL/空格再按八进制解析
  const raw = buf.subarray(offset, offset + length).toString('ascii').replace(/[^\d]/g, '');
  return raw ? parseInt(raw, 8) : 0;
}

/**
 * 从 tar 头块读取以 NUL 结尾的字符串字段
 * @param buf 整个 512 字节头块
 * @param offset 字段起始偏移
 * @param length 字段长度
 * @returns 去尾部 NUL 后的字符串
 */
function readStr(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString('utf8').replace(/\0+$/, '');
}

/**
 * 从 tar 流中提取指定路径的文件条目。
 * 支持单文件与多文件（递归）目录归档的基础解析（v7/gnu：name/mode, size 字段即足够列目录）。
 * @param stream getArchive 返回的可读 tar 流
 * @param only 需要提取的容器内单一目标路径（如 /app/demo.txt）；目录 tar 流可达时返回该文件的 Buffer
 * @returns 解析结果：entries 为全部条目（含 name/type/size/mode/mtime），content 为该路径文件内容（仅当为单文件或命中 only 时）
 */
function parseTarStream(
  stream: NodeJS.ReadableStream,
  only?: string,
): Promise<{ entries: Array<{ name: string; type: 'dir' | 'file'; size: number; mode: string; mtime: number }>; content: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const entries: Array<{ name: string; type: 'dir' | 'file'; size: number; mode: string; mtime: number }> = [];
    let content: Buffer | null = null;
    let buf = Buffer.alloc(0);
    // 保证 raw 内容完整，供仅提取单文件时使用
    let raw = Buffer.alloc(0);

    /**
     * 从当前缓冲中循环解析完整的 tar 块序列
     */
    const tryParse = (): void => {
      while (buf.length >= TAR_BLOCK_SIZE) {
        // 至少要有 1024 字节的结尾块（两个 512 空块）才判定归档结束
        if (buf.length >= 1024) {
          // 检查两个连续的零块（tar 归档结束标记）
          const isEnd =
            buf.length >= 2 * TAR_BLOCK_SIZE &&
            buf.subarray(0, 2 * TAR_BLOCK_SIZE).every((b) => b === 0);
          if (isEnd) {
            // 忽略结尾零块，维持已解析出的条目
            break;
          }
        }

        // 读取头部字段
        const headerBuf = buf.subarray(0, TAR_BLOCK_SIZE);
        const name = readStr(headerBuf, 0, 100).replace(/^\.\//, '').replace(/^\//, '');
        const size = readOctal(headerBuf, 124, 12);
        const mode = readOctal(headerBuf, 100, 8);
        const mtime = readOctal(headerBuf, 136, 12);
        // 类型标志：第 156 字节（'5' 表示目录，'0'/0 表示普通文件，'L' 是 GNU 长文件名扩展头）
        const typeFlag = headerBuf[156] || 0;

        // 处理 GNU 长文件名扩展头（typeflag='L'）：后面 size 字节存的是真正的文件路径
        if (String.fromCharCode(typeFlag) === 'L') {
          if (buf.length < TAR_BLOCK_SIZE + size) break;
          // 该扩展头的内容为下一块头部的文件名
          const longName = buf
            .subarray(TAR_BLOCK_SIZE, TAR_BLOCK_SIZE + size)
            .toString('utf8')
            .replace(/\0+$/, '');
          // 跳过本块头 + 内容 + 对齐填充，继续解析后续实际头部
          const skipBlocks = Math.ceil((size + TAR_BLOCK_SIZE) / TAR_BLOCK_SIZE);
          if (buf.length < TAR_BLOCK_SIZE * (skipBlocks + 1)) break;
          buf = buf.subarray(TAR_BLOCK_SIZE * skipBlocks);
          // 将长名写回读到的下一个头部
          const nextHeader = buf.subarray(0, TAR_BLOCK_SIZE);
          nextHeader.write(longName, 0, Math.min(longName.length, 100), 'utf8');
          continue;
        }

        const isDir = typeFlag === 5 || /\/$/.test(name);

        // 文件内容紧随头部之后，按 size 对齐到 512 的整数倍
        const dataLen = TAR_BLOCK_SIZE + size;
        if (buf.length < dataLen) break;

        const fileData = buf.subarray(TAR_BLOCK_SIZE, TAR_BLOCK_SIZE + size);

        const entryName = name;
        const hasContent = size > 0;

        entries.push({
          name: entryName,
          type: isDir ? 'dir' : 'file',
          size,
          mode: mode.toString(8),
          mtime: mtime * 1000, // tar 中 mtime 为秒，转为毫秒
        });

        // 若请求了指定路径，且当前条目名与之匹配（支持 "./path" 相对形式），取出内容
        if (only && hasContent && (entryName === only || './' + entryName === only)) {
          content = Buffer.from(fileData);
        }

        // 计算下一个头部偏移（跳过头部 + 内容 + 对齐填充块）
        const aligned = TAR_BLOCK_SIZE * Math.ceil(size / TAR_BLOCK_SIZE);
        buf = buf.subarray(TAR_BLOCK_SIZE + aligned);
        raw = raw.subarray(TAR_BLOCK_SIZE + aligned);
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buf = Buffer.concat([buf, b]);
      raw = Buffer.concat([raw, b]);
      tryParse();
    });
    stream.on('error', (err) => reject(err));
    stream.on('end', () => {
      // 单文件模式下直接用收集的原始缓冲做一次解析（流式解析可能因分包不完整，这里兜底）
      if (only && !content && raw.length > 0) {
        try {
          content = extractSingleFileFromBuffer(raw, only);
        } catch {
          content = null;
        }
      }
      resolve({ entries, content });
    });
  });
}

/**
 * 从已收集的完整 tar 缓冲中提取指定单文件内容（兜底方案，用于 getArchive 流式解析未命中的情况）
 * @param raw 完整 tar 缓冲
 * @param only 目标文件名（tar 内条目名）
 * @returns 目标文件内容，未命中返回 null
 */
function extractSingleFileFromBuffer(raw: Buffer, only: string): Buffer | null {
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= raw.length) {
    const headerBuf = raw.subarray(offset, offset + TAR_BLOCK_SIZE);
    // 全零块表示归档结束
    if (headerBuf.every((b) => b === 0)) break;
    const name = readStr(headerBuf, 0, 100).replace(/^\.\//, '').replace(/^\//, '');
    const size = readOctal(headerBuf, 124, 12);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const aligned = TAR_BLOCK_SIZE * Math.ceil(size / TAR_BLOCK_SIZE);
    if (dataStart + size <= raw.length && (name === only || './' + name === only)) {
      return Buffer.from(raw.subarray(dataStart, dataStart + size));
    }
    offset = dataStart + aligned;
  }
  return null;
}

// ============ tar 生成器（用于构造 putArchive 上传流） ============

/**
 * 为单个文件构造 tar 归档（Buffer：512 头部 + 内容 + 对齐填充 + 2 个 512 结尾块）
 * @param name 归档内的文件名（含相对路径，如 "upload.txt"）
 * @param data 文件内容 Buffer
 * @returns 完整的 tar Buffer
 */
function tarBuilderSingleFile(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(TAR_BLOCK_SIZE);

  // 文件名（最多 100 字节，超出部分截断——上传场景一般文件名较短）
  nameBuf.copy(header, 0, 0, Math.min(nameBuf.length, 100));

  // 权限：0644，以八进制 ASCII 写入
  const mode = '0000644';
  header.write(mode, 100, 8, 'ascii');
  // UID/GID：0
  header.write('0000000', 108, 8, 'ascii');
  header.write('0000000', 116, 8, 'ascii');
  // 文件大小：八进制
  header.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'ascii');
  header[135] = 0;

  // mtime：当前时间（秒）八进制
  const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
  header.write(mtime, 136, 12, 'ascii');
  header[147] = 0;

  // 每块头部的校验和：将所有字节视为有符号字符求和，存为 6 位八进制 + NUL + 空格
  // 先填 8 个空格占位，再计算
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
    // tar 校验和按“有符号字节”求和（兼容多数实现按无符号字节）
    const byte = header[i];
    sum += byte > 127 ? byte - 256 : byte;
  }
  const checksumStr = sum.toString(8).padStart(6, '0');
  header.write(checksumStr, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;

  // 类型标志：0 = 普通文件
  header[156] = 0;

  // 拼接：头部 + 内容 + 内容对齐填充（到 512 整数倍）+ 两个 512 结尾块
  const contentAligned = TAR_BLOCK_SIZE * Math.ceil(data.length / TAR_BLOCK_SIZE);
  const finale = Buffer.alloc(2 * TAR_BLOCK_SIZE);
  const total = TAR_BLOCK_SIZE + contentAligned + finale.length;
  const tar = Buffer.alloc(total);
  header.copy(tar, 0);
  data.copy(tar, TAR_BLOCK_SIZE);
  finale.copy(tar, TAR_BLOCK_SIZE + contentAligned);
  return tar;
}

// ============ 容器文件接口 ============

/**
 * GET /api/files/:containerId/ls?path=
 * 列出容器内指定目录下的文件条目（用 getArchive 解析 tar，不依赖容器内命令）
 * 返回 { items: [{ name, type:'dir'|'file', size, mtime }] }
 */
router.get(
  '/:containerId/ls',
  asyncHandler(async (req: Request, res: Response) => {
    const container = await getContainerOr404(req.params.containerId);
    if (!(await requireRunning(container))) {
      res.status(400).json({ error: '请先启动容器' });
      return;
    }
    const path = sanitizePath(req.query.path as string | undefined);
    // getArchive({ path }) 返回该路径的 tar 流（目录则递归列出其中条目）
    const stream = await container.getArchive({ path });
    const { entries } = await parseTarStream(stream);
    // 过滤掉上级目录自身条目（name 不含 / 的根条目），并去重
    const seen = new Set<string>();
    const items = entries
      .filter((e) => e.name && !seen.has(e.name) && seen.add(e.name))
      .map((e) => ({ name: e.name, type: e.type, size: e.size, mtime: e.mtime }));
    logOperation(res.locals.username, '浏览目录', 'container', req.params.containerId, `路径: ${path}`);
    res.json({ items });
  }),
);

/**
 * GET /api/files/:containerId/read?path=
 * 读取容器内小文件文本内容（上限 2MB，超限提示改用下载）
 * 返回 { content, truncated? }
 */
router.get(
  '/:containerId/read',
  asyncHandler(async (req: Request, res: Response) => {
    const container = await getContainerOr404(req.params.containerId);
    if (!(await requireRunning(container))) {
      res.status(400).json({ error: '请先启动容器' });
      return;
    }
    const path = sanitizePath(req.query.path as string | undefined);
    const base = path.split('/').pop() || path || 'file';
    // getArchive 对单文件路径同样返回 tar 流，解出其中该文件内容
    const stream = await container.getArchive({ path });
    const { content } = await parseTarStream(stream, base);
    if (!content && content !== null) {
      res.status(404).json({ error: '容器内文件不存在' });
      return;
    }
    // 检查大小上限，超限提示改用下载
    if (content === null) {
      res.status(400).json({ error: '目标不是可读取的文件或文件内容为空' });
      return;
    }
    if (content.length > MAX_READ_BYTES) {
      res.json({ content: '', truncated: true, message: '文件超过 2MB，请使用下载接口获取' });
      return;
    }
    logOperation(res.locals.username, '读取文件', 'container', req.params.containerId, `路径: ${path}`);
    res.json({ content: content.toString('utf8'), truncated: false });
  }),
);

/**
 * GET /api/files/:containerId/download?path=
 * 下载容器内文件。用 getArchive 解出 tar 中的单文件内容，以 attachment（原始内容，非 tar 包装）发送。
 */
router.get(
  '/:containerId/download',
  asyncHandler(async (req: Request, res: Response) => {
    const container = await getContainerOr404(req.params.containerId);
    if (!(await requireRunning(container))) {
      res.status(400).json({ error: '请先启动容器' });
      return;
    }
    const path = sanitizePath(req.query.path as string | undefined);
    const base = (path.split('/').pop() || 'file').replace(/[^\w.\-]+/g, '_');
    const stream = await container.getArchive({ path });
    const { content } = await parseTarStream(stream, base);
    if (content === null) {
      res.status(404).json({ error: '容器内文件不存在' });
      return;
    }
    logOperation(res.locals.username, '下载文件', 'container', req.params.containerId, `路径: ${path}`);
    // 以附件形式返回该文件的原始字节（非 tar 包装）
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(base)}"`);
    res.send(content);
  }),
);

/**
 * POST /api/files/:containerId/upload?path=&name=
 * 上传文件到容器目录。
 * 请求体为 application/octet-stream 原始字节（express.raw），查询参数 path=目标目录、name=文件名。
 * 用手写 tarBuilder 构造 tar 流，交给 container.putArchive 写入容器目录。
 */
router.post(
  '/:containerId/upload',
  express.raw({ type: 'application/octet-stream', limit: '500mb' }),
  asyncHandler(
    async (req: Request, res: Response) => {
      const container = await getContainerOr404(req.params.containerId);
      if (!(await requireRunning(container))) {
        res.status(400).json({ error: '请先启动容器' });
        return;
      }
      const raw = req.body as Buffer | undefined;
      if (!raw || !Buffer.isBuffer(raw)) {
        res.status(400).json({ error: '请求体为空，请以 application/octet-stream 发送文件内容' });
        return;
      }
      const dir = sanitizePath(req.query.path as string | undefined);
      const name = String(req.query.name || '').trim().replace(/[\\/]/g, ''); // 文件名禁止含路径分隔符
      if (!name) {
        res.status(400).json({ error: '缺少文件名 name 参数' });
        return;
      }
      // 构造单文件 tar 并包装为可读流
      const tarBuf = tarBuilderSingleFile(name, raw);
      const input = Readable.from(tarBuf);
      // 上传到容器的目标目录（putArchive 的 path 为容器内的绝对目录路径）
      await container.putArchive(input, { path: dir });
      logOperation(res.locals.username, '上传文件', 'container', req.params.containerId, `路径: ${dir}/${name}`);
      res.json({ ok: true, name, path: `${dir}/${name}` });
    },
    (req: Request) => ({ action: '上传文件', targetType: 'container', targetName: req.params.containerId }),
  ),
);

/**
 * POST /api/files/:containerId/mkdir
 * 在容器内新建目录。body={ path }
 */
router.post(
  '/:containerId/mkdir',
  asyncHandler(
    async (req: Request, res: Response) => {
      const container = await getContainerOr404(req.params.containerId);
      if (!(await requireRunning(container))) {
        res.status(400).json({ error: '请先启动容器' });
        return;
      }
      const path = sanitizePath(req.body?.path as string | undefined);
      if (!path || path === '/') {
        res.status(400).json({ error: '目录路径不能为空' });
        return;
      }
      const { exitCode, output } = await execInContainer(container, ['mkdir', '-p', path]);
      if (exitCode !== 0) {
        res.status(400).json({ error: `新建目录失败: ${output || '未知错误'}` });
        return;
      }
      logOperation(res.locals.username, '新建目录', 'container', req.params.containerId, `路径: ${path}`);
      res.json({ ok: true, path });
    },
    (req: Request) => ({ action: '新建目录', targetType: 'container', targetName: req.params.containerId }),
  ),
);

/**
 * POST /api/files/:containerId/rename
 * 重命名容器内文件/目录。body={ path, newName }
 */
router.post(
  '/:containerId/rename',
  asyncHandler(
    async (req: Request, res: Response) => {
      const container = await getContainerOr404(req.params.containerId);
      if (!(await requireRunning(container))) {
        res.status(400).json({ error: '请先启动容器' });
        return;
      }
      const path = sanitizePath(req.body?.path as string | undefined);
      const newName = String(req.body?.newName || '').trim().replace(/[\\/]/g, '');
      if (!path || path === '/') {
        res.status(400).json({ error: '源路径不能为空' });
        return;
      }
      if (!newName) {
        res.status(400).json({ error: '新名称 newName 不能为空' });
        return;
      }
      // 目标路径 = 源文件所在目录 + 新名称
      const dir = path.split('/').slice(0, -1).join('/') || '/';
      const target = `${dir}/${newName}`.replace(/\/{2,}/g, '/');
      const { exitCode, output } = await execInContainer(container, ['mv', path, target]);
      if (exitCode !== 0) {
        res.status(400).json({ error: `重命名失败: ${output || '未知错误'}` });
        return;
      }
      logOperation(res.locals.username, '重命名文件', 'container', req.params.containerId, `${path} -> ${target}`);
      res.json({ ok: true, path: target });
    },
    (req: Request) => ({ action: '重命名文件', targetType: 'container', targetName: req.params.containerId }),
  ),
);

/**
 * POST /api/files/:containerId/delete
 * 删除容器内文件/目录。body={ path, recursive? }
 * recursive 为 true 或目标为目录时使用 rm -rf，否则用 rm。
 */
router.post(
  '/:containerId/delete',
  asyncHandler(
    async (req: Request, res: Response) => {
      const container = await getContainerOr404(req.params.containerId);
      if (!(await requireRunning(container))) {
        res.status(400).json({ error: '请先启动容器' });
        return;
      }
      const path = sanitizePath(req.body?.path as string | undefined);
      if (!path || path === '/') {
        res.status(400).json({ error: '路径不能为空或根目录' });
        return;
      }
      const recursive = req.body?.recursive === true;
      // 目录或 recursive 时用 rm -rf，否则用 rm
      const cmd = recursive ? ['rm', '-rf', path] : ['rm', '-f', path];
      const { exitCode, output } = await execInContainer(container, cmd);
      if (exitCode !== 0) {
        res.status(400).json({ error: `删除失败: ${output || '未知错误'}` });
        return;
      }
      logOperation(res.locals.username, '删除文件', 'container', req.params.containerId, `路径: ${path}${recursive ? '（递归）' : ''}`);
      res.json({ ok: true, path });
    },
    (req: Request) => ({ action: '删除文件', targetType: 'container', targetName: req.params.containerId }),
  ),
);

export default router;
