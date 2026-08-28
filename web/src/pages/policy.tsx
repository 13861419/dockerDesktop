/**
 * 安全基线页面（一期：只读扫描报告）
 *
 * 对全部存量容器执行安全基线规则检查，展示：
 * - 摘要统计（扫描容器数 / 合规数 / 按严重度违规数）
 * - 违规明细（按容器分行，展开显示命中规则与加固建议）
 * - 规则清单（每条基线规则的说明）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Card from '../components/Card';
import Button from '../components/Button';
import Empty from '../components/Empty';
import { SkeletonRows } from '../components/Loading';
import { useToast } from '../components/Toast';
import { get, post } from '../api/client';
import './policy.less';

/** 违规严重度 */
type Severity = 'danger' | 'warn' | 'info';

/** 规则定义（/api/policy/scan 返回） */
interface PolicyRule {
  id: string;
  name: string;
  severity: Severity;
  description: string;
  advice: string;
  /** 是否支持在线自动修复 */
  fixable?: boolean;
}

/** 扫描报告 */
interface PolicyScanReport {
  scannedAt: number;
  containerCount: number;
  passCount: number;
  rules: PolicyRule[];
  rows: Array<{
    containerId: string;
    containerName: string;
    image: string;
    state: string;
    violations: Array<{ ruleId: string; detail: string }>;
  }>;
  summary: Record<Severity, number>;
}

/** 严重度中文名与配色类 */
const SEVERITY_LABEL: Record<Severity, string> = { danger: '严重', warn: '警告', info: '提示' };

/** 安全基线页面入口 */
export default function Policy() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<PolicyScanReport | null>(null);
  /** 规则 ID -> 规则定义 */
  const ruleMap = useMemo(() => new Map((report?.rules || []).map((r) => [r.id, r])), [report]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await get<PolicyScanReport>('/api/policy/scan');
      setReport(resp);
    } catch (e: any) {
      showToast(e?.message || '安全基线扫描失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
  }, [load]);

  /** 仅显示违规的容器行 */
  const violatingRows = useMemo(() => (report?.rows || []).filter((r) => r.violations.length > 0), [report]);

  /** 修复中的违规项（`${containerId}:${ruleId}`），用于按钮禁用 */
  const [fixing, setFixing] = useState<Set<string>>(new Set());

  /** 在线修复单条违规（审批流开启且非管理员时后端返回 202 转审批） */
  async function fix(row: { containerId: string; containerName: string }, ruleId: string) {
    const key = `${row.containerId}:${ruleId}`;
    setFixing((prev) => new Set(prev).add(key));
    try {
      const r = await post<{ ok: boolean; message: string; approvalPending?: boolean; approvalId?: number }>(
        '/api/policy/fix',
        { containerId: row.containerId, ruleId },
      );
      if (r.approvalPending) {
        showToast('已提交修复审批，批准后自动执行', 'info');
      } else {
        showToast(r.message, r.ok ? 'success' : 'error');
      }
      await load();
    } catch (e: any) {
      showToast(e?.message || '修复失败', 'error');
    } finally {
      setFixing((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <div className="policy-page">
      <div className="policy-page__toolbar">
        <Button variant="secondary" size="sm" onClick={load} loading={loading}>
          重新扫描
        </Button>
        <span className="policy-page__hint">内存 / CPU / 重启策略违规支持在线一键修复，其余需重建容器</span>
      </div>

      {loading && !report ? (
        <Card title="安全基线报告">
          <SkeletonRows rows={4} />
        </Card>
      ) : !report ? (
        <Empty kind="error" title="扫描失败" description="无法获取安全基线报告" />
      ) : (
        <>
          {/* 摘要 */}
          <div className="policy-page__summary">
            <div className="policy-stat">
              <div className="policy-stat__value">{report.containerCount}</div>
              <div className="policy-stat__label">扫描容器</div>
            </div>
            <div className="policy-stat policy-stat--ok">
              <div className="policy-stat__value">{report.passCount}</div>
              <div className="policy-stat__label">完全合规</div>
            </div>
            <div className={`policy-stat ${report.summary.danger > 0 ? 'policy-stat--bad' : ''}`}>
              <div className="policy-stat__value">{report.summary.danger}</div>
              <div className="policy-stat__label">严重违规</div>
            </div>
            <div className="policy-stat">
              <div className="policy-stat__value">{report.summary.warn}</div>
              <div className="policy-stat__label">警告</div>
            </div>
            <div className="policy-stat">
              <div className="policy-stat__value">{report.summary.info}</div>
              <div className="policy-stat__label">提示</div>
            </div>
          </div>

          {/* 违规明细 */}
          <Card title={`违规明细（${violatingRows.length}）`}>
            {violatingRows.length === 0 ? (
              <Empty kind="empty" title="全部容器均符合安全基线" />
            ) : (
              <table className="policy-table">
                <thead>
                  <tr>
                    <th style={{ width: '18%' }}>容器</th>
                    <th style={{ width: '22%' }}>镜像</th>
                    <th style={{ width: '12%' }}>状态</th>
                    <th>违规项</th>
                  </tr>
                </thead>
                <tbody>
                  {violatingRows.map((row) => (
                    <tr key={row.containerId}>
                      <td className="policy-table__name">{row.containerName}</td>
                      <td className="policy-table__img" title={row.image}>
                        {row.image}
                      </td>
                      <td>{row.state}</td>
                      <td>
                        <div className="policy-violations">
                          {row.violations.map((v, i) => {
                            const rule = ruleMap.get(v.ruleId);
                            const fixKey = `${row.containerId}:${v.ruleId}`;
                            return (
                              <div key={i} className={`policy-violation policy-violation--${v.ruleId === 'no-privileged' || v.ruleId === 'no-sensitive-mount' ? 'danger' : rule?.severity || 'info'}`}>
                                <span className="policy-violation__badge">{SEVERITY_LABEL[rule?.severity || 'info']}</span>
                                <span className="policy-violation__name">{rule?.name || v.ruleId}</span>
                                <span className="policy-violation__detail" title={rule?.advice}>
                                  {v.detail}
                                  {rule?.advice ? ` · 建议：${rule.advice}` : ''}
                                </span>
                                {rule?.fixable && (
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    loading={fixing.has(fixKey)}
                                    onClick={() => fix(row, v.ruleId)}
                                  >
                                    一键修复
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* 规则清单 */}
          <Card title="基线规则清单">
            <table className="policy-table">
              <thead>
                <tr>
                  <th style={{ width: '14%' }}>严重度</th>
                  <th style={{ width: '18%' }}>规则</th>
                  <th style={{ width: '36%' }}>说明</th>
                  <th>加固建议</th>
                </tr>
              </thead>
              <tbody>
                {report.rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className={`policy-sev policy-sev--${r.severity}`}>{SEVERITY_LABEL[r.severity]}</span>
                    </td>
                    <td>{r.name}</td>
                    <td className="policy-table__desc">{r.description}</td>
                    <td className="policy-table__desc">{r.advice}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
