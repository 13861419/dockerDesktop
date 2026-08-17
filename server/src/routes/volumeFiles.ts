/**
 * 数据卷内容浏览器 API 路由（挂载路径 /api/volume-files）
 *
 * 提供 Docker 命名卷内的文件浏览 / 读取 / 下载 / 上传 / 新建目录 / 重命名 / 删除能力，
 * 作为"卷内容浏览器"的后端支撑。绑定到 npm script 无第三方新依赖，只用 dockerode + node 内置能力。
 *
 * 技术方案：
 *  命名卷无法像容器那样直接 getArchive/putArchive，因此本模块采用"一次性卷浏览辅助容器"模式：
 *   - 每次操作创建一个 alpine 辅助容器，将目标卷挂载到 /data，
 *   - 容器 start 后保持运行（sleep），在本请求内通过 exec 执行命令或 getArchive/putArchive 操作挂载目录，
 *   - 请求结束统一 remove（force），保证无状态泄漏、不重复创建常驻容器。
 *
 * 安全约束：
 *   - 卷名仅允许字母数字、下划线、短划线、点（符合 Docker 卷命名规范），拒绝路径分隔符。
 *   - 路径经 sanitizePath 规整为挂载目录内绝对路径，含 '..' 的路径直接拒绝（防路径穿越）。
 */
import { Router, Request, Response } from 'express';
import express from 'express';
import { Readable } from 'stream';
import { getDockerClient } from '../docker/client';
import Dockerode from 'dockerode';
import { logOperation } from '../operationLog';
import { requireAdmin } from '../auth';

const router = Router();

/** 读取接口允许的单个文件大小上限（字节，2MB），超出提示改用下载 */
const MAX_READ_BYTES = 2 * 1024 * 1024;

/** 卷挂载在辅助容器内的根目录 */
const MOUNT_DIR = '/data';

/**
 * 校验卷名是否安全：仅允许字母数字、下划线、短划线、点，并抑制分隔符
 * @param raw 卷名
 * @returns 归一化后的卷名
 * @throws 非法时抛出 400
 */
function sanitizeVolumeName(raw: string): string {
  const name = String(raw || '').trim();
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw Object.assign(new Error('非法的数据卷名称'), { statusCode: 400 });
  }
  return name;
}

/**
 * 将用户传入的路径规整为挂载目录内绝对路径，并拒绝包含 '..' 的路径（防路径穿越）
 * @param raw 用户传入的路径（可为空，表示卷根目录）
 * @returns 规整后的卷内绝对路径（以 / 开头）
 * @throws 当路径含 '..' 时抛出带状态码 400 的异常
 */
function sanitizePath(raw: string | undefined | null): string {
  const p = String(raw || '').trim();
  const segments = p.split('/');
  if (segments.some((s) => s === '..')) {
    throw Object.assign(new Error('路径不能包含 ".."（禁止路径穿越）'), { statusCode: 400 });
  }
  if (!p) return '/';
  const joined = '/' + segments.filter((s) => s !== '' && s !== '.').join('/');
  return joined || '/';
}

/**
 * 统一兜底错误处理
 * @param fn 异步处理函数
 * @returns Express 中间件
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: any) => {
      const status = err?.statusCode || 500;
      const message =
        typeof err?.json === 'function' && err.json?.message
          ? err.json.message
          : err?.message || '服务器内部错误';
      res.status(status).json({ error: message });
    });
  };
}

/**
 * 保证 alpine 镜像存在（不存在则拉取）
 * @param docker dockerode 实例
 */
async function ensureAlpineImage(docker: Dockerode): Promise<void> {
  const images = await docker.listImages();
  const hasAlpine = images.some((i) =>
    (i.RepoTags || []).some((t) => t.split(':')[0].toLowerCase() === 'alpine'),
  );
  if (!hasAlpine) {
    await new Promise<void>((resolve, reject) => {
      docker.pull('alpine:latest', (err: any, stream: any) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (perr: any) => (perr ? reject(perr) : resolve()), () => {});
      });
    });
  }
}

