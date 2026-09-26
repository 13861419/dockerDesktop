/**
 * Compose 编辑项目弹窗
 *
 * 从 Compose 页抽出（1.92.0 重构）：挂载时拉取 compose 文件，
 * 支持多文件切换、YAML 校验回显、历史版本载入与"保存为模板"。
 * 条件渲染。
 */
import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import Button from './Button';
import Modal from './Modal';
import { Field, Input } from './Form';
import YamlEditor from './YamlEditor';
import ComposeHistoryModal from './ComposeHistoryModal';
import { useToast } from './Toast';
import { useCanManage } from '../hooks/useCanManage';
import { translateNow as t } from '../i18n';

interface ComposeEditModalProps {
  /** 项目名 */
  name: string;
  /** 项目已有 compose 文件列表（用于多文件切换初始态） */
  files: string[];
  onClose: () => void;
  /** 保存成功后通知调用方刷新列表 */
  onSaved: () => void;
  /** 模板保存成功后刷新页面级模板列表 */
  onTemplatesChanged: () => void;
}

/** 从后端校验错误信息中解析出错行号（返回 null 表示无法定位） */
function parseYamlLine(msg: string): number | null {
  const m = msg.match(/(?:line|第)\s*(\d+)/i) || msg.match(/:\s*(\d+)\n?/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export default function ComposeEditModal({
  name,
  files,
  onClose,
  onSaved,
  onTemplatesChanged,
}: ComposeEditModalProps) {
  const { showToast } = useToast();
  const canManage = useCanManage();
  const [editName, setEditName] = useState(name);
  const [editContent, setEditContent] = useState('');
  const [editFiles, setEditFiles] = useState<string[]>(files);
  const [editFile, setEditFile] = useState('');
  // 编辑 YAML 校验错误（保存被拒绝时回显到编辑器）
  const [editYamlErr, setEditYamlErr] = useState<{ message: string; line: number | null }>({ message: '', line: null });
  const [editLoading, setEditLoading] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  // 编辑弹窗全屏（1.52.0）
  const [editFull, setEditFull] = useState(false);
  // compose 文件编辑历史（1.52.0）
  const [histOpen, setHistOpen] = useState(false);

  // 保存为模板弹窗状态
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveModalName, setSaveModalName] = useState('');
  const [saveModalDesc, setSaveModalDesc] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  // 挂载时拉取 compose 文件内容
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setEditLoading(true);
      setEditContent('');
      try {
        const res = await get<any>('/api/compose/' + encodeURIComponent(name) + '/file');
        const content = typeof res === 'string' ? res : res?.content || '';
        if (!cancelled) {
          setEditContent(content);
          if (Array.isArray(res?.files) && res.files.length > 1) {
            setEditFiles(res.files);
            setEditFile(res.composeFile || res.files[0] || '');
          }
        }
      } catch (e: any) {
        if (!cancelled) {
          setEditContent('');
          showToast(e?.message || t('获取 compose 文件失败'), 'error');
        }
      } finally {
        if (!cancelled) setEditLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  /** 多文件编排：切换编辑的目标文件（1.89.1） */
  async function switchEditFile(file: string) {
    if (!editName || !file) return;
    setEditLoading(true);
    setEditFile(file);
    try {
      const res = await get<any>('/api/compose/' + encodeURIComponent(editName) + '/file?file=' + encodeURIComponent(file));
      const content = typeof res === 'string' ? res : res?.content || '';
      setEditContent(content);
    } catch (e: any) {
      setEditContent('');
      showToast(e?.message || t('获取 compose 文件失败'), 'error');
    } finally {
      setEditLoading(false);
    }
  }

  /** 保存编辑后的 compose 文件（复用 POST /api/compose 同名覆盖端点） */
  async function handleSaveEdit() {
    if (!canManage) {
      showToast(t('仅管理员可编辑 Compose 项目'), 'error');
      onClose();
      return;
    }
    const pname = editName.trim();
    if (!pname) {
      showToast(t('项目名称无效'), 'error');
      return;
    }
    if (!editContent.trim()) {
      showToast(t('请输入 docker-compose.yml 内容'), 'error');
      return;
    }
    setSavingEdit(true);
    try {
      await post('/api/compose', { name: pname, content: editContent, file: editFile || undefined });
      showToast(t('项目修改已保存'));
      setEditYamlErr({ message: '', line: null });
      onClose();
      onSaved();
    } catch (e: any) {
      const msg = e?.message || t('保存失败');
      const line = parseYamlLine(msg);
      setEditYamlErr({ message: msg, line });
      showToast(line !== null ? t('Compose YAML 语法有误，请修正后保存') : msg, 'error');
    } finally {
      setSavingEdit(false);
    }
  }

  /** 打开"保存为模板"弹窗：用当前项目名作默认模板名，内容取当前编辑内容 */
  function openSaveTemplate() {
    if (!editContent.trim()) {
      showToast(t('内容为空，暂无法保存为模板'), 'error');
      return;
    }
    // 默认以项目名作为模板名，名称唯一由后端校验
    setSaveModalName(editName);
    setSaveModalDesc('');
    setSaveModalOpen(true);
  }

  /** 提交"保存为模板"：携带名称、描述与当前编辑内容写入模板库 */
  async function handleSaveTemplate() {
    if (!canManage) {
      showToast(t('仅管理员可保存模板'), 'error');
      setSaveModalOpen(false);
      return;
    }
    const tname = saveModalName.trim();
    if (!tname) {
      showToast(t('请输入模板名称'), 'error');
      return;
    }
    if (!editContent.trim()) {
      showToast(t('内容为空，暂无法保存为模板'), 'error');
      return;
    }
    setSavingTemplate(true);
    try {
      await post('/api/compose-templates', {
        name: tname,
        description: saveModalDesc.trim(),
        content: editContent,
      });
      showToast(t('模板保存成功'));
      setSaveModalOpen(false);
      setSaveModalName('');
      setSaveModalDesc('');
      // 重新拉取模板列表，使新模板立即出现在"从模板新建"下拉
      onTemplatesChanged();
    } catch (e: any) {
      showToast(e?.message || t('模板保存失败'), 'error');
    } finally {
      setSavingTemplate(false);
    }
  }

  return (
    <>
      <Modal
        open
        title={t('编辑 {{editName}} - docker-compose.yml', { editName })}
        onClose={onClose}
        width={720}
        fullscreen={editFull}
        onToggleFullscreen={() => setEditFull((f) => !f)}
        footer={
          <>
            {!editLoading && (
              <Button variant="ghost" onClick={() => setHistOpen(true)} disabled={savingEdit}>
                {t('历史版本')}
              </Button>
            )}
            {!editLoading && (
              <Button
                variant="secondary"
                onClick={openSaveTemplate}
                disabled={savingEdit || !canManage}
              >
                {t('保存为模板')}
              </Button>
            )}
            <Button variant="secondary" onClick={onClose} disabled={savingEdit}>
              {t('取消')}
            </Button>
            <Button onClick={handleSaveEdit} loading={savingEdit} disabled={!canManage}>
              {t('保存')}
            </Button>
          </>
        }
      >
        {editLoading ? (
          <div className="log-empty">{t('正在加载 compose 文件…')}</div>
        ) : (
          <Field label={editFiles.length > 1 ? t('目标文件') : 'docker-compose.yml'} required>
            {editFiles.length > 1 && (
              <div className="edit-file-switch">
                {editFiles.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`edit-file-switch__btn${editFile === f ? ' is-active' : ''}`}
                    onClick={() => switchEditFile(f)}
                  >
                    {f.split(/[\\/]/).pop()}
                  </button>
                ))}
              </div>
            )}
            <YamlEditor
              value={editContent}
              onChange={(v) => {
                setEditContent(v);
                if (editYamlErr.message) setEditYamlErr({ message: '', line: null });
              }}
              rows={editFull ? 40 : 18}
              errorLine={editYamlErr.line}
              errorMessage={editYamlErr.message || undefined}
            />
          </Field>
        )}
      </Modal>

      {/* 历史版本弹窗（1.52.0）：列表拉取与版本载入在 ComposeHistoryModal 内部 */}
      {histOpen && (
        <ComposeHistoryModal
          name={editName}
          onClose={() => setHistOpen(false)}
          onLoaded={(content) => {
            setEditContent(content);
            setHistOpen(false);
          }}
        />
      )}

      {/* 保存为模板弹窗 */}
      <Modal
        open={saveModalOpen}
        title={t('保存为模板')}
        onClose={() => setSaveModalOpen(false)}
        width={420}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setSaveModalOpen(false)}
              disabled={savingTemplate}
            >
              {t('取消')}
            </Button>
            <Button onClick={handleSaveTemplate} loading={savingTemplate} disabled={!canManage}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <Field label={t('模板名称')} required>
          <Input
            value={saveModalName}
            onChange={(e) => setSaveModalName(e.target.value)}
            placeholder={t('例如：WordPress')}
            autoFocus
          />
        </Field>
        <Field label={t('描述')}>
          <Input
            value={saveModalDesc}
            onChange={(e) => setSaveModalDesc(e.target.value)}
            placeholder={t('可选，记录模板用途')}
          />
        </Field>
      </Modal>
    </>
  );
}
