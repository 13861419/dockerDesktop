/**
 * Docker Bench 安全基线扫描页
 *
 * 一键执行 CIS 风格的主机 / 守护进程 / 镜像 / 容器运行时检查，
 * 展示等级化报告（通过 / 提示 / 警告 / 高危）与加固建议，支持历史报告回看。
 * 与「安全基线」页（容器维度规则 + 在线修复）互补。
 */
import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../api/client';
import Button from '../components/Button';
import Card from '../components/Card';
import Empty from '../components/Empty';
import LineChart from '../components/LineChart';
import { useToast } from '../components/Toast';
import { translateNow as t } from '../i18n';
import './securityBench.less';

/** 检查等级 */
type Level = 'pass' | 'warn' | 'fail' | 'info' | 'skip';

/** 单条检查项（后端 BenchCheck） */
interface BenchCheck {
  id: string;
  category: 'host' | 'daemon' | 'images' | 'containers';
  level: Level;
  title: string;
  desc: string;
  remediation: string;
  targets?: string[];
}

/** 完整报告 */
interface BenchReport {
  id?: number;
  empty?: boolean;
  startedAt: number;
  durationMs: number;
  summary: Record<Level, number>;
  checks: BenchCheck[];
  /** 容器逃逸风险评分（1.34.0） */
  escapeRisk?: { maxScore: number; items: Array<{ name: string; score: number; reasons: string[] }> };
}

/** 历史记录摘要 */
interface BenchHistoryItem {
  id: number;
  started_at: number;
  duration_ms: number;
  pass: number;
  warn: number;
  fail: number;
  info: number;
  skip: number;
}

/** 趋势点（最近 30 次扫描） */
interface BenchTrendItem {
  id: number;
  startedAt: number;
  pass: number;
  warn: number;
  fail: number;
  maxRisk: number;
}

/** 分类显示名与顺序 */
const CATEGORY_LABEL: Record<BenchCheck['category'], string> = {
  daemon: 'Docker 守护进程',
  host: '宿主机',
  images: '镜像',
  containers: '容器运行时',
};

/** 等级徽标文案 */
const LEVEL_LABEL: Record<Level, string> = {
  pass: '通过',
  warn: '建议',
  fail: '高危',
  info: '提示',
  skip: '不适用',
};