/**
 * 创建并启动一个挂载了指定卷到 /data 的轻量 alpine 辅助容器
 * @param docker dockerode 实例
 * @param volume 卷名
 * @returns 已启动的容器对象（调用方负责 remove）
 */
async function createVolumeHelper(docker: Dockerode, volume: string): Promise<Dockerode.Container> {
  await ensureAlpineImage(docker);
  const container = await docker.createContainer({
    Image: 'alpine:latest',
    Cmd: ['sleep', 'infinity'],
    HostConfig: {
      Binds: [`${volume}:${MOUNT_DIR}`],
      AutoRemove: false,
    },
  });
  await container.start();
  return container;
}

/**
 * 校验卷存在，返回辅助容器（不存在则抛 404）
 * @param docker dockerode 实例
 * @param volume 卷名
 * @returns 容器对象（调用方必须 finally remove）
 */
async function serveVolumeHelper(docker: Dockerode, volume: string): Promise<Dockerode.Container> {
  try {
    await docker.getVolume(volume).inspect();
  } catch {
    throw Object.assign(new Error('数据卷不存在'), { statusCode: 404 });
  }
  return createVolumeHelper(docker, volume);
}

/**
 * exec 解析帮助：读取命令执行输出。使用 dockerode exec，hijack 模式下剥离多路复用帧。
 * @param container 容器对象
 * @param cmd 命令及参数数组
 * @returns 退出码与合并输出
 */
async function execInContainer(
  container: Dockerode.Container,
  cmd: string[],
): Promise<{ exitCode: number; output: string }> {
  const exec = await container.exec({
    AttachStdout: true,
    AttachStderr: true,
    Cmd: cmd,
    Tty: false,
  } as any);
  const stream = (await exec.start({ hijack: true, stdin: false, Tty: false })) as unknown as NodeJS.ReadableStream;

  let output = '';
  let frameBuf = Buffer.alloc(0);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { (stream as any).destroy(); } catch { /* ignore */ }
      reject(new Error('命令执行超时'));
    }, 15000);
    (timer as any).unref?.();

    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      frameBuf = Buffer.concat([frameBuf, buf]);
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
 * 解析 `ls -lA --time-style=+%s`（GNU）输出为单层文件条目
 * @param output ls 输出
 * @returns 单层文件条目集合
 */
function parseLsEntries(output: string): Array<{ name: string; type: 'dir' | 'file'; size: number; mtime: number }> {
  const items: Array<{ name: string; type: 'dir' | 'file'; size: number; mtime: number }> = [];
  const gnu = /^([dl-])([rwxsStT-]{9})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/;
  const basic = /^([dl-])([rwxsStT-]{9})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(.+)$/;
  for (const raw of (output || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^total\s/.test(line)) continue;
    let m = gnu.exec(line);
    let mtime = 0;
    let size = 0;
    let name = '';
    let dir = false;
    if (m) {
      dir = m[1] === 'd';
      size = parseInt(m[3], 10) || 0;
      mtime = (parseInt(m[4], 10) || 0) * 1000;
      name = m[5].trim();
    } else {
      m = basic.exec(line);
      if (!m) continue;
      dir = m[1] === 'd';
      size = parseInt(m[3], 10) || 0;
      const rest = m[4];
      const lastSpace = rest.lastIndexOf(' ');
      name = (lastSpace >= 0 ? rest.slice(lastSpace + 1) : rest).trim();
    }
    if (!name || name === '.' || name === '..') continue;
    items.push({ name, type: dir ? 'dir' : 'file', size, mtime });
  }
  return items;
}

/**
 * 用 exec ls 列出卷挂载目录下指定路径的单层条目
 * @param container 辅助容器
 * @param path 卷内目录（/data 内绝对路径，以 / 开头）
 * @returns 单层文件条目集合
 */
