/**
 * 路由守卫组件
 *
 * 包裹受保护路由：挂载时校验本地 token 是否存在，存在则进一步调用 /api/auth/me
 * 向后端验证有效性。校验通过则渲染子路由（Outlet），未登录或 token 失效则跳转登录页。
 * 校验期间展示页面级加载态，避免闪屏。
 */
import React, { useEffect, useState } from 'react';
import { useNavigate, Outlet } from 'react-router-dom';
import { get, ApiError } from '../api/client';
import { getToken, clearToken, setRole, type UserRole } from '../api/auth';
import { PageLoading } from './Loading';

/** 校验通过后返回的用户信息 */
interface MeResult {
  authenticated: boolean;
  username?: string;
  role?: UserRole;
}

/**
 * 路由守卫：校验登录态后渲染受保护内容
 */
export default function RequireAuth() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    /**
     * 校验登录态
     */
    async function verify() {
      // 无本地 token，直接跳转登录页
      const token = getToken();
      if (!token) {
        navigate('/login', { replace: true });
        return;
      }
      try {
        // 带 token 调用后端校验接口
        const me = await get<MeResult>('/api/auth/me');
        setRole(me.role || 'user');
        if (!cancelled) {
          setChecking(false);
        }
      } catch (err) {
        // token 无效（401）或网络失败等均视为未登录，清除本地 token 并跳转登录页
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
        }
        if (!cancelled) {
          navigate('/login', { replace: true });
        }
      }
    }

    verify();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // 校验中展示加载态，避免未登录页面闪屏
  if (checking) {
    return <PageLoading />;
  }

  // 校验通过，渲染受保护的子路由
  return <Outlet />;
}
