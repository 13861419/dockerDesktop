/**
 * 执行命令弹窗（非交互式 exec）
 *
 * 从容器详情页抽出（1.92.0 重构）：在容器内执行单条命令，
 * 展示 stdout/stderr 拼接输出与退出码。条件渲染，挂载时即为全新状态。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface ExecCommandModalProps {
  containerId: string;
  onClose: () => void;
}

export default function ExecCommandModal({ containerId, onClose }: ExecCommandModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [execCmd, setExecCmd] = useState('');
  const [execOutput, setExecOutput] = useState('');
  const [execExitCode, setExecExitCode] = useState<number | null>(null);
  const [executing, setExecuting] = useState(false);

  /**
   * 在容器内执行单条命令（非交互式），展示 stdout/stderr 拼接输出与退出码
   *
   * 若容器未运行，后端返回 400「容器未运行」，此处仅弹 toast 提示。
   */
  async function submitExec() {
    // 命令必填校验
    if (!execCmd.trim()) {
      showToast(t('请输入要执行的命令'), 'error');
      return;
    }
    setExecuting(true);
    // 清空上一次输出，进入新一轮执行
    setExecOutput('');
    setExecExitCode(null);
    try {
      const res = await post<{ ok: boolean; exitCode: number | null; output: string }>(
        `/api/containers/${containerId}/exec`,
        { cmd: execCmd.trim() },
      );
      setExecOutput(res?.output || '');
      setExecExitCode(res?.exitCode ?? null);
    } catch (e: any) {
      // 容器未运行等后端口径错误，统一 toast 提示
      showToast(t('执行失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setExecuting(false);
    }
  }

  return (
    <Modal
      open
      title={t('执行命令')}
      onClose={() => !executing && onClose()}
      width={640}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={executing}>
            {t('关闭')}
          </Button>
          <Button variant="primary" size="md" loading={executing} onClick={submitExec}>
            {t('执行')}
          </Button>
        </div>
      }
    >
      <Input
        placeholder={t('如 ls -la /app 或 cat /etc/hostname')}
        value={execCmd}
        onChange={(e) => setExecCmd(e.target.value)}
        autoFocus
        disabled={executing}
      />
      {execOutput && (
        <pre className="histlog__content">{execOutput}</pre>
      )}
      {execExitCode !== null && (
        <div className="env-modal__tip">{t('退出码：{{code}}', { code: execExitCode })}</div>
      )}
    </Modal>
  );
}
