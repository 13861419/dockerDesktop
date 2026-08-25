import { useCallback, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import { Field, Input } from '../components/Form';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { post } from '../api/client';
import type { GcPolicy, GcPlanResponse, GcRunResult } from '../types';
import './gc.less';

export default function GcPage() {
  const { showToast } = useToast();

  const [keepPerRepo, setKeepPerRepo] = useState('');
  const [olderThanDays, setOlderThanDays] = useState('');
  const [pruneDangling, setPruneDangling] = useState(false);

  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<GcPlanResponse | null>(null);

  const [running, setRunning] = useState(false);
  const [runTarget, setRunTarget] = useState(false);
  const [runResult, setRunResult] = useState<GcRunResult | null>(null);

  const policy: GcPolicy = {
    keepPerRepo: keepPerRepo ? Number(keepPerRepo) : undefined,
    olderThanDays: olderThanDays ? Number(olderThanDays) : undefined,
    pruneDangling,
  };

  const buildBody = () => ({
    keepPerRepo: policy.keepPerRepo,
    olderThanDays: policy.olderThanDays,
    pruneDangling: policy.pruneDangling,
  });

  const planNow = useCallback(async () => {
    setPlanning(true);
    setRunResult(null);
    try {
      const data = await post<GcPlanResponse>('/api/gc/plan', buildBody());
      setPlan(data);
    } catch (e: any) {
      showToast(e?.message || '预演失败', 'error');
    } finally {
      setPlanning(false);
    }
  }, [keepPerRepo, olderThanDays, pruneDangling, showToast]);

  const run = useCallback(async () => {
    setRunTarget(false);
    setRunning(true);
    try {
      const data = await post<GcRunResult>('/api/gc/run', buildBody());
      setRunResult(data);
      showToast(`清理完成：删除 ${data.deleted.length} 个`, 'success');
      setPlan(null);
    } catch (e: any) {
      showToast(e?.message || '清理失败', 'error');
    } finally {
      setRunning(false);
    }
  }, [keepPerRepo, olderThanDays, pruneDangling, showToast]);

  const hasStrategy = !!(keepPerRepo || olderThanDays || pruneDangling);
  const canRun = plan && plan.candidates.length > 0 && !running;

  return (
    <div className="gc-page">
      <Card title="镜像 GC 策略清理">
        <div className="gc-page__form">
          <Field label="每仓库保留版本数" hint="每个镜像仓库保留最近 N 个标签，历史版本进入清理候选">
            <Input
              type="number"
              min={0}
              placeholder="如 2（留空=不启用）"
              value={keepPerRepo}
              onChange={(e: any) => setKeepPerRepo(e.target.value)}
            />
          </Field>
          <Field label="清理超过天数" hint="创建超过该天数且未被引用的镜像（含近期未拉取）">
            <Input
              type="number"
              min={0}
              placeholder="如 30（留空=不启用）"
              value={olderThanDays}
              onChange={(e: any) => setOlderThanDays(e.target.value)}
            />
          </Field>
          <Field label="悬空镜像" hint="清理无标签（悬空）镜像">
            <label className="gc-page__checkbox">
              <input
                type="checkbox"
                checked={pruneDangling}
                onChange={(e: any) => setPruneDangling(e.target.checked)}
              />
              <span>清理悬空镜像</span>
            </label>
          </Field>
          <div className="gc-page__actions">
            <Button variant="primary" loading={planning} disabled={!hasStrategy} onClick={planNow}>
              预演清理
            </Button>
          </div>
        </div>

        {plan && (
          <div className="gc-page__result">
            <div className="gc-page__summary">
              预演结果：将清理 <b>{plan.totals.toFree}</b> 个镜像（约 <b>{plan.totals.bytesText}</b>）
            </div>
            {plan.warnings.length > 0 && (
              <div className="gc-page__warnings">
                {plan.warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}

            {plan.candidates.length > 0 ? (
              <div className="gc-page__section">
                <div className="gc-page__section-title">可清理（{plan.candidates.length}）</div>
                {plan.candidates.map((c) => (
                  <div className="gc-page__row" key={c.id}>
                    <span className="gc-page__name">{c.repoTags[0] || c.id.slice(0, 12)}</span>
                    <span className="gc-page__reasons">{c.reasons.join('；')}</span>
                    <span className="gc-page__size">{(c.size / 1024 / 1024).toFixed(1)} MB</span>
                  </div>
                ))}
                <div className="gc-page__actions">
                  <Button variant="danger" loading={running} disabled={!canRun} onClick={() => setRunTarget(true)}>
                    确认清理
                  </Button>
                </div>
              </div>
            ) : (
              <Empty title="无可清理镜像" description="当前策略下没有镜像需要清理。" />
            )}

            {plan.keepers.length > 0 && (
              <div className="gc-page__section">
                <div className="gc-page__section-title">将保留（{plan.keepers.length}）</div>
                <div className="gc-page__scroll">
                  {plan.keepers.map((k) => (
                    <div className="gc-page__row" key={k.id}>
                      <span className="gc-page__name">{k.repoTags[0] || k.id.slice(0, 12)}</span>
                      <span className="gc-page__reasons">{k.usedByContainers ? '有容器引用' : '策略保留'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {plan.skipped.length > 0 && (
              <div className="gc-page__section">
                <div className="gc-page__section-title">安全跳过（{plan.skipped.length}）</div>
                <div className="gc-page__scroll">
                  {plan.skipped.map((s, i) => (
                    <div className="gc-page__row" key={i}>
                      <span className="gc-page__name">{s.name}</span>
                      <span className="gc-page__reasons">{s.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {running && <SkeletonRows rows={4} />}

        {runResult && (
          <div className="gc-page__run-result">
            <div>删除 {runResult.deleted.length} 个镜像，释放约 {(runResult.spaceReclaimed / 1024 / 1024).toFixed(1)} MB</div>
            <pre className="gc-page__detail">{runResult.detail}</pre>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={runTarget}
        title="确认清理镜像"
        message="此操作将删除预演中列出的镜像，且不可恢复。确认继续？"
        confirmText="确认清理"
        danger
        loading={running}
        onConfirm={run}
        onCancel={() => setRunTarget(false)}
      />
    </div>
  );
}
