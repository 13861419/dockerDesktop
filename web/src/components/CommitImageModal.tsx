/**
 * 提交为镜像弹窗（commit）
 *
 * 从容器详情页抽出（1.92.0 重构）：将容器当前文件系统状态打包成新镜像，
 * 以当前容器镜像名作为默认 repo 前缀。条件渲染。
 */
import { useState } from 'react';
import { post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface CommitImageModalProps {
  containerId: string;
  /** 当前容器镜像名（作为默认 repo 前缀） */
  currentImage: string;
  onClose: () => void;
}

export default function CommitImageModal({ containerId, currentImage, onClose }: CommitImageModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [commitRepo, setCommitRepo] = useState(currentImage || '');
  const [commitTag, setCommitTag] = useState('latest');
  const [commitComment, setCommitComment] = useState('');
  const [commitAuthor, setCommitAuthor] = useState('');
  const [committing, setCommitting] = useState(false);

  /**
   * 提交为镜像（确认后调用后端接口）
   */
  async function submitCommit() {
    // repo 必填校验
    if (!commitRepo.trim()) {
      showToast(t('请填写镜像仓库名 repo'), 'error');
      return;
    }
    setCommitting(true);
    try {
      const tag = commitTag.trim() || 'latest';
      const res = await post<any>(`/api/containers/${containerId}/commit`, {
        repo: commitRepo.trim(),
        tag,
        comment: commitComment.trim() || undefined,
        author: commitAuthor.trim() || undefined,
      });
      const image = res?.image || `${commitRepo.trim()}:${tag}`;
      showToast(t('已生成镜像 {{image}}', { image }));
      onClose();
    } catch (e: any) {
      showToast(t('提交失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setCommitting(false);
    }
  }

  return (
    <Modal
      open
      title={t('提交为镜像')}
      onClose={() => !committing && onClose()}
      width={520}
      footer={
        <div className="env-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={committing}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={committing} onClick={submitCommit}>
            {t('提交')}
          </Button>
        </div>
      }
    >
      <div className="env-modal__tip">
        {t('将容器当前的文件系统状态打包成一个新镜像（commit）。原容器不会被删除。')}
      </div>
      <Field label={t('仓库名 repo')} required hint={t('例如：myapp 或 registry.local/myapp')}>
        <Input
          placeholder={t('镜像仓库名')}
          value={commitRepo}
          onChange={(e) => setCommitRepo(e.target.value)}
          disabled={committing}
        />
      </Field>
      <Field label={t('标签 tag')} hint={t('默认 latest')}>
        <Input
          placeholder="latest"
          value={commitTag}
          onChange={(e) => setCommitTag(e.target.value)}
          disabled={committing}
        />
      </Field>
      <Field label={t('提交说明 comment')}>
        <Input
          placeholder={t('可选提交说明')}
          value={commitComment}
          onChange={(e) => setCommitComment(e.target.value)}
          disabled={committing}
        />
      </Field>
      <Field label={t('作者 author')}>
        <Input
          placeholder={t('可选作者')}
          value={commitAuthor}
          onChange={(e) => setCommitAuthor(e.target.value)}
          disabled={committing}
        />
      </Field>
    </Modal>
  );
}
