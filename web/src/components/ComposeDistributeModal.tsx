/**
 * Compose 跨引擎镜像分发弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：把项目镜像预拉取到远端引擎，
 * 可选继续代理部署。条件渲染。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field } from './Form';
import { useToast } from './Toast';
import { translateNow as t } from '../i18n';

interface ComposeDistributeModalProps {
  /** 项目名 */
  name: string;
  /** 多引擎提示列表（来自看板预取，作为占位示例） */
  engineHints: string[];
  onClose: () => void;
}

export default function ComposeDistributeModal({ name, engineHints, onClose }: ComposeDistributeModalProps) {
  const { showToast } = useToast();
  const [distEngines, setDistEngines] = useState('');
  const [distDeploy, setDistDeploy] = useState(false);
  const [distRunning, setDistRunning] = useState(false);

  /** 跨引擎镜像分发：把项目镜像预拉取到远端引擎，可选继续代理部署（1.35.0） */
  async function distribute() {
    const engines = distEngines
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (engines.length === 0) {
      showToast(t('请至少填写一个远端引擎地址'), 'error');
      return;
    }
    setDistRunning(true);
    try {
      const r = await post<{ ok: boolean; results: Array<{ engine: string; image: string; ok: boolean; detail: string }> }>(
        '/api/compose/' + encodeURIComponent(name) + '/distribute',
        { engines, deploy: distDeploy },
      );
      const fail = r.results.filter((x) => !x.ok).length;
      showToast(fail === 0 ? t('全部镜像分发成功') : t('{{n}} 项分发失败，详见操作日志', { n: fail }), fail === 0 ? 'success' : 'error');
      onClose();
    } catch (e: any) {
      showToast(e?.message || t('分发失败'), 'error');
    } finally {
      setDistRunning(false);
    }
  }

  return (
    <Modal open title={t('分发镜像 · {{name}}', { name })} onClose={onClose} width={520}>
      <Field label={t('远端引擎地址（每行一个，如 tcp://192.168.1.10:2375）')}>
        <textarea
          className="input compose-distribute__engines"
          rows={4}
          value={distEngines}
          onChange={(e) => setDistEngines(e.target.value)}
          placeholder={engineHints.length > 0 ? engineHints.join('\n') : 'tcp://192.168.1.10:2375'}
        />
      </Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '4px 0 8px', cursor: 'pointer' }}>
        <input type="checkbox" checked={distDeploy} onChange={(e) => setDistDeploy(e.target.checked)} />
        {t('分发后在远端启动（代理部署）')}
      </label>
      <p style={{ fontSize: 12, opacity: 0.65 }}>
        {t('将把该项目的全部服务镜像预拉取到所选引擎（作为远端代理部署的前置步骤），完成后远端启动即刻可用。')}
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <Button variant="secondary" onClick={onClose}>
          {t('取消')}
        </Button>
        <Button variant="primary" loading={distRunning} onClick={() => void distribute()}>
          {t('开始分发')}
        </Button>
      </div>
    </Modal>
  );
}