async function listDirViaExec(container: Dockerode.Container, path: string): Promise<Array<{ name: string; type: 'dir' | 'file'; size: number; mtime: number }>> {
  const target = `${MOUNT_DIR}${path === '/' ? '' : path}`;
  let r = await execInContainer(container, ['sh', '-c', `ls -lA --time-style=+%s -- "${target}"`]);
  if (r.exitCode !== 0) {
    r = await execInContainer(container, ['sh', '-c', `ls -lA -- "${target}"`]);
  }
  if (r.exitCode !== 0) {
    const msg = r.output?.trim() || '目录不存在或无法访问';
    throw Object.assign(new Error(`列出目录失败：${msg}`), { statusCode: 400 });
  }
  return parseLsEntries(r.output || '');
}

// ============ tar 单文件解析（供 getArchive 读取） ============

/** tar 头一个块的大小 */
const TAR_BLOCK_SIZE = 512;

/**
 * 从 tar 头块中读取一个八进制数字字段
 * @param buf 整个 512 字节头块
 * @param offset 字段起始偏移
 * @param length 字段长度
 * @returns 解析出的数值
 */
function readOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length).toString('ascii').replace(/[^\d]/g, '');
  return raw ? parseInt(raw, 8) : 0;
}

/**
 * 从 tar 头块读取以 NUL 结尾的字符串字段
 * @param buf tar 头块
 * @param offset 起始偏移
 * @param length 长度
 * @returns 字符串
 */
function readStr(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString('utf8').replace(/\0+$/, '');
}

/**
 * 从 getArchive 返回的 tar 流中提取指定单文件内容
 * @param stream getArchive 返回的可读 tar 流
 * @param only 归档内的单文件路径
 * @returns 文件内容，未命中返回 null
 */
function extractSingleFileFromStream(stream: NodeJS.ReadableStream, only: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let content: Buffer | null = null;

    const tryParse = () => {
      while (buf.length >= TAR_BLOCK_SIZE) {
        if (buf.subarray(0, 2 * TAR_BLOCK_SIZE).every((b) => b === 0)) break;
        const headerBuf = buf.subarray(0, TAR_BLOCK_SIZE);
        const name = readStr(headerBuf, 0, 100).replace(/^\.\//, '').replace(/^\//, '');
        const size = readOctal(headerBuf, 124, 12);
        const aligned = TAR_BLOCK_SIZE * Math.ceil(size / TAR_BLOCK_SIZE);
        if (buf.length < TAR_BLOCK_SIZE + aligned) break;
        const fileData = buf.subarray(TAR_BLOCK_SIZE, TAR_BLOCK_SIZE + size);
        if (name === only || './' + name === only) {
          content = Buffer.from(fileData);
          break;
        }
        buf = buf.subarray(TAR_BLOCK_SIZE + aligned);
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buf = Buffer.concat([buf, b]);
      tryParse();
    });
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(content));
  });
}

/**
 * 为单个文件构造 tar 归档（Buffer），供 putArchive 使用
 * @param name 归档内的文件名
 * @param data 文件内容 Buffer
 * @returns 完整 tar Buffer
 */
function tarBuilderSingleFile(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  nameBuf.copy(header, 0, 0, Math.min(nameBuf.length, 100));
  header.write('0000644', 100, 8, 'ascii');
  header.write('0000000', 108, 8, 'ascii');
  header.write('0000000', 116, 8, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'ascii');
  header[135] = 0;
  const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
  header.write(mtime, 136, 12, 'ascii');
  header[147] = 0;
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
    const byte = header[i];
    sum += byte > 127 ? byte - 256 : byte;
  }
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  header[156] = 0;
  const contentAligned = TAR_BLOCK_SIZE * Math.ceil(data.length / TAR_BLOCK_SIZE);
  const finale = Buffer.alloc(2 * TAR_BLOCK_SIZE);
  const total = TAR_BLOCK_SIZE + contentAligned + finale.length;
  const tar = Buffer.alloc(total);
  header.copy(tar, 0);
  data.copy(tar, TAR_BLOCK_SIZE);
  finale.copy(tar, TAR_BLOCK_SIZE + contentAligned);
  return tar;
}

