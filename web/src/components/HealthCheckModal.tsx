/**
 * 健康检查编辑弹窗（通过重建容器生效）
 *
 * 从容器详情页抽出（1.92.0 重构）：以当前健康检查配置预填（test 去掉 CMD 前缀
 * 后以空格连接），提交后通过重建容器套用（一并保留现有环境变量）。
 * 条件渲染，成功后回调 onDone 刷新详情。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface HealthCheckModalProps {
  containerId: string;
  /** 当前健康检查配置（undefined = 未配置） */
  healthcheck?: { test?: string[]; interval?: number; timeout?: number; retries?: number } | null;
  /** 当前容器环境变量（重建时由后端保留，此处原样传回） */
  env: Record<string, string>;
  onClose: () => void;
  /** 保存成功后通知调用方刷新详情 */
  onDone: () => void;
}

export default function HealthCheckModal({ containerId, healthcheck, env, onClose, onDone }: HealthCheckModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [hcEnabled, setHcEnabled] = useState(() => {
    const hc = healthcheck;
    return !!hc && !!hc.test && hc.test.length > 0 && hc.test[0] !== 'NONE';
  });
  const [hcTestCmd, setHcTestCmd] = useState(() => {
    const hc = healthcheck;
    if (hc && hc.test && hc.test.length > 0) {
      // test 形如 ['CMD','curl','-f','http://...']，去掉 CMD 前缀后以空格连接
      const parts = hc.test[0] === 'CMD' ? hc.test.slice(1) : hc.test;
      return parts.join(' ');
    }
    return '';
  });
  const [hcInterval, setHcInterval] = useState(healthcheck?.interval || 30);
  const [hcTimeout, setHcTimeout] = useState(healthcheck?.timeout || 5);
  const [hcRetries, setHcRetries] = useState(healthcheck?.retries || 3);
  const [hcSaving, setHcSaving] = useState(false);

  /** 保存健康检查配置（通过重建容器生效；一并保留现有环境变量） */
  async function saveHealth() {
    setHcSaving(true);
    try {
      let healthcheckBody: any;
      if (hcEnabled) {
        const parts = hcTestCmd.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          showToast(t('请填写健康检查命令'), 'error');
          setHcSaving(false);
          return;
        }
        healthcheckBody = {
          test: ['CMD', ...parts],
          interval: hcInterval || 0,
          timeout: hcTimeout || 0,
          retries: hcRetries || 0,
        };
      } else {
        // 禁用健康检查
        healthcheckBody = { test: ['NONE'], interval: 0, timeout: 0, retries: 0 };
      }
      // 通过重建容器套用健康检查（其余配置由后端从原容器保留）
      await post(`/api/containers/${containerId}/recreate`, {
        env,
        healthcheck: healthcheckBody,
      });
      showToast(t('健康检查已更新（容器已重建）'));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(e?.message || t('更新健康检查失败'), 'error');
    } finally {
      setHcSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t('健康检查')}
      onClose={() => !hcSaving && onClose()}
      width={520}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={hcSaving}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={hcSaving} onClick={saveHealth}>
            {t('保存并重建')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('修改健康检查需重新创建容器（其余配置保留）。重建会导致容器短暂中断，容器 ID 会改变。')}
      </div>
      <Field label={t('启用健康检查')}>
        <label className="cfg-modal__priv">
          <input
            type="checkbox"
            checked={hcEnabled}
            onChange={(e) => setHcEnabled(e.target.checked)}
          />
          {t('启用（监测容器运行状况并在详情页展示）')}
        </label>
      </Field>
      {hcEnabled && (
        <>
          <Field label={t('检测命令')} required>
            <Input
              placeholder={t('如 curl -f http://localhost 或 node /app/health.js')}
              value={hcTestCmd}
              onChange={(e) => setHcTestCmd(e.target.value)}
            />
          </Field>
          <Field label={t('检测间隔（秒）')}>
            <Input
              type="number"
              min={1}
              value={String(hcInterval)}
              onChange={(e) => setHcInterval(Number(e.target.value))}
            />
          </Field>
          <Field label={t('超时（秒）')}>
            <Input
              type="number"
              min={1}
              value={String(hcTimeout)}
              onChange={(e) => setHcTimeout(Number(e.target.value))}
            />
          </Field>
          <Field label={t('重试次数')}>
            <Input
              type="number"
              min={1}
              value={String(hcRetries)}
              onChange={(e) => setHcRetries(Number(e.target.value))}
            />
          </Field>
        </>
      )}
    </Modal>
  );
}
