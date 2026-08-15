/**
 * 权限守卫 hook：以服务端权威角色判定当前用户是否可执行写/管理操作
 *
 * 传统上前端用 localStorage 中的 role（isAdmin）判断，但该值可被篡改。
 * 本 hook 在本地乐观初值基础上，向后端 /api/auth/me 拉取服务端会话角色并**覆盖**，
 * 从而避免前端基于被篡改的 localStorage 误放行写操作 ——
 * 真正的安全兜底仍是后端 requireAdmin，这里负责前端 UX 层的一致收敛与误导防护。
 */
import { useEffect, useState } from 'react';
import { get } from '../api/client';
import { isAdmin } from '../api/auth';

/** /api/auth/me 返回结构 */
interface MeResult {
  authenticated: boolean;
  username?: string;
  role?: string;
}

/** hook 返回值 */
interface CanManageResult {
  /** 是否为管理员（乐观初值 + 服务端权威收敛结果） */
  canManage: boolean;
  /** 是否仍在服务端校验中（true 时建议对破坏性按钮保持谨慎） */
  checking: boolean;
}

/**
 * 获取"当前用户是否为管理员"的权威判定
 * @returns canManage：是否可管理；checking：是否在请求服务端角色中
 */
export function useCanManage(): CanManageResult {
  // 乐观初值：先用本地缓存角色，避免整页刷新导致按钮闪禁
  const [canManage, setCanManage] = useState<boolean>(() => isAdmin());
  // 服务端校验进行中
  const [checking, setChecking] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 以服务端角色为准（不信任可被修改的 localStorage）
        const me = await get<MeResult>('/api/auth/me');
        if (!cancelled) {
          setCanManage(me?.role === 'admin');
        }
      } catch {
        // 请求失败时回退到本地乐观值，交由后端兜底
      } finally {
        if (!cancelled) {
          setChecking(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { canManage, checking };
}
