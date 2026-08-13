/**
 * 登录页
 *
 * 居中卡片展示登录表单，使用受控 state 管理用户名与密码，
 * 提交时调用 POST /api/auth/login，成功后写入 token 并跳转首页。
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../api/client';
import { setRole, setToken, type UserRole } from '../api/auth';
import Card from '../components/Card';
import Button from '../components/Button';
import { Field, Input } from '../components/Form';
import { useToast } from '../components/Toast';
import './login.less';

/** 登录接口返回的数据结构 */
interface LoginResult {
  token: string;
  username: string;
  role?: UserRole;
  mustChangePassword?: boolean;
}

/**
 * 登录页组件
 */
export default function LoginPage() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  // 受控表单状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  /**
   * 处理表单提交
   * @param e 提交事件
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      showToast('请输入用户名和密码', 'error');
      return;
    }
    setLoading(true);
    try {
      const res = await post<LoginResult>('/api/auth/login', { username, password });
      setToken(res.token);
      setRole(res.role || 'user');
      // 强制改密：首次使用默认密码需先修改密码
      if (res.mustChangePassword) {
        showToast('请先修改默认密码', 'info');
        navigate('/settings', { replace: true, state: { forceChangePassword: true } });
        return;
      }
      showToast('登录成功', 'success');
      // 登录成功后跳转首页（替换历史记录，避免回退回到登录页）
      navigate('/', { replace: true });
    } catch (err: any) {
      showToast(err?.message || '登录失败，请重试', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <Card className="login-card">
        <div className="login-card__header">
          <div className="login-card__logo">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z" />
              <path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
              <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
            </svg>
          </div>
          <div className="login-card__title">登录 Docker 管理面板</div>
          <div className="login-card__subtitle">请输入账号密码以继续</div>
        </div>

        <form className="login-card__form" onSubmit={handleSubmit}>
          <Field label="用户名" required>
            <Input
              type="text"
              value={username}
              placeholder="请输入用户名"
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="密码" required>
            <Input
              type="password"
              value={password}
              placeholder="请输入密码"
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={loading}
            className="login-card__submit"
          >
            登 录
          </Button>
        </form>
      </Card>
    </div>
  );
}
