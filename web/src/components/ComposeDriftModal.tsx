/**
 * Compose 远端配置漂移检测弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：本地 compose 配置与目标引擎实际容器比对，
 * 支持按勾选修复（1.40.0）与删除本地缺失服务（1.42.0）。条件渲染。
 */
import { useState } from 'react';
import { get, post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import Empty from './Empty';
import { Field } from './Form';
import { useToast } from './Toast';
import { translateNow as t } from '../i18n';

interface ComposeDriftModalProps {
  /** 项目名 */
  name: string;
  /** 多引擎提示列表（来自看板预取） */
  engineHints: string[];
  onClose: () => void;
}

export default function ComposeDriftModal({ name, engineHints, onClose }: ComposeDriftModalProps) {
  const { showToast } = useToast();
  const [driftEngine, setDriftEngine] = useState('');
  const [driftRunning, setDriftRunning] = useState(false);
  const [driftResult, setDriftResult] = useState<{ engine: string; driftCount: number; services: Array<{ service: string; status: string; diffs: string[]; local: any; remote: any; containers: number }> } | null>(null);
  const [fixSel, setFixSel] = useState<Record<string, boolean>>({});
  const [fixSelRemove, setFixSelRemove] = useState<Record<string, boolean>>({});
  const [fixRunning, setFixRunning] = useState(false);

  /** 远端配置漂移检测：本地 compose 配置与目标引擎实际容器比对 */
  async function driftCheck() {
    setDriftRunning(true);
    setDriftResult(null);
    try {
      const r = await get<{ engine: string; driftCount: number; services: Array<{ service: string; status: string; diffs: string[]; local: any; remote: any; containers: number }> }>(
        '/api/compose/' + encodeURIComponent(name) + '/drift',
        driftEngine.trim() ? { endpoint: driftEngine.trim() } : undefined,
      );
      setDriftResult(r);
    } catch (e: any) {
      showToast(e?.message || t('漂移检测失败'), 'error');
    } finally {
      setDriftRunning(false);
    }
  }

  /** 漂移自动修复（1.40.0）：勾选要修复的服务，按本地配置重建；1.42.0 支持删除本地缺失（remoteOnly） */
  async function fixDrift() {
    const services = Object.keys(fixSel).filter((k) => fixSel[k]);
    const removeServices = Object.keys(fixSelRemove).filter((k) => fixSelRemove[k]);
    if (services.length === 0 && removeServices.length === 0) {
      showToast(t('请勾选要修复的服务'), 'error');
      return;
    }
    setFixRunning(true);
    try {
      const r = await post<{ ok: boolean; results: Array<{ service: string; ok: boolean; detail: string }> }>(
        '/api/compose/' + encodeURIComponent(name) + '/fix-drift',
        {
          services,
          removeServices,
          ...(driftEngine.trim() ? { endpoint: driftEngine.trim() } : {}),
        },
      );
      const okCount = (r?.results || []).filter((x) => x.ok).length;
      showToast(t('修复完成：成功 {{v1}}，失败 {{v2}}', { v1: okCount, v2: services.length + removeServices.length - okCount }));
      setFixSel({});
      setFixSelRemove({});
      await driftCheck();
    } catch (e: any) {
      showToast(e?.message || t('修复失败'), 'error');
    } finally {
      setFixRunning(false);
    }
  }

  return (
    <Modal open title={t('漂移检测 · {{name}}', { name })} onClose={onClose} width={720}>
      <Field label={t('目标引擎地址（留空 = 本地引擎，如 tcp://192.168.1.10:2375）')}>
        <input
          className="input"
          value={driftEngine}
          onChange={(e) => setDriftEngine(e.target.value)}
          placeholder={engineHints.length > 0 ? engineHints[0] : 'tcp://192.168.1.10:2375'}
        />
      </Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <Button variant="primary" loading={driftRunning} onClick={() => void driftCheck()}>
          {t('开始检测')}
        </Button>
      </div>
      {driftResult && driftResult.driftCount > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Button variant="secondary" loading={fixRunning} onClick={() => void fixDrift()}>
            {t('一键修复（按本地配置重建）')}
          </Button>
        </div>
      )}
      {driftResult && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13, margin: '4px 0 8px' }}>
            {driftResult.driftCount === 0
              ? t('全部服务与本地配置一致，未检测到漂移')
              : t('检测到 {{n}} 个服务存在差异', { n: driftResult.driftCount })}
          </p>
          {driftResult.services.length === 0 ? (
            <Empty title={t('目标引擎上未发现该项目的容器')} />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('修复')}</th>
                  <th>{t('服务')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('差异项')}</th>
                </tr>
              </thead>
              <tbody>
                {driftResult.services.map((s) => (
                  <tr key={s.service}>
                    <td>
                      {s.status === 'drift' || s.status === 'localOnly' ? (
                        <input
                          type="checkbox"
                          checked={!!fixSel[s.service]}
                          onChange={(e) => setFixSel((prev) => ({ ...prev, [s.service]: e.target.checked }))}
                        />
                      ) : s.status === 'remoteOnly' ? (
                        <input
                          type="checkbox"
                          title={t('删除远端上该服务的容器')}
                          checked={!!fixSelRemove[s.service]}
                          onChange={(e) => setFixSelRemove((prev) => ({ ...prev, [s.service]: e.target.checked }))}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="col-name">{s.service}</td>
                    <td>
                      {s.status === 'match'
                        ? t('一致')
                        : s.status === 'drift'
                          ? t('漂移')
                          : s.status === 'localOnly'
                            ? t('远端缺失')
                            : t('本地缺失')}
                    </td>
                    <td>{s.diffs.join(', ') || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Modal>
  );
}
