/**
 * 镜像多源拉取工具（共享模块）
 *
 * 提供"逐一尝试多个镜像加速源、失败自动切换"的拉取能力，
 * 供应用商店安装等场景复用（与 /api/images/pull 的多源 failover 行为一致）。
 * 国内镜像加速源可能被限流(429)或临时不可用，多源依次尝试可显著提升拉取成功率。
 */
import Dockerode from 'dockerode';
import { buildPullRef, listSources } from '../hubConfig';

/** 一次成功拉取的结果 */
export interface PullSuccess {
  /** 最终使用的实际镜像引用（带镜像源主机前缀） */
  ref: string;
  /** 实际使用的镜像源主机；官方源时为 'docker.io' */
  source: string;
}

/**
 * 等待一次 docker pull 完成（严格模式：失败会抛出异常）
 *
 * 通过 dockerode 的 pull 回调拿到可读流，监听流结束/错误以等待完成。
 * @param docker dockerode 客户端
 * @param ref 要拉取的镜像引用
 * @param auth 可选认证配置（私有仓库）
 * @returns Promise，拉取失败时抛出
 */
export async function pullAndWait(
  docker: Dockerode,
  ref: string,
  auth?: { username?: string; password?: string },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const authconfig = auth?.username || auth?.password ? auth : undefined;
    docker.pull(ref, { authconfig }, (err: any, stream: NodeJS.ReadableStream | undefined) => {
      if (err) {
        reject(err);
        return;
      }
      if (!stream) {
        resolve();
        return;
      }
      let settled = false;
      const done = (e?: any) => {
        if (settled) return;
        settled = true;
        if (e) reject(e);
        else resolve();
      };
      stream.on('end', () => done());
      stream.on('error', (e) => done(e));
      stream.on('close', () => done());
    });
  });
}

/**
 * 带多源自动切换的镜像拉取
 *
 * 候选源顺序：显式指定源优先，其后追加所有启用的镜像源；都未指定时回退官方 Docker 仓库。
 * 逐一对候选源执行严格拉取，某个源失败（限流/网络/镜像不存在）则切换到下一个，
 * 直到某源拉取成功并返回该源的实际引用，供调用方用它创建容器等后续操作。
 *
 * @param docker dockerode 客户端
 * @param baseRef 原始镜像引用（如 nginx:latest）
 * @param explicitSource 用户显式指定的镜像源主机（可选，优先）
 * @param auth 可选认证配置
 * @returns 成功时返回实际 ref 与 source
 * @throws 全部候选源都失败时抛出最后一个错误
 */
export async function pullWithFailover(
  docker: Dockerode,
  baseRef: string,
  explicitSource?: string,
  auth?: { username?: string; password?: string },
): Promise<PullSuccess> {
  // 候选源：显式指定源优先，其次所有启用镜像源；无任何源时回退官方仓库
  const enabledHosts = (listSources() || [])
    .filter((s) => s.enabled)
    .map((s) => s.host)
    .filter(Boolean) as string[];
  const rawCands = explicitSource ? [explicitSource, ...enabledHosts] : enabledHosts;
  if (rawCands.length === 0) {
    rawCands.push('');
  }
  // 去重并保持顺序
  const seen = new Set<string>();
  const cands = rawCands.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  let lastErr: any = null;
  for (const src of cands) {
    const ref = buildPullRef(baseRef, src);
    try {
      await pullAndWait(docker, ref, auth);
      return { ref, source: src || 'docker.io' };
    } catch (e: any) {
      // 当前源拉取失败，记录后尝试下一个源
      lastErr = e;
    }
  }
  throw lastErr || new Error('镜像拉取失败');
}