/** 格式化时间（MM-DD HH:mm） */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function SecurityBenchPage() {
  const { showToast } = useToast();
  const [report, setReport] = useState<BenchReport | null>(null);
  const [history, setHistory] = useState<BenchHistoryItem[]>([]);
  const [running, setRunning] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [trend, setTrend] = useState<BenchTrendItem[]>([]);

  /** 拉取最近一次报告与历史摘要（附当前用户角色判断运行权限） */
  const load = useCallback(async () => {
    try {
      const [latest, hist, me, tr] = await Promise.all([
        get<BenchReport>('/api/bench/latest'),
        get<{ items: BenchHistoryItem[] }>('/api/bench/history'),
        get<{ username: string; role: string }>('/api/auth/me').catch(() => null),
        get<{ items: BenchTrendItem[] }>('/api/bench/trend').catch(() => ({ items: [] })),
      ]);
      setReport(latest.empty ? null : latest);
      setHistory(hist.items || []);
      setAdmin(me?.role === 'admin');
      setTrend(tr.items || []);
    } catch {
      // 首次加载失败静默（后端未就绪等）
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 执行扫描 */
  const runScan = async () => {
    setRunning(true);
    try {
      const r = await post<BenchReport>('/api/bench/run');
      setReport(r);
      const hist = await get<{ items: BenchHistoryItem[] }>('/api/bench/history');
      setHistory(hist.items || []);
      showToast(t('扫描完成'), 'success');
    } catch (e) {
      showToast((e as Error)?.message || t('扫描失败'), 'error');
    } finally {
      setRunning(false);
    }
  };

  /** 回看指定历史报告 */
  const viewHistory = async (id: number) => {
    if (!id) return;
    try {
      const r = await get<BenchReport>(`/api/bench/${id}`);
      setReport(r);
    } catch {
      showToast(t('读取历史报告失败'), 'error');
    }
  };

  /** 按分类分组（保持固定顺序） */
  const grouped = report
    ? (Object.keys(CATEGORY_LABEL) as Array<BenchCheck['category']>).map((cat) => ({
        category: cat,
        checks: report.checks.filter((c) => c.category === cat),
      }))
    : [];

  return (
    <div className="bench-page">
      <div className="bench-page__toolbar">
        <div>
          <h1 className="bench-page__title">{t('安全基线扫描')}</h1>
          <span className="bench-page__hint">
            {t('CIS 风格检查：守护进程配置、宿主机文件权限、镜像与容器运行时；与「安全基线」页（容器违规修复）互补')}
          </span>
        </div>
        <div className="bench-page__actions">
          {history.length > 0 && (
            <select
              className="input bench-page__history"
              value=""
              onChange={(e) => void viewHistory(Number(e.target.value))}
            >
              <option value="">{t('历史报告')}</option>
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {fmtTime(h.started_at)} · {t('通过')} {h.pass} / {t('警告')} {h.warn} / {t('高危')} {h.fail}
                </option>
              ))}
            </select>
          )}
          {admin && (
            <Button variant="primary" loading={running} onClick={() => void runScan()}>
              {running ? t('扫描中…') : t('运行扫描')}
            </Button>
          )}
        </div>
      </div>

      {!report ? (
        <Empty title={t('尚未执行过扫描')} description={admin ? t('点击「运行扫描」开始首次安全体检') : t('请联系管理员执行首次扫描')} />
      ) : (
        <>
          <div className="bench-page__summary">
            <div className="bench-stat bench-stat--pass">
              <div className="bench-stat__value">{report.summary.pass}</div>
              <div className="bench-stat__label">{t('通过')}</div>
            </div>
            <div className="bench-stat bench-stat--info">
              <div className="bench-stat__value">{report.summary.info}</div>
              <div className="bench-stat__label">{t('提示')}</div>
            </div>
            <div className="bench-stat bench-stat--warn">
              <div className="bench-stat__value">{report.summary.warn}</div>
              <div className="bench-stat__label">{t('建议加固')}</div>
            </div>
            <div className="bench-stat bench-stat--fail">
              <div className="bench-stat__value">{report.summary.fail}</div>
              <div className="bench-stat__label">{t('高危')}</div>
            </div>
            <div className="bench-page__meta">
              {t('扫描于 {{time}}，耗时 {{ms}} ms', { time: fmtTime(report.startedAt), ms: report.durationMs })}
            </div>
          </div>

          {/* 容器逃逸风险 Top（1.34.0） */}
          {report.escapeRisk && report.escapeRisk.items.length > 0 && (
            <Card title={t('容器逃逸风险 Top（评分越高越危险）')} className="bench-group">
              <div className="bench-risk">
                {report.escapeRisk.items.map((r) => (
                  <div key={r.name} className="bench-risk__row">
                    <span className="bench-risk__name">{r.name}</span>
                    <span className="bench-risk__bar">
                      <span className="bench-risk__fill" style={{ width: `${Math.min(100, r.score)}%` }} />
                    </span>
                    <span className="bench-risk__score">{r.score}</span>
                    <span className="bench-risk__reasons">{r.reasons.join(' · ')}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 检查结果 / 逃逸风险趋势（1.34.0） */}
          {trend.length > 1 && (
            <Card title={t('扫描趋势（最近 {{n}} 次）', { n: trend.length })} className="bench-group">
              <LineChart
                series={[
                  { name: t('高危'), color: '#ef4444', data: trend.map((x) => x.fail) },
                  { name: t('建议加固'), color: '#f59e0b', data: trend.map((x) => x.warn) },
                  { name: t('逃逸风险峰值'), color: '#6366f1', data: trend.map((x) => x.maxRisk) },
                ]}
                labels={trend.map((x) => fmtTime(x.startedAt).slice(0, 5))}
                height={160}
                unit=""
              />
            </Card>
          )}

          {grouped.map((g) => (
            <Card key={g.category} title={t(CATEGORY_LABEL[g.category])} className="bench-group">
              <div className="bench-list">
                {g.checks.map((c) => (
                  <div key={c.id} className={`bench-check bench-check--${c.level}`}>
                    <span className={`bench-check__badge bench-check__badge--${c.level}`}>{t(LEVEL_LABEL[c.level])}</span>
                    <div className="bench-check__body">
                      <div className="bench-check__title">{t(c.title)}</div>
                      <div className="bench-check__desc">{c.desc}</div>
                      {c.targets && c.targets.length > 0 && (
                        <div className="bench-check__targets">
                          {c.targets.map((x, i) => (
                            <span key={i} className="bench-check__target">
                              {x}
                            </span>
                          ))}
                        </div>
                      )}
                      {c.level !== 'pass' && c.level !== 'skip' && (
                        <div className="bench-check__remediation">{t('建议')}: {c.remediation}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
