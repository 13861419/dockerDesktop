import { useCallback, useEffect, useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import { Field, Input, TextArea } from './Form';
import Empty from './Empty';
import { SkeletonRows } from './Loading';
import { useToast } from './Toast';
import { get, post } from '../api/client';
import type { ComposeInferCandidate, ComposeInferResult } from '../types';
import './ComposeInferModal.less';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 初始容器 id 列表（可为空，为空时先让用户多选候选） */
  initialIds?: string[];
}

export default function ComposeInferModal({ open, onClose, initialIds = [] }: Props) {
  const { showToast } = useToast();
  const [candidates, setCandidates] = useState<ComposeInferCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [inferring, setInferring] = useState(false);
  const [result, setResult] = useState<ComposeInferResult | null>(null);
  const [content, setContent] = useState('');
  const [projectName, setProjectName] = useState('');
  const [saving, setSaving] = useState(false);

  const loadCandidates = useCallback(async () => {
    try {
      const data = await get<{ candidates: ComposeInferCandidate[] }>('/api/compose/infer');
      setCandidates(data.candidates || []);
    } catch (e: any) {
      showToast(e?.message || '加载可逆向容器失败', 'error');
    }
  }, [showToast]);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setContent('');
    setProjectName('');
    if (initialIds && initialIds.length > 0) {
      runInfer(initialIds);
    } else {
      setSelected([]);
      setLoading(true);
      loadCandidates().finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const runInfer = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      setInferring(true);
      try {
        const data = await post<ComposeInferResult>('/api/compose/infer', { containerIds: ids });
        setResult(data);
        setContent(data.content || '');
        setProjectName(data.projectName);
      } catch (e: any) {
        showToast(e?.message || '逆向失败', 'error');
      } finally {
        setInferring(false);
      }
    },
    [showToast],
  );

  const save = useCallback(async () => {
    if (!projectName.trim()) {
      showToast('请填写项目名', 'error');
      return;
    }
    setSaving(true);
    try {
      await post('/api/compose', { name: projectName, content });
      showToast('已保存为 Compose 工程，可在 Compose 页 ' + projectName + ' 启动', 'success');
      onClose();
    } catch (e: any) {
      showToast(e?.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [projectName, content, onClose, showToast]);

  return (
    <Modal open={open} title="生成 Compose" onClose={onClose} width={720}>
      {inferring ? (
        <SkeletonRows rows={8} />
      ) : result ? (
        <div className="infer-modal">
          <Field label="项目名" hint="保存后的 Compose 项目名">
            <Input value={projectName} onChange={(e: any) => setProjectName(e.target.value)} />
          </Field>
          <div className="infer-modal__services">
            {result.services.map((s) => (
              <span className="infer-modal__svc" key={s.name}>
                {s.name} · {s.image}
              </span>
            ))}
          </div>
          {result.warnings && result.warnings.length > 0 && (
            <div className="infer-modal__warnings">
              {result.warnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          )}
          {result.valid === false && result.validateError && (
            <div className="infer-modal__validate-error">YAML 校验未通过：{result.validateError}</div>
          )}
          <Field label="Compose 内容" hint="可编辑后再保存">
            <TextArea
              className="infer-modal__editor"
              value={content}
              onChange={(e: any) => setContent(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <div className="infer-modal__actions">
            <Button variant="secondary" size="sm" onClick={() => setResult(null)}>
              返回
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              保存为 Compose 工程
            </Button>
          </div>
        </div>
      ) : (
        <div className="infer-modal">
          {loading ? (
            <SkeletonRows rows={6} />
          ) : candidates.length === 0 ? (
            <Empty title="没有可逆向的容器" description="当前没有容器可供逆向生成 Compose。" />
          ) : (
            <>
              <div className="infer-modal__hint">选择要逆向的容器（可多选）：</div>
              <div className="infer-modal__list">
                {candidates.map((c) => (
                  <label className="infer-modal__item" key={c.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <span className="infer-modal__item-name">{c.name}</span>
                    <span className="infer-modal__item-img">{c.image}</span>
                    <span className="infer-modal__item-status">{c.status}</span>
                  </label>
                ))}
              </div>
              <div className="infer-modal__actions">
                <Button
                  variant="primary"
                  disabled={selected.length === 0}
                  onClick={() => runInfer(selected)}
                >
                  生成（已选 {selected.length}）
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
