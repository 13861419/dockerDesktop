import { useCallback, useEffect, useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import { Field, Input } from './Form';
import Empty from './Empty';
import { SkeletonRows } from './Loading';
import { useToast } from './Toast';
import { get, post } from '../api/client';
import YamlEditor from './YamlEditor';
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
  // 全屏编辑模式：弹窗占满视口、编辑器拉高
  const [fullscreen, setFullscreen] = useState(false);
  // AI 审查：加载中与结果文本
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState('');

  const loadCandidates = useCallback(async () => {
    try {
      const data = await get<{ candidates: ComposeInferCandidate[] }>('/api/compose/infer');
      setCandidates(data.candidates || []);
    } catch (e: any) {
      showToast(e?.message || '加载可逆向容器失败', 'error');
    }
  }, [showToast]);

  useEffect(() => {
    if (!open) {
      setFullscreen(false);
      return;
    }
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

  /** AI 审查当前 YAML：解释结构、指出问题并给出优化建议 */
  const aiReview = useCallback(async () => {
    if (!content.trim() || aiBusy) return;
    setAiBusy(true);
    setAiResult('');
    try {
      const res = await post<{ reply?: string }>('/api/ai/chat', {
        messages: [
          {
            role: 'user',
            content:
              '以下是由 docker run / 容器逆向生成的 docker compose YAML。请用中文简洁地：1) 逐服务解释其结构与作用；2) 指出潜在问题（安全、网络、卷、资源限制等）；3) 给出可直接落地的优化建议。不要整份重写 YAML。\n\n' +
              content,
          },
        ],
      });
      setAiResult(res?.reply || '（AI 未返回内容）');
    } catch (e: any) {
      showToast(e?.message || 'AI 审查失败', 'error');
    } finally {
      setAiBusy(false);
    }
  }, [content, aiBusy, showToast]);

  return (
    <Modal open={open} title="生成 Compose" onClose={onClose} width={fullscreen ? window.innerWidth - 32 : 720}>
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
            <YamlEditor value={content} onChange={setContent} rows={fullscreen ? 40 : 16} />
          </Field>
          {aiBusy && <SkeletonRows rows={3} />}
          {aiResult && (
            <div className="infer-modal__ai-result">
              <div className="infer-modal__ai-title">AI 审查建议</div>
              <pre>{aiResult}</pre>
            </div>
          )}
          <div className="infer-modal__actions">
            <Button variant="ghost" size="sm" disabled={aiBusy || !content.trim()} loading={aiBusy} onClick={aiReview}>
              AI 审查优化
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFullscreen((f) => !f)}>
              {fullscreen ? '退出全屏' : '全屏编辑'}
            </Button>
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
