/**
 * 容器资源级授权共用过滤（1.41.0）
 *
 * 让聚合类接口（全局搜索 / 端口地图 / 网络拓扑 / 日志聚合）与 HTTP 守卫同口径：
 * 配置了容器白名单的用户不应在任何接口看到名单外容器的名称 / 端口 / 日志。
 */
import { getContainerAllowlist } from './users';
import { matchAllowlistEntry } from './routes/containers';

/** 从 dockerode listContainers 行提取容器名（去前导斜杠，回退 12 位短 ID） */
export function containerNameOf(names: string[] | undefined, id?: string): string {
  if (names && names.length && names[0]) return names[0].replace(/^\//, '');
  return (id || '').slice(0, 12);
}

/**
 * 获取当前用户的容器过滤函数。
 * 返回 null = 无需过滤（管理员 / 未配置白名单）；否则返回 (name, id) => 是否允许。
 */
export function allowlistFilterFor(username: string | undefined): ((name: string, id: string) => boolean) | null {
  const allow = getContainerAllowlist(username || '');
  if (!allow) return null;
  return (name: string, id: string) => allow.some((e) => matchAllowlistEntry(e, name, id));
}

/** 校验一组容器 id 是否全部通过白名单（用于按 id 拉取日志等场景） */
export function allIdsAllowed(
  allow: ((name: string, id: string) => boolean) | null,
  ids: string[],
  resolveName?: (id: string) => string,
): boolean {
  if (!allow) return true;
  return ids.every((id) => {
    const name = resolveName ? resolveName(id) : '';
    return allow(name, id) || allow('', id);
  });
}
