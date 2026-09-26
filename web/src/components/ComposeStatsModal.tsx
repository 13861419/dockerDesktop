/**
 * Compose 项目资源看板弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：按服务聚合 CPU / 内存 / 网络 / IO
 * + 服务级滚动更新，内含漂移检测与跨引擎镜像分发子弹窗。条件渲染。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import Empty from './Empty';
import { SkeletonRows } from './Loading';
import { useToast } from './Toast';
import { useCanManage } from '../hooks/useCanManage';
import { translateNow as t } from '../i18n';
import ComposeDriftModal from './ComposeDriftModal';
import ComposeDistributeModal from './ComposeDistributeModal';

/** 单服务聚合资源数据（stats 接口） */
export interface ProjectStatService {
  name: string;
  containers: number;
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  ioR: number;
  ioW: number;
}

/** 字节快捷格式化（资源看板用） */
function formatBytesShort(n: number): string {
  if (!n || n <= 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < 4) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${units[i]}`;
}

interface ComposeStatsModalProps {
  /** 项目名 */
  name: string;
  onClose: () => void;
}

export default function ComposeStatsModal({ name, onClose }: ComposeStatsModalProps) {
  const { showToast } = useToast();
  const canManage = useCanManage();
  const [statsData, setStatsData] = useState<ProjectStatService[] | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [rollingSvc, setRollingSvc] = useState('');
  const [rollingAllRunning, setRollingAllRunning] = useState(false);
  const [driftOpen, setDriftOpen] = useState(false);
  const [distOpen, setDistOpen] = useState(false);
  const [engineHints, setEngineHints] = useState<string[]>([]);

  const projectUrl = useCallback((n: string) => '/api/compose/' + encodeURIComponent(n), []);

  /** 拉取资源看板数据 */
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsData(null);
    try {
      const data = await get<{ services: ProjectStatService[] }>(projectUrl(name) + '/stats');
      setStatsData(data.services || []);
    } catch {
      setStatsData([]);
    } finally {
      setStatsLoading(false);
    }
  }, [name, projectUrl]);

  // 挂载时拉取一次；同时预取多引擎提示（供漂移/分发弹窗占位）
  useEffect(() => {
    void loadStats();
    (async () => {
      try {
        const data = await get<{ engines?: Array<{ endpoint: string }> }>('/api/engines');
        const list = (data.engines || []).map((e) => e.endpoint).filter((e) => e && (e.startsWith('tcp://') || e.startsWith('http')));
        setEngineHints(list);
      } catch {
        setEngineHints([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  /** 服务级滚动更新：pull 最新镜像 + 仅重建该服务；失败自动回滚（1.35.0） */
  const rollingUpdate = useCallback(
    async (service: string) => {
      setRollingSvc(service);
      try {
        const r = await post<{ ok: boolean; rolledBack?: boolean; healthOk?: boolean }>(
          projectUrl(name) + '/rolling-update',
          { service },
        );
        if (r.rolledBack) showToast(t('更新失败，已自动回滚到旧镜像'), 'error');
        else if (r.healthOk === false) showToast(t('更新完成，但健康检查未通过'), 'error');
        else showToast(t('服务 {{s}} 已更新并重建', { s: service }), 'success');
        const data = await get<{ services: ProjectStatService[] }>(projectUrl(name) + '/stats');
        setStatsData(data.services || []);
      } catch (e: any) {
        showToast(e?.message || t('滚动更新失败'), 'error');
      } finally {
        setRollingSvc('');
      }
    },
    [name, projectUrl, showToast],
  );

  /** 全项目滚动更新编排（1.37.0）：按服务顺序逐个滚动更新，单服务失败不中断 */
  const rollingUpdateAll = useCallback(async () => {
    setRollingAllRunning(true);
    try {
      const r = await post<{
        ok: boolean;
        summary: string;
        results: Array<{ service: string; ok: boolean; healthOk: boolean; rolledBack: boolean; detail: string }>;
      }>(projectUrl(name) + '/rolling-update-all', {});
      for (const item of r.results || []) {
        if (item.ok) showToast(t('服务 {{s}} 已更新并重建', { s: item.service }), 'success');
        else if (item.rolledBack) showToast(t('服务 {{s}} 更新失败，已自动回滚到旧镜像', { s: item.service }), 'error');
        else showToast(t('服务 {{s}} 更新失败', { s: item.service }), 'error');
      }
      showToast(r.summary || (r.ok ? t('全部服务更新完成') : t('部分服务更新失败')), r.ok ? 'success' : 'error');
      const data = await get<{ services: ProjectStatService[] }>(projectUrl(name) + '/stats');
      setStatsData(data.services || []);
    } catch (e: any) {
      showToast(e?.message || t('滚动更新失败'), 'error');
    } finally {
      setRollingAllRunning(false);
    }
  }, [name, projectUrl, showToast]);

  return (
    <>
      <Modal open title={t('项目资源看板 · {{name}}', { name })} onClose={onClose} width={860}>
        {statsLoading ? (
          <SkeletonRows rows={4} />
        ) : !statsData || statsData.length === 0 ? (
          <Empty title={t('该项目暂无运行中的容器')} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('服务')}</th>
                <th>{t('容器数')}</th>
                <th>CPU</th>
                <th>{t('内存')}</th>
                <th>{t('网络 RX/TX')}</th>
                <th>{t('磁盘读/写')}</th>
                <th className="col-actions">{t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {statsData.map((s) => (
                <tr key={s.name}>
                  <td className="col-name">{s.name}</td>
                  <td>{s.containers}</td>
                  <td>{s.cpuPercent.toFixed(2)}%</td>
                  <td>{formatBytesShort(s.memUsage)}{s.memLimit > 0 ? ` / ${formatBytesShort(s.memLimit)}` : ''}</td>
                  <td>{formatBytesShort(s.netRx)} / {formatBytesShort(s.netTx)}</td>
                  <td>{formatBytesShort(s.ioR)} / {formatBytesShort(s.ioW)}</td>
                  <td className="col-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={rollingSvc === s.name}
                      disabled={!canManage}
                      onClick={() => void rollingUpdate(s.name)}
                    >
                      {t('滚动更新')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button
            variant="secondary"
            size="sm"
            loading={rollingAllRunning}
            disabled={!canManage || !statsData || statsData.length === 0}
            onClick={() => void rollingUpdateAll()}
          >
            {t('全部滚动更新')}
          </Button>
          <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => setDriftOpen(true)}>
            {t('漂移检测')}
          </Button>
          <Button variant="ghost" size="sm" disabled={!canManage} onClick={() => setDistOpen(true)}>
            {t('分发镜像到其他引擎')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void loadStats()}>
            {t('刷新')}
          </Button>
        </div>
      </Modal>

      {/* 跨引擎镜像分发（1.34.0） */}
      {distOpen && <ComposeDistributeModal name={name} engineHints={engineHints} onClose={() => setDistOpen(false)} />}

      {/* 远端配置漂移检测（1.37.0） */}
      {driftOpen && <ComposeDriftModal name={name} engineHints={engineHints} onClose={() => setDriftOpen(false)} />}
    </>
  );
}
