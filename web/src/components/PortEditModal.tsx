/**
 * 端口映射编辑弹窗（通过重建容器生效）
 *
 * 从容器详情页抽出（1.92.0 重构）：以当前端口映射初始化草稿（容器端口 / 宿主机映射 / 协议），
 * 宿主机栏支持「8080」或「127.0.0.1:8080」写法，提交后重建容器。条件渲染，成功后回调 onDone。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Input, Select } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

/** 详情页端口信息（internal 如 "80/tcp"，published 为宿主机映射列表） */
export interface DetailPort {
  internal?: string;
  published?: Array<{ hostPort?: number | string; hostIp?: string }>;
}

interface PortEditModalProps {
  containerId: string;
  /** 当前容器的端口映射（用于初始化草稿） */
  ports: DetailPort[];
  onClose: () => void;
  /** 保存成功后通知调用方刷新详情 */
  onDone: () => void;
}

export default function PortEditModal({ containerId, ports, onClose, onDone }: PortEditModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [portDraft, setPortDraft] = useState<Array<{ container: string; host: string; protocol: string }>>(() => {
    // detail.ports 为 internal/published 格式（如 internal "80/tcp"），需要拆分出容器端口与协议；
    // published 取第一个 hostPort 作为宿主机端口，并带上 hostIp 前缀（默认 0.0.0.0），
    // 避免编辑保存后丢失 127.0.0.1 等指定 IP 的绑定。
    const entries = (ports || []).map((p) => {
      const [container, proto] = (p.internal || '').split('/');
      const first = p.published && p.published.length > 0 ? p.published[0] : null;
      const hostPort = first ? String(first.hostPort) : '';
      const hostIp = first?.hostIp || '0.0.0.0';
      return {
        container: container || '',
        host: hostPort ? `${hostIp}:${hostPort}` : '',
        protocol: (proto || 'tcp') as string,
      };
    });
    return entries.length ? entries : [{ container: '', host: '', protocol: 'tcp' }];
  });
  const [portSaving, setPortSaving] = useState(false);

  /** 更新端口草稿中单个条目 */
  function updatePortDraft(index: number, field: 'container' | 'host' | 'protocol', value: string) {
    setPortDraft((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  /** 删除端口草稿中某个条目 */
  function removePortDraft(index: number) {
    setPortDraft((prev) => prev.filter((_, i) => i !== index));
  }

  /** 新增一个端口映射条目 */
  function addPortDraft() {
    setPortDraft((prev) => [...prev, { container: '', host: '', protocol: 'tcp' }]);
  }

  /**
   * 保存端口映射：过滤空项并组装 ports 数组（container 转数字）后重建容器。
   * 宿主机栏支持「8080」或「127.0.0.1:8080」两种写法，保留指定的绑定 IP。
   */
  async function savePorts() {
    // 过滤容器端口为空的条目，并组装 ports 数组
    const mapped = portDraft
      .filter((item) => item.container.trim() !== '')
      .map((item) => {
        const raw = item.host.trim();
        const m = raw.match(/^(?:(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\])):(\d+)$/);
        const hostIp = m ? m[1].replace(/^\[|\]$/g, '') : '0.0.0.0';
        const host = m ? m[2] : raw;
        return {
          host,
          hostIp: host ? hostIp : '',
          container: Number(item.container.trim()),
          protocol: item.protocol,
        };
      });
    setPortSaving(true);
    try {
      await post(`/api/containers/${containerId}/recreate`, { ports: mapped });
      showToast(t('端口映射已更新（容器已重建）'));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('更新失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setPortSaving(false);
    }
  }

  return (
    <Modal
      open
      title={t('编辑端口映射')}
      onClose={() => !portSaving && onClose()}
      width={640}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={portSaving}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={portSaving} onClick={savePorts}>
            {t('保存并重建')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('修改端口映射需重新创建容器（保留镜像、挂载、网络、环境变量等配置）。「容器端口」为容器内端口；「宿主机端口」支持「8080」或「127.0.0.1:8080」写法，仅写端口时默认绑定 0.0.0.0，未填写时以容器端口随机映射。')}
      </div>
      <div className="port-modal__head">
        <span className="port-modal__col-container">{t('容器端口')}</span>
        <span className="port-modal__col-host">{t('宿主机映射')}</span>
        <span className="port-modal__col-protocol">{t('协议')}</span>
        <span className="port-modal__col-op" />
      </div>
      <div className="port-modal__list">
        {portDraft.map((item, index) => (
          <div className="port-modal__row" key={index}>
            <Input
              className="port-modal__col-container"
              placeholder="80"
              value={item.container}
              onChange={(e) => updatePortDraft(index, 'container', e.target.value)}
            />
            <Input
              className="port-modal__col-host"
              placeholder={t('0.0.0.0:8080（可选）')}
              value={item.host}
              onChange={(e) => updatePortDraft(index, 'host', e.target.value)}
            />
            <Select
              className="port-modal__col-protocol"
              value={item.protocol}
              onChange={(e) => updatePortDraft(index, 'protocol', e.target.value)}
            >
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              className="port-modal__col-op"
              onClick={() => removePortDraft(index)}
              disabled={portSaving}
              title={t('删除这项端口')}
            >
              {t('删除')}
            </Button>
          </div>
        ))}
      </div>
      <div className="env-modal__add">
        <Button variant="secondary" size="sm" onClick={addPortDraft} disabled={portSaving}>
          {t('+ 添加端口')}
        </Button>
      </div>
    </Modal>
  );
}
