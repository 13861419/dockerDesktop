/**
 * 编辑镜像弹窗（替换容器使用的镜像）
 *
 * 从容器列表页抽出（1.92.0 重构）：可搜索下拉选择本地镜像或手动输入，
 * 提交后基于现有容器重建（仅替换镜像，其余配置保留）。条件渲染，成功后回调 onDone。
 */
import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import { canOperate } from '../api/auth';
import Button from './Button';
import Modal from './Modal';
import { Field, Input } from './Form';
import { useToast } from './Toast';
import { useLang } from '../i18n';

interface EditImageModalProps {
  target: { id: string; name: string; image: string } | null;
  onClose: () => void;
  /** 替换成功后通知调用方刷新列表与端口冲突映射 */
  onDone: () => void;
}

export default function EditImageModal({ target, onClose, onDone }: EditImageModalProps) {
  const { t } = useLang();
  const { showToast } = useToast();
  const [editImageValue, setEditImageValue] = useState('');
  const [editImageSaving, setEditImageSaving] = useState(false);
  // 可用镜像下拉选项（本地镜像标签列表）
  const [imageList, setImageList] = useState<string[]>([]);
  // 可搜索下拉：过滤关键字 与 面板展开状态
  const [editImageSearch, setEditImageSearch] = useState('');
  const [editImageDropdownOpen, setEditImageDropdownOpen] = useState(false);

  /**
   * 拉取本地镜像标签列表，用于"编辑镜像"弹窗的可选镜像下拉
   */
  async function loadImageOptions() {
    try {
      const res = await get<{ RepoTags?: string[] }[]>('/api/images');
      const tags = (res || [])
        .flatMap((img) => img.RepoTags || [])
        .filter((tag) => tag && !tag.startsWith('<none>'))
        .sort((a, b) => a.localeCompare(b));
      setImageList(tags);
    } catch {
      // 拉取镜像列表失败不阻塞，弹窗内仍可手动输入
      setImageList([]);
    }
  }

  // 打开（或切换目标）时预填当前镜像并刷新可选镜像列表
  useEffect(() => {
    if (!target) return;
    setEditImageValue(target.image);
    setEditImageSearch('');
    setEditImageDropdownOpen(false);
    setEditImageSaving(false);
    loadImageOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  /**
   * 按关键字过滤镜像下拉选项（不区分大小写）
   * @returns 过滤后的镜像列表
   */
  function filteredImageOptions(): string[] {
    const kw = editImageSearch.trim().toLowerCase();
    const base = imageList.includes(editImageValue) ? imageList : [editImageValue, ...imageList];
    const unique = Array.from(new Set(base)).filter(Boolean);
    if (!kw) return unique;
    return unique.filter((tag) => tag.toLowerCase().includes(kw));
  }

  /**
   * 从下拉列表中选择一个镜像：填入并以它作为当前选择，收起面板并清空过滤词
   * @param image 选中的镜像
   */
  function chooseEditImage(image: string) {
    setEditImageValue(image);
    setEditImageSearch('');
    setEditImageDropdownOpen(false);
  }

  /**
   * 提交替换镜像：基于现有容器重建，仅替换镜像，其余配置（端口、挂载、网络、环境变量等）保留
   */
  async function confirmEditImage() {
    if (!target) return;
    if (!canOperate()) {
      showToast(t('仅管理员可替换容器镜像'), 'error');
      onClose();
      return;
    }
    const newImage = editImageValue.trim();
    // 镜像必填校验
    if (!newImage) {
      showToast(t('请填写或选择新镜像'), 'error');
      return;
    }
    setEditImageSaving(true);
    try {
      await post(`/api/containers/${target.id}/recreate`, { image: newImage });
      showToast(t('已替换镜像为 {{newImage}}', { newImage }));
      onClose();
      onDone();
    } catch (e: any) {
      showToast(t('替换镜像失败：{{v1}}', { v1: e?.message || t('未知错误') }), 'error');
    } finally {
      setEditImageSaving(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title={t('编辑镜像')}
      onClose={() => !editImageSaving && onClose()}
      width={600}
      footer={
        <div className="create-modal__footer">
          <Button variant="ghost" size="md" onClick={onClose} disabled={editImageSaving}>
            {t('取消')}
          </Button>
          <Button variant="primary" size="md" loading={editImageSaving} onClick={confirmEditImage}>
            {t('替换镜像')}
          </Button>
        </div>
      }
    >
      <Field
        label={t('容器「{{v1}}」当前镜像', { v1: target?.name || '' })}
        hint={t('替换镜像将基于现有容器重建，仅替换镜像，端口、挂载、网络、环境变量等配置保留；重建会导致容器短暂中断，容器 ID 会改变。')}
      >
        <div className="edit-image__current" title={editImageValue}>
          {editImageValue || '-'}
        </div>
      </Field>
      <Field label={t('替换为以下镜像')} required>
        <div className="edit-image__picker">
          <Input
            className="edit-image__input"
            placeholder={t('输入关键字过滤或直接填写镜像名，如 nginx:latest')}
            value={editImageValue}
            onChange={(e) => {
              const v = e.target.value;
              setEditImageValue(v);
              setEditImageSearch(v);
              setEditImageDropdownOpen(true);
            }}
            onFocus={() => setEditImageDropdownOpen(true)}
            onBlur={() => setEditImageDropdownOpen(false)}
            disabled={editImageSaving}
          />
          {editImageDropdownOpen && (
            <div className="edit-image__dropdown">
              {filteredImageOptions().length === 0 ? (
                <div className="edit-image__dropdown-empty">{t('无匹配的本地镜像，可继续手动输入')}</div>
              ) : (
                filteredImageOptions().map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`edit-image__option ${tag === editImageValue ? 'edit-image__option--active' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseEditImage(tag)}
                  >
                    {tag}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </Field>
    </Modal>
  );
}
