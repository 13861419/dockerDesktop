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
import { useLang } from '../i18n';
import './login.less';

/** 登录接口返回的数据结构 */
interface LoginResult {
  token?: string;
  username?: string;
  role?: UserRole;
  mustChangePassword?: boolean;
  /** 2FA：需要二次验证 */
  totpRequired?: boolean;
  /** 2FA 登录票据（2 分钟有效） */
  ticket?: string;
}

/**
 * 登录页组件
 */
export default function LoginPage() {
  const { t } = useLang();
  const { showToast } = useToast();
  const navigate = useNavigate();
  // 受控表单状态
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // 2FA 状态：第一步密码通过后进入验证码输入阶段
  const [totpTicket, setTotpTicket] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpUser, setTotpUser] = useState('');

  /**
   * 处理表单提交
   * @param e 提交事件
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      // 2FA 第二步：携带票据与验证码
      if (totpTicket) {
        if (!/^\d{6}$/.test(totpCode)) {
          showToast(t('请输入 6 位验证码'), 'error');
          return;
        }
        const res = await post<LoginResult>('/api/auth/login', { ticket: totpTicket, code: totpCode });
        setToken(res.token!);
        setRole(res.role || 'user');
        showToast(t('登录成功'), 'success');
        navigate('/', { replace: true });
        return;
      }
      if (!username.trim() || !password) {
        showToast(t('请输入用户名和密码'), 'error');
        return;
      }
      const res = await post<LoginResult>('/api/auth/login', { username, password });
      // 2FA 第一步通过：进入验证码输入
      if (res.totpRequired && res.ticket) {
        setTotpTicket(res.ticket);
        setTotpUser(res.username || username);
        showToast(t('请输入认证器验证码'), 'info');
        return;
      }
      setToken(res.token!);
      setRole(res.role || 'user');
      // 强制改密：首次使用默认密码需先修改密码
      if (res.mustChangePassword) {
        showToast(t('请先修改默认密码'), 'info');
        navigate('/settings', { replace: true, state: { forceChangePassword: true } });
        return;
      }
      showToast(t('登录成功'), 'success');
      // 登录成功后跳转首页（替换历史记录，避免回退回到登录页）
      navigate('/', { replace: true });
    } catch (err: any) {
      showToast(err?.message || t('登录失败，请重试'), 'error');
    } finally {
      setLoading(false);
    }
  }

  // 2FA 验证码输入视图
  if (totpTicket) {
    return (
      <div className="login-page">
        <Card className="login-card">
          <div className="login-card__header">
            <div className="login-card__logo">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div className="login-card__title">{t('两步验证')}</div>
            <div className="login-card__subtitle">{t('请输入认证器中的 6 位验证码（{{name}}）', { name: totpUser })}</div>
          </div>
          <form className="login-card__form" onSubmit={handleSubmit}>
            <Field label={t('验证码')} required>
              <Input
                type="text"
                value={totpCode}
                placeholder={t('6 位数字验证码')}
                autoComplete="one-time-code"
                maxLength={6}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Button type="submit" variant="primary" size="md" loading={loading} className="login-card__submit">
              {t('验 证')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => {
                setTotpTicket(null);
                setTotpCode('');
              }}
            >
              {t('返回重新登录')}
            </Button>
          </form>
        </Card>
      </div>
    );
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
          <div className="login-card__title">{t('登录 Docker 管理面板')}</div>
          <div className="login-card__subtitle">{t('请输入账号密码以继续')}</div>
        </div>

        <form className="login-card__form" onSubmit={handleSubmit}>
          <Field label={t('用户名')} required>
            <Input
              type="text"
              value={username}
              placeholder={t('请输入用户名')}
              autoComplete="username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label={t('密码')} required>
            <Input
              type="password"
              value={password}
              placeholder={t('请输入密码')}
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
            {t('登 录')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
