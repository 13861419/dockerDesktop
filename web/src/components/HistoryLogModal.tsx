/**
 * 历史日志查看弹窗（按时间范围分页拉取）
 *
 * 从容器详情页抽出（1.92.0 重构）：按开始/结束时间边界拉取历史日志，
 * 支持下载为文本文件。条件渲染，挂载时即为全新状态。
 */
import { useState } from 'react';
import { get } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface HistoryLogModalProps {
  containerId: string;
  onClose: () => void;
}

export default function HistoryLogModal({ containerId, onClose }: HistoryLogModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [histStart, setHistStart] = useState('');
  const [histEnd, setHistEnd] = useState('');
  const [histLoading, setHistLoading] = useState(false);
  const [histLogs, setHistLogs] = useState<string>('');

  /**
   * 按时间范围拉取历史日志（后端 since/until 为 Unix 秒）
   */
  async function loadHistoryLogs() {
    // 至少需要一个时间边界，否则无意义（等于全量）
    if (!histStart && !histEnd) {
      showToast(t('请指定开始或结束时间'), 'error');
      return;
    }
    setHistLoading(true);
    try {
      const params: Record<string, any> = { tail: 0 };
      if (histStart) {
        params.since = Math.floor(new Date(histStart).getTime() / 1000);
      }
      if (histEnd) {
        params.until = Math.floor(new Date(histEnd).getTime() / 1000);
      }
      const res = await get<{ logs: string }>(`/api/containers/${containerId}/logs`, params);
      const text = res?.logs || '';
      setHistLogs(text.trim() ? text : t('（该时间范围内无日志）'));
    } catch (e: any) {
      showToast(t('拉取历史日志失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setHistLoading(false);
    }
  }

  /**
   * 下载当前历史日志内容为文本文件
   */
  function downloadHistoryLogs() {
    if (!histLogs) return;
    const blob = new Blob([histLogs], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `history-logs-${containerId}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open
      title={t('历史日志')}
      onClose={() => !histLoading && onClose()}
      width={760}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={histLoading}>
            {t('关闭')}
          </Button>
          <Button variant="secondary" size="md" onClick={downloadHistoryLogs} disabled={!histLogs}>
            {t('下载结果')}
          </Button>
          <Button variant="primary" size="md" loading={histLoading} onClick={loadHistoryLogs}>
            {t('拉取日志')}
          </Button>
        </div>
      }
    >
      <div className="histlog__range">
        <label className="histlog__field">
          <span>{t('开始时间（含）')}</span>
          <input
            type="datetime-local"
            value={histStart}
            onChange={(e) => setHistStart(e.target.value)}
          />
        </label>
        <label className="histlog__field">
          <span>{t('结束时间（含）')}</span>
          <input
            type="datetime-local"
            value={histEnd}
            onChange={(e) => setHistEnd(e.target.value)}
          />
        </label>
        <p className="histlog__tip">
          {t('至少填写一个时间边界即可按时间范围拉取历史日志；留空表示不限制该边界。')}
        </p>
      </div>
      <div className="histlog__box">
        {histLogs ? (
          <pre className="histlog__content">{histLogs}</pre>
        ) : (
          <div className="histlog__empty">{t('设置时间范围后点击「拉取日志」查看历史记录。')}</div>
        )}
      </div>
    </Modal>
  );
}
