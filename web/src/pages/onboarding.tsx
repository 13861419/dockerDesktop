/**
 * 首次启动向导（1.88.0）：欢迎改密 → 环境扫描 → 可选配置 → 迁移对照
 * 仅管理员可见；每步独立调用 API 即时生效，可随时跳过。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../components/Button';
import { useToast } from '../components/Toast';
import { get, put } from '../api/client';
import { isAdmin } from '../api/auth';
import { translateNow as t } from '../i18n';
import './onboarding.less';

interface ScanResult { containers: number; images: number; compose: number }

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [step, setStep] = useState(1);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');

  useEffect(() => {
    document.title = t('欢迎使用 Docker Manager');
    // 默认账号判定：/api/auth/me 返回当前用户名（web/src/api/auth.ts 无 getUsername）
    get<{ username: string }>('/api/auth/me').then((r) => setUsername(r.username)).catch(() => {});
  }, []);

  /** 完成并写标记（bool 归一化由 settings 层处理）；失败提示并停留，避免静默卡死 */
  const finish = async () => {
    try {
      await put('/api/settings/onboarding.done', { value: true });
      navigate('/');
    } catch (e: any) {
      showToast(e?.message || t('写入失败，请重试'), 'error');
    }
  };

  /** 步骤②：并行扫描本机环境（失败降级为 0，不阻塞） */
  const runScan = async () => {
    setBusy(true);
    const [c, i, cp] = await Promise.all([
      get<any[]>('/api/containers', { all: true }).catch(() => []),
      get<any[]>('/api/images').catch(() => []),
      get<any[]>('/api/compose').catch(() => []),
    ]);
    setScan({
      containers: Array.isArray(c) ? c.length : 0,
      images: Array.isArray(i) ? i.length : 0,
      compose: Array.isArray(cp) ? cp.filter((x: any) => x.source === 'external').length : 0,
    });
    setBusy(false);
  };
  useEffect(() => { if (step === 2 && !scan) { setBusy(true); runScan(); } }, [step]);

  return (
    <div className="onboard">
      <div className="onboard__progress">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={`onboard__dot ${step >= n ? 'is-active' : ''}`} />
        ))}
      </div>
      {step === 1 && (
        <div>
          <h1>{t('欢迎使用 Docker Manager')}</h1>
          <p>{t('本向导将带你完成初始设置（约 1 分钟）。')}</p>
          {username === 'admin' && (
            <div className="onboard__warn">
              {t('当前使用默认管理员账号，建议立即修改密码。')}
              <Button size="sm" onClick={() => navigate('/settings')}>{t('立即改密')}</Button>
            </div>
          )}
          <Button variant="primary" onClick={() => setStep(2)}>{t('开始')}</Button>
        </div>
      )}
      {step === 2 && (
        <div>
          <h1>{t('检测本机环境')}</h1>
          {busy ? <p>{t('扫描中...')}</p> : (
            <p>{t('发现 {{c}} 个容器、{{i}} 个镜像、{{k}} 个外部 Compose 项目（已自动纳管）', { c: scan?.containers ?? 0, i: scan?.images ?? 0, k: scan?.compose ?? 0 })}</p>
          )}
          <Button onClick={() => setStep(3)}>{t('下一步')}</Button>
        </div>
      )}
      {step === 3 && (
        <div>
          <h1>{t('可选：常用配置直达')}</h1>
          <p>{t('镜像加速源（国内建议配置）与告警通知渠道可稍后在对应页面设置，均可跳过。')}</p>
          <div className="onboard__links">
            <Button onClick={() => navigate('/hub')}>{t('镜像源设置')}</Button>
            <Button onClick={() => navigate('/notifications')}>{t('告警通知渠道')}</Button>
          </div>
          <Button variant="primary" onClick={() => setStep(4)}>{t('下一步')}</Button>
        </div>
      )}
      {step === 4 && (
        <div>
          <h1>{t('从 1Panel / 宝塔迁移对照')}</h1>
          <table className="onboard__table">
            <tbody>
              <tr><td>{t('网站 / 反向代理')}</td><td>{t('站点反代 + SSL 证书')}</td></tr>
              <tr><td>{t('应用商店')}</td><td>{t('应用商店（AppStore）')}</td></tr>
              <tr><td>{t('计划任务')}</td><td>{t('计划任务')}</td></tr>
              <tr><td>{t('本产品独有')}</td><td>{t('Edge 多节点 / Git 自动部署 / 高危操作审批流')}</td></tr>
            </tbody>
          </table>
          <Button variant="primary" onClick={finish}>{t('完成，进入面板')}</Button>
        </div>
      )}
      <Button variant="ghost" onClick={finish}>{t('跳过向导')}</Button>
    </div>
  );
}