// ============ 数据卷文件接口 ============

/**
 * GET /api/volume-files/:volume/ls?path=
 * 列出数据卷内指定目录下的文件条目（用辅助容器 exec ls 单层列出）
 * 返回 { items: [{ name, type, size, mtime }] }
 */
router.get(
  '/:volume/ls',
  asyncHandler(async (req: Request, res: Response) => {
    const volume = sanitizeVolumeName(req.params.volume);
    const docker = await getDockerClient();
    const container = await serveVolumeHelper(docker, volume);
    try {
      const rawPath = sanitizePath(req.query.path as string | undefined);
      const literal = rawPath === '/' ? '/' : rawPath.replace(/\/+$/, '') || '/';
      const items = await listDirViaExec(container, literal);
      res.json({ items });
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }),
);

/**
 * GET /api/volume-files/:volume/read?path=
 * 读取数据卷内小文件文本内容（上限 2MB，超限提示改用下载）
 * 返回 { content, truncated? }
 */
router.get(
  '/:volume/read',
  asyncHandler(async (req: Request, res: Response) => {
    const volume = sanitizeVolumeName(req.params.volume);
    const docker = await getDockerClient();
    const container = await serveVolumeHelper(docker, volume);
    try {
      const path = sanitizePath(req.query.path as string | undefined);
      const target = `${MOUNT_DIR}${path === '/' ? '' : path}`;
      // 用 exec cat 读取，简单可靠；大小上限校验
      const r = await execInContainer(container, ['cat', target]);
      if (r.exitCode !== 0) {
        res.status(400).json({ error: `读取失败：${r.output?.trim() || '文件不存在'}` });
        return;
      }
      const content = Buffer.from(r.output, 'utf8');
      if (content.length > MAX_READ_BYTES) {
        res.json({ content: '', truncated: true, message: '文件超过 2MB，请使用下载接口获取' });
        return;
      }
      logOperation(res.locals.username, '读取卷文件', 'volume', volume, `路径: ${path}`);
      res.json({ content: content.toString('utf8'), truncated: false });
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }),
);

/**
 * GET /api/volume-files/:volume/download?path=
 * 下载数据卷内文件。用 getArchive 解出 tar 中的单文件内容，以 attachment 发送原始字节。
 */
router.get(
  '/:volume/download',
  asyncHandler(async (req: Request, res: Response) => {
    const volume = sanitizeVolumeName(req.params.volume);
    const docker = await getDockerClient();
    const container = await serveVolumeHelper(docker, volume);
    try {
      const path = sanitizePath(req.query.path as string | undefined);
      const base = (path.split('/').pop() || 'file').replace(/[^\w.\-]+/g, '_');
      const target = `${MOUNT_DIR}${path === '/' ? '' : path}`;
      const stream = await container.getArchive({ path: target });
      const content = await extractSingleFileFromStream(stream, base);
      if (content === null) {
        res.status(404).json({ error: '卷内文件不存在' });
        return;
      }
      logOperation(res.locals.username, '下载卷文件', 'volume', volume, `路径: ${path}`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(base)}"`);
      res.send(content);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }),
);

/**
 * POST /api/volume-files/:volume/upload?path=&name=
 * 上传文件到卷目录。请求体为 application/octet-stream 原始字节。
 * 用 putArchive 写入辅助容器挂载目录。
 */
router.post(
  '/:volume/upload',
  requireAdmin,
  express.raw({ type: 'application/octet-stream', limit: '500mb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const volume = sanitizeVolumeName(req.params.volume);
    const raw = req.body as Buffer | undefined;
    if (!raw || !Buffer.isBuffer(raw)) {
      res.status(400).json({ error: '请求体为空，请以 application/octet-stream 发送文件内容' });
      return;
    }
    const docker = await getDockerClient();
    const container = await serveVolumeHelper(docker, volume);
    try {
      const dir = sanitizePath(req.query.path as string | undefined);
      const name = String(req.query.name || '').trim().replace(/[\\/]/g, '');
      if (!name) {
        res.status(400).json({ error: '缺少文件名 name 参数' });
        return;
      }
      const targetDir = `${MOUNT_DIR}${dir === '/' ? '' : dir}`;
      const tarBuf = tarBuilderSingleFile(name, raw);
      const input = Readable.from(tarBuf);
      await container.putArchive(input, { path: targetDir });
      logOperation(res.locals.username, '上传卷文件', 'volume', volume, `路径: ${dir}/${name}`);
      res.json({ ok: true, name, path: `${dir}/${name}` });
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }),
);

/**
 * POST /api/volume-files/:volume/mkdir
 * 在卷内新建目录。body={ path }
 */
router.post(
  '/:volume/mkdir',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const volume = sanitizeVolumeName(req.params.volume);
    const path = sanitizePath(req.body?.path as string | undefined);
    if (!path || path === '/') {
      res.status(400).json({ error: '目录路径不能为空' });
      return;
    }
    const docker = await getDockerClient();
    const container = await serveVolumeHelper(docker, volume);
    try {
      const target = `${MOUNT_DIR}${path}`;
      const { exitCode, output } = await execInContainer(container, ['mkdir', '-p', target]);
      if (exitCode !== 0) {
        res.status(400).json({ error: `新建目录失败: ${output || '未知错误'}` });
        return;
      }
      logOperation(res.locals.username, '新建卷目录', 'volume', volume, `路径: ${path}`);
      res.json({ ok: true, path });
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }),
);

/**
 * POST /api/volume-files/:volume/rename
 * 重命名卷内文件/目录。body={ path, newName }
 */
router.post(
  '/:volume/rename',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const volume = sanitizeVolumeName(req.params.volume);
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
    const docker = await getDockerClient();
    const container = await serveVolumeHelper(docker, volume);
    try {
      const dir = `${MOUNT_DIR}${path.split('/').slice(0, -1).join('/') || ''}`;
      const source = `${MOUNT_DIR}${path}`;
      const target = `${dir}/${newName}`.replace(/\/{2,}/g, '/');
      const { exitCode, output } = await execInContainer(container, ['mv', source, target]);
      if (exitCode !== 0) {
        res.status(400).json({ error: `重命名失败: ${output || '未知错误'}` });
        return;
      }
      logOperation(res.locals.username, '重命名卷文件', 'volume', volume, `${path} -> ${newName}`);
      res.json({ ok: true, path: `${path.split('/').slice(0, -1).join('/')}/${newName}` });
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }),
);

/**
 * POST /api/volume-files/:volume/delete
 * 删除卷内文件/目录。body={ path, recursive? }
 */
router.post(
  '/:volume/delete',
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const volume = sanitizeVolumeName(req.params.volume);
    const path = sanitizePath(req.body?.path as string | undefined);
    if (!path || path === '/') {
      res.status(400).json({ error: '路径不能为空或根目录' });
      return;
    }
    const docker = await getDockerClient();
    const container = await serveVolumeHelper(docker, volume);
    try {
      const recursive = req.body?.recursive === true;
      const target = `${MOUNT_DIR}${path}`;
      const cmd = recursive ? ['rm', '-rf', target] : ['rm', '-f', target];
      const { exitCode, output } = await execInContainer(container, cmd);
      if (exitCode !== 0) {
        res.status(400).json({ error: `删除失败: ${output || '未知错误'}` });
        return;
      }
      logOperation(res.locals.username, '删除卷文件', 'volume', volume, `路径: ${path}${recursive ? '（递归）' : ''}`);
      res.json({ ok: true, path });
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }),
);

export default router;
