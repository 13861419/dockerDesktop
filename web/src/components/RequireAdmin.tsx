/**
 * 路由级管理员守卫组件
 *
 * 包裹"仅管理员"路由：挂载时向后端 /api/auth/me 获取服务端会话角色，
 * 以服务端返回结果为准判断是否为管理员（不依赖可被篡改的 localStorage role）。
 * 管理员放行渲染子路由；普通用户则渲染"无权限"提示页（仅隐藏功能入口，
 * 真正的权限强制仍由后端 requireAdmin 兜底，二者构成双重防护）。
 */
import React, { useEffect, useState } from 'react';
import { get, ApiError } from '../api/client';
import { getToken, clearToken } from '../api/auth';
import { PageLoading } from './Loading';

/** 当前会话的用户信息（服务端返回） */
interface MeResult {
  authenticated: boolean;
  username?: string;
  role?: string;
}

/**
 * 管理员路由守卫：校验通过且为管理员时渲染包裹的子页面，否则提示无权限
 * @param param0 children 受保护的页面内容
 */
export default function RequireAdmin({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'allowed' | 'forbidden' | 'unauth'>('checking');

  useEffect(() => {
    let cancelled = false;

    /**
     * 校验当前登录用户是否为管理员（以服务端角色为准）
     */
    async function verify() {
      if (!getToken()) {
        setState('unauth');
        return;
      }
      try {
        const me = await get<MeResult>('/api/auth/me');
        if (!cancelled) {
          setState(me.role === 'admin' ? 'allowed' : 'forbidden');
        }
      } catch (err) {
        // 401 或无 token 视为未登录/会话失效，由外层 RequireAuth 兜底跳转登录页
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
        }
        if (!cancelled) {
          setState('unauth');
        }
      }
    }

    verify();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state !== 'allowed') {
    if (state === 'checking') {
      return <PageLoading />;
    }
    // 未登录：Identity 由外层 RequireAuth 统一处理，这里渲染空壳即可
    if (state === 'unauth') {
      return <PageLoading />;
    }
    // 已登录但非管理员：渲染无权限提示
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
        }}
      >
        <div style={{ textAlign: 'center', padding: '40px 32px', maxWidth: 420 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 18, color: 'var(--text-primary)' }}>
            无权限访问
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            该页面仅管理员可用。如需访问，请联系管理员为您提升权限。
          </p>
        </div>
      </div>
    );
  }

  // 管理员：渲染受保护的页面内容
  return <>{children}</>;
}
